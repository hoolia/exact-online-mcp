import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineTool, type ToolContext } from './types.js';
import { divisionField, guidField, isoDate, trimCode } from './common.js';
import { guid, str } from '../exact/odata.js';
import { ExactError } from '../exact/errors.js';
import { ENTRY_SELECT, entryShape, entryStatusName, findEntry } from './purchase.js';
import { DescriptionError, renderDescription } from '../policy/description.js';
import {
  cents, checkBalanced, checkGross, checkSign, checkLineSum, checkMatchBalanced, checkNoDuplicate, checkOneSide, checkVatCodes, checkVatTotal,
  failed, normaliseRef, vatOverrides, type Check, type VatCodeInfo,
} from '../policy/validators.js';
import { decideTier, type Tier } from '../policy/tiers.js';
import { checkApprovals, contractTier } from '../policy/approval.js';
import { DuplicateKeyError, type EntryKind, type LedgerRow, type PgStore } from '../db/ledger.js';

const STATUS_OPEN = 20;
const dryRun = z.boolean().default(true).describe('Default true: validates and returns the payload, the checks and the approval tier, writes nothing. Set false ONLY after the user confirmed.');
const writeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const compact = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const sha256Field = z.string().regex(/^[0-9a-f]{64}$/i, 'must be a hex SHA-256').transform((s) => s.toLowerCase());

const descriptionParts = z.object({
  supplier: z.string().min(1).max(60).describe('Supplier or counterparty name as it should read in the description.'),
  period: z.string().min(4).max(7).describe('Period the entry is about: YYYY-MM, YYYY-Qn or YYYY.'),
  ref: z.string().min(1).max(30).optional().describe('Reference as it should read in the description; omitted: your_ref (purchase) or reference (journal).'),
  short: z.string().min(1).max(60).describe('Short text: what the entry is for, e.g. "hosting".'),
}).describe('Parts of the entry description; the server renders the template (default {supplier}|{period}|{ref}|{short}) and validates it.');

const fileInput = z.object({
  file_name: z.string().min(1).max(200).regex(/\.(pdf|png|jpe?g|xml|tiff?)$/i, 'use a .pdf, .png, .jpg, .xml or .tif file name'),
  content_base64: z.string().min(4).optional().describe('File content, base64 encoded.'),
  file_url: z.string().url().optional().describe('https URL of the file instead of content_base64.'),
  document_type: z.number().int().positive().default(20).describe('Document type id for the new document (list_document_types); 20 = purchase invoice.'),
});

/** Approval inputs of process_entry and create_matchset, as the approval flow hands them over. */
const approvalFields = {
  answer: z.union([z.string().min(1).max(500), z.array(z.string().min(1).max(500)).min(1).max(2)]).optional()
    .describe("The approver's answer text exactly as given, e.g. \"ja, akkoord\"; two answers for two-step."),
  approvalToken: z.string().min(10).max(2000).optional().describe('Approval token issued for this draft.'),
  approval_tokens: z.array(z.string().min(10).max(2000)).max(2).default([]).describe('Approval tokens (two for two-step); combined with approvalToken.'),
};

function approvalInput(a: { answer?: string | string[]; approvalToken?: string; approval_tokens: string[] }) {
  const tokens = [...new Set([...(a.approvalToken ? [a.approvalToken] : []), ...a.approval_tokens])];
  const answers = a.answer === undefined ? [] : Array.isArray(a.answer) ? a.answer : [a.answer];
  return { tokens, answers };
}

/** The answer the accountant agent relays to the approver. */
const approvalContract = (draftId: string, tier: Tier, summary: string) => ({ approvalRequired: tier !== 'auto', draftId, summary, tier: contractTier(tier) });

const MIME: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', xml: 'application/xml', tif: 'image/tiff', tiff: 'image/tiff' };

function requireLedger(ctx: ToolContext): PgStore {
  if (!ctx.ledger) throw new ExactError('invalid_input', 'This tool needs the ledger database (DATABASE_URL), which is not configured.');
  return ctx.ledger;
}

async function fetchFile(ctx: ToolContext, url: string): Promise<Buffer> {
  let u: URL;
  try { u = new URL(url); } catch { throw new ExactError('invalid_input', 'file_url is not a valid URL.'); }
  if (u.protocol !== 'https:') throw new ExactError('invalid_input', 'file_url must be an https URL.');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30_000);
  try {
    const res = await fetch(u, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) throw new ExactError('invalid_input', `Could not download file_url (HTTP ${res.status}).`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > ctx.config.maxAttachmentBytes) throw new ExactError('invalid_input', 'The file is larger than the attachment limit.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > ctx.config.maxAttachmentBytes) throw new ExactError('invalid_input', 'The file is larger than the attachment limit.');
    return buf;
  } catch (e) {
    if (e instanceof ExactError) throw e;
    throw new ExactError('invalid_input', 'Could not download file_url.');
  } finally { clearTimeout(t); }
}

interface LoadedFile { name: string; bytes: Buffer; sha256: string; mime: string | undefined; documentType: number }

async function loadFile(ctx: ToolContext, f: z.infer<typeof fileInput>): Promise<LoadedFile> {
  if (!!f.content_base64 === !!f.file_url) throw new ExactError('invalid_input', 'Provide exactly one of content_base64 or file_url.');
  const bytes = f.content_base64 ? Buffer.from(f.content_base64, 'base64') : await fetchFile(ctx, f.file_url!);
  if (!bytes.length || bytes.length > ctx.config.maxAttachmentBytes) throw new ExactError('invalid_input', 'The file is empty or larger than the attachment limit.');
  const ext = f.file_name.split('.').pop()!.toLowerCase();
  if (ext === 'pdf' && bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ExactError('invalid_input', 'The content is not a PDF file.');
  return { name: f.file_name, bytes, sha256: sha256(bytes), mime: MIME[ext], documentType: f.document_type };
}

/** Creates a document with the file attached; returns the document GUID. */
async function uploadDocument(ctx: ToolContext, div: number, file: LoadedFile, doc: { subject: string; account?: string; date: string }): Promise<string> {
  const created: any = await ctx.exact.post('documents/Documents', compact({ Subject: doc.subject.slice(0, 200), Type: file.documentType, Account: doc.account, DocumentDate: doc.date }), { division: div });
  const id = created?.ID;
  if (!id) throw new ExactError('api', 'Exact Online created no document.');
  await ctx.exact.post('documents/DocumentAttachments', { Document: id, FileName: file.name, Attachment: file.bytes.toString('base64') }, { division: div });
  return id;
}

async function vatCodeTable(ctx: ToolContext, div: number): Promise<Map<string, VatCodeInfo>> {
  const { rows } = await ctx.exact.list('vat/VATCodes', { select: ['Code', 'Percentage', 'IsBlocked', 'VATTransactionType'] }, { division: div, maxRows: 500, maxPages: 10 });
  return new Map(rows.map((v: any) => [String(trimCode(v.Code)), { code: String(trimCode(v.Code)), percentage: Number(v.Percentage ?? 0), blocked: !!v.IsBlocked, use: v.VATTransactionType }]));
}

/** G/L accounts by GUID: code and whether it is a balance sheet account (BalanceType B). */
async function glAccounts(ctx: ToolContext, div: number, ids: string[]): Promise<Map<string, { code: string; balance: boolean }>> {
  const unique = [...new Set(ids.map((i) => i.toLowerCase()))];
  const out = new Map<string, { code: string; balance: boolean }>();
  for (let i = 0; i < unique.length; i += 15) {
    const chunk = unique.slice(i, i + 15);
    const { rows } = await ctx.exact.list('financial/GLAccounts', { select: ['ID', 'Code', 'BalanceType'], filter: chunk.map((g) => `ID eq ${guid(g)}`).join(' or ') }, { division: div, maxRows: 60, maxPages: 1 });
    for (const r of rows as any[]) out.set(String(r.ID).toLowerCase(), { code: String(trimCode(r.Code)), balance: r.BalanceType === 'B' });
  }
  return out;
}

function checkGlKnown(ids: string[], known: Map<string, unknown>): Check {
  const missing = [...new Set(ids.map((i) => i.toLowerCase()))].filter((i) => !known.has(i));
  return { name: 'gl_account_known', ok: !missing.length, message: missing.length ? `G/L account(s) ${missing.join(', ')} not found` : 'G/L accounts known' };
}

function describe(ctx: ToolContext, parts: { supplier: string; period: string; ref?: string; short: string }, ref: string): string {
  try {
    return renderDescription(ctx.config.descriptionTemplate, { supplier: parts.supplier, period: parts.period, short: parts.short, ref: parts.ref ?? ref }, ctx.config.descriptionMaxLength);
  } catch (e) {
    if (e instanceof DescriptionError) throw new ExactError('invalid_input', `Description: ${e.message}.`);
    throw e;
  }
}

const shapeDup = (r: LedgerRow) => ({ exact_entry_id: r.exactEntryId, entry_number: r.exactEntryNumber, status: r.status, entry_date: r.entryDate, amount: r.amountCents / 100 });

function refused(summary: string, data: Record<string, unknown>) {
  return { summary: `REFUSED: ${summary} Nothing was written.`, data: { refused: true, ...data } };
}

interface DraftPlan {
  kind: EntryKind;
  division: number;
  resource: string;
  body: Record<string, unknown>;
  ledgerKey: { supplierId: string | null; journal: string; refNorm: string; amountCents: number; entryDate: string; currency: string; pdfSha256: string | null };
  checks: Check[];
  tier: Tier;
  tierReasons: string[];
  duplicates: LedgerRow[];
  file: LoadedFile | null;
  document: { subject: string; account?: string; date: string };
  attachDocument: (body: Record<string, unknown>, documentId: string) => void;
  idField: string;
  /** one line for the approver: what is booked, how much */
  approvalSummary: string;
}

/** Shared tail of both draft tools: refuse, preview, or reserve the ledger key, write, and record the Exact GUID. */
async function executeDraft(ctx: ToolContext, tool: string, plan: DraftPlan, dry: boolean) {
  const ledger = requireLedger(ctx);
  const bad = failed(plan.checks);
  const preview = {
    division: plan.division, resource: plan.resource, tier: contractTier(plan.tier), tier_reasons: plan.tierReasons,
    checks: plan.checks, document: plan.file ? { file_name: plan.file.name, bytes: plan.file.bytes.length, sha256: plan.file.sha256 } : null,
  };
  if (plan.duplicates.length) {
    return refused(`this entry duplicates ${plan.duplicates.map((d) => d.exactEntryId ?? 'a reservation in progress').join(', ')}.`, { duplicate: true, existing: plan.duplicates.map(shapeDup), ...preview });
  }
  if (bad.length) return refused(`${bad.map((c) => c.message).join('; ')}.`, preview);
  if (dry) {
    return { summary: `DRY RUN (nothing was written in division ${plan.division}). All checks green, approval tier ${contractTier(plan.tier)}. Confirm with the user, then call again with dry_run=false.`, data: { dry_run: true, ...preview, payload: plan.body } };
  }
  const now = new Date(ctx.now());
  const holdUntil = plan.tier === 'auto' ? new Date(now.getTime() + ctx.config.tiers.autoHoldHours * 3_600_000) : null;
  let reservation: number;
  try {
    reservation = await ledger.reserve({
      division: plan.division, kind: plan.kind, ...plan.ledgerKey, tier: plan.tier, tierReasons: plan.tierReasons, createdBy: ctx.caller.id, createdAt: now, holdUntil,
    });
  } catch (e) {
    if (e instanceof DuplicateKeyError) {
      const existing = await ledger.findDuplicates({ division: plan.division, kind: plan.kind, ...plan.ledgerKey, windowDays: 0 });
      return refused(`this entry duplicates ${existing.map((d) => d.exactEntryId ?? 'a reservation in progress').join(', ') || 'an entry in the ledger'}.`, { duplicate: true, existing: existing.map(shapeDup) });
    }
    throw e;
  }
  let created: any;
  let documentId: string | null = null;
  try {
    if (plan.file) {
      documentId = await uploadDocument(ctx, plan.division, plan.file, plan.document);
      plan.attachDocument(plan.body, documentId);
    }
    created = await ctx.exact.post(plan.resource, plan.body, { division: plan.division });
    if (!created?.[plan.idField]) throw new ExactError('api', 'Exact Online returned no entry id.');
  } catch (e) {
    await ledger.release(reservation);
    if (e instanceof ExactError && documentId) throw new ExactError(e.kind, `${e.userMessage} Document ${documentId} was created without an entry.`, e.status);
    throw e;
  } finally {
    ctx.audit({ tool, division: plan.division, payloadHash: createHash('sha256').update(JSON.stringify(plan.body)).digest('hex'), exactId: created?.[plan.idField] ?? null });
  }
  await ledger.markDrafted(reservation, created[plan.idField], created.EntryNumber ?? null);
  const status = Number(created.Status);
  const warning = status === STATUS_OPEN ? null : `Exact reports status ${entryStatusName(status)} instead of open (20); check the journal settings in Exact.`;
  const draftId = String(created[plan.idField]).toLowerCase();
  return {
    summary: `Drafted entry ${created.EntryNumber ?? ''} in division ${plan.division}, status ${entryStatusName(status)}, approval tier ${contractTier(plan.tier)}${holdUntil ? ` (processable after ${holdUntil.toISOString()})` : ''}.${warning ? ` WARNING: ${warning}` : ''}`,
    data: {
      ...approvalContract(draftId, plan.tier, plan.approvalSummary),
      dry_run: false, division: plan.division, exact_entry_id: created[plan.idField], entry_number: created.EntryNumber ?? null, status: entryStatusName(status),
      status_warning: warning, tier_reasons: plan.tierReasons, hold_until: holdUntil?.toISOString() ?? null, document_id: documentId,
    },
  };
}

// --- draft_purchase_entry ---

const purchaseLine = z.object({
  gl_account_id: guidField('Cost or balance G/L account GUID (list_gl_accounts).'),
  amount: z.number().describe('Line amount EXCLUDING VAT, in the entry currency. Negative on a credit note.'),
  vat_code: z.string().min(1).max(8).describe('VAT code (list_vat_codes use=purchase).'),
  vat_amount: z.number().optional().describe('VAT of the line when it differs from amount times the code percentage (rounding on the invoice).'),
  description: z.string().max(60).optional().describe('Line text; omitted: the entry description.'),
  cost_center: z.string().max(8).optional(),
});

export const draftPurchaseEntry = defineTool({
  name: 'draft_purchase_entry',
  title: 'Draft purchase entry',
  description: 'Drafts a purchase entry (supplier invoice) that stays OPEN (Status 20) for review. Before writing, the server checks: lines add up to net, net + VAT = gross, VAT codes known, VAT matches the lines, G/L accounts known, and no duplicate in the idempotency ledger (same supplier and invoice number, same PDF, or same supplier and amount within the date window) or in Exact (same your_ref). The description is rendered from description parts. Returns the approval tier (auto, approve, two_step) that process_entry enforces. Optionally uploads the invoice file and links it. WRITES to Exact Online; dry_run first.',
  inputSchema: {
    supplier_id: guidField('Supplier account GUID (search_accounts kind=supplier).'),
    journal: z.string().min(1).max(10).describe('Purchase journal code (list_journals kind=purchase).'),
    your_ref: z.string().min(1).max(60).describe("The supplier's invoice number; also {ref} of the description."),
    entry_date: isoDate('Invoice date.'),
    due_date: isoDate('Due date; omitted: from the payment condition.').optional(),
    description: descriptionParts,
    currency: z.string().length(3).default('EUR').describe('ISO currency code of the invoice.'),
    totals: z.object({ net: z.number(), vat: z.number(), gross: z.number() }).describe('Invoice totals as printed: net (excl. VAT), VAT, gross. Negative on a credit note.'),
    payment_reference: z.string().max(50).optional().describe('Payment reference (betalingskenmerk) from the invoice.'),
    credit_note: z.boolean().default(false).describe('true: purchase credit note (Type 31).'),
    lines: z.array(purchaseLine).min(1).max(50),
    file: fileInput.optional().describe('The invoice file: uploaded as a document of the supplier and linked to the entry. Its SHA-256 joins the duplicate check.'),
    document_sha256: sha256Field.optional().describe('SHA-256 of the invoice PDF when the file is attached later with attach_document.'),
    division: divisionField, dry_run: dryRun,
  },
  annotations: writeAnnotations,
  async run(ctx, a) {
    const ledger = requireLedger(ctx);
    const div = await ctx.exact.resolveDivision(a.division);
    const description = describe(ctx, a.description, a.your_ref);
    const file = a.file ? await loadFile(ctx, a.file) : null;
    if (file && a.document_sha256 && file.sha256 !== a.document_sha256) throw new ExactError('invalid_input', 'document_sha256 does not match the file.');
    const pdfSha256 = file?.sha256 ?? a.document_sha256 ?? null;
    const [vat, gl] = await Promise.all([vatCodeTable(ctx, div), glAccounts(ctx, div, a.lines.map((l: any) => l.gl_account_id))]);
    const refNorm = normaliseRef(a.your_ref);
    const ledgerKey = { supplierId: a.supplier_id, journal: a.journal.trim(), refNorm, amountCents: cents(a.totals.gross), entryDate: a.entry_date, currency: a.currency.toUpperCase(), pdfSha256 };
    const duplicates = await ledger.findDuplicates({ division: div, kind: 'purchase', ...ledgerKey, windowDays: ctx.config.duplicateWindowDays });
    const { rows: exactDup } = await ctx.exact.list('purchaseentry/PurchaseEntries', { select: ENTRY_SELECT, filter: `Supplier eq ${guid(a.supplier_id)} and YourRef eq ${str(a.your_ref)}` }, { division: div, maxRows: 5, maxPages: 1 });
    if (exactDup.length) {
      return refused(`supplier invoice ${a.your_ref} is already booked in Exact as purchase entry ${exactDup[0].EntryNumber} (${entryStatusName(exactDup[0].Status)}).`, { duplicate: true, division: div, existing: exactDup.map(entryShape) });
    }
    const checks: Check[] = [
      checkLineSum(a.lines.map((l: any) => l.amount), a.totals.net),
      checkGross(a.totals.net, a.totals.vat, a.totals.gross),
      checkSign(a.totals.gross, a.credit_note),
      checkVatCodes(a.lines.map((l: any) => l.vat_code), vat, 'purchase'),
      checkVatTotal(a.lines, a.totals.vat, vat),
      checkGlKnown(a.lines.map((l: any) => l.gl_account_id), gl),
      checkNoDuplicate(duplicates),
    ];
    const supplierEntries = await ledger.supplierEntryCount(div, a.supplier_id);
    // offsetting lines (+10,000 and -9,900) must not rate as their small net
    const volume = a.lines.reduce((s: number, l: any) => s + Math.abs(l.amount), 0) + Math.abs(a.totals.vat);
    const mixedSigns = a.lines.some((l: any) => l.amount > 0) && a.lines.some((l: any) => l.amount < 0);
    const { tier, reasons } = decideTier({
      kind: 'purchase', amount: Math.max(Math.abs(a.totals.gross), volume), currency: ledgerKey.currency, journal: a.journal, supplierEntries, mixedSigns, vatOverrides: vatOverrides(a.lines, vat),
      balanceAccounts: a.lines.map((l: any) => gl.get(l.gl_account_id.toLowerCase())).filter((g: any) => g?.balance).map((g: any) => g.code),
      validatorsGreen: !failed(checks).length, duplicate: duplicates.length > 0,
    }, ctx.config.tiers);
    const body = compact({
      Journal: a.journal, Supplier: a.supplier_id, YourRef: a.your_ref, EntryDate: a.entry_date, DueDate: a.due_date, Description: description,
      Currency: ledgerKey.currency, PaymentReference: a.payment_reference, Type: a.credit_note ? 31 : 30,
      PurchaseEntryLines: a.lines.map((l: any) => compact({ GLAccount: l.gl_account_id, AmountFC: l.amount, VATCode: l.vat_code, VATAmountFC: l.vat_amount, Description: l.description ?? description, CostCenter: l.cost_center })),
    }) as Record<string, unknown>;
    return executeDraft(ctx, 'draft_purchase_entry', {
      kind: 'purchase', division: div, resource: 'purchaseentry/PurchaseEntries', body, ledgerKey, checks, tier, tierReasons: reasons, duplicates, file,
      document: { subject: description, account: a.supplier_id, date: a.entry_date },
      attachDocument: (b, id) => { b.Document = id; }, idField: 'EntryID',
      approvalSummary: `${a.credit_note ? 'Credit note' : 'Purchase invoice'} ${description}: ${ledgerKey.currency} ${a.totals.gross.toFixed(2)} incl. VAT ${a.totals.vat.toFixed(2)}`,
    }, a.dry_run);
  },
});

// --- draft_general_journal_entry ---

const journalLine = z.object({
  gl_account_id: guidField('G/L account GUID (list_gl_accounts).'),
  debit: z.number().positive().optional().describe('Debit amount (excl. VAT); give debit or credit.'),
  credit: z.number().positive().optional().describe('Credit amount (excl. VAT); give debit or credit.'),
  vat_code: z.string().min(1).max(8).optional().describe('VAT code, only when the journal has VAT enabled; VAT lines are added by Exact.'),
  vat_amount: z.number().min(0).optional().describe('VAT of the line (needed with vat_code for the balance check).'),
  account_id: guidField('Relation (account) GUID for the line.').optional(),
  cost_center: z.string().max(8).optional(),
  cost_unit: z.string().max(8).optional(),
  short: z.string().min(1).max(60).optional().describe('Line-specific {short} part of the description.'),
});

export const draftGeneralJournalEntry = defineTool({
  name: 'draft_general_journal_entry',
  title: 'Draft general journal entry',
  description: 'Drafts a general journal (memoriaal) entry that stays OPEN (Status 20) for review. Before writing, the server checks: each line has one side, debit equals credit (VAT included), VAT codes known, G/L accounts known, and no entry with the same journal and reference in the idempotency ledger. Line descriptions are rendered from description parts. Returns the approval tier (approve or two_step) that process_entry enforces. Optionally uploads a supporting file and links it to the lines. WRITES to Exact Online; dry_run first.',
  inputSchema: {
    journal: z.string().min(1).max(10).describe('General journal code (list_journals kind=general).'),
    entry_date: isoDate('Entry date.'),
    reference: z.string().min(1).max(30).describe('Your reference for this entry; unique per journal, also {ref} of the description.'),
    description: descriptionParts,
    currency: z.string().length(3).default('EUR'),
    financial_year: z.number().int().min(2000).max(2100).optional(),
    financial_period: z.number().int().min(1).max(13).optional(),
    reversal: z.boolean().default(false).describe('true: correction entry with negative amounts on the same side as the original.'),
    lines: z.array(journalLine).min(2).max(100),
    file: fileInput.optional().describe('Supporting file: uploaded as a document and linked to every line. Its SHA-256 joins the duplicate check.'),
    division: divisionField, dry_run: dryRun,
  },
  annotations: writeAnnotations,
  async run(ctx, a) {
    const ledger = requireLedger(ctx);
    const div = await ctx.exact.resolveDivision(a.division);
    const lineText = (l: any) => describe(ctx, { ...a.description, short: l.short ?? a.description.short }, a.reference);
    const descriptions = a.lines.map(lineText);
    const file = a.file ? await loadFile(ctx, a.file) : null;
    const vatCodes = a.lines.filter((l: any) => l.vat_code).map((l: any) => l.vat_code);
    const [vat, gl] = await Promise.all([vatCodes.length ? vatCodeTable(ctx, div) : Promise.resolve(new Map<string, VatCodeInfo>()), glAccounts(ctx, div, a.lines.map((l: any) => l.gl_account_id))]);
    const debit = a.lines.reduce((s: number, l: any) => s + (l.debit ?? 0) + (l.debit ? l.vat_amount ?? 0 : 0), 0);
    const ledgerKey = { supplierId: null, journal: a.journal.trim(), refNorm: normaliseRef(a.reference), amountCents: cents(debit), entryDate: a.entry_date, currency: a.currency.toUpperCase(), pdfSha256: file?.sha256 ?? null };
    const duplicates = await ledger.findDuplicates({ division: div, kind: 'general_journal', ...ledgerKey, windowDays: ctx.config.duplicateWindowDays });
    const missingVat = a.lines.map((l: any, i: number) => (l.vat_code && l.vat_amount === undefined ? i + 1 : 0)).filter(Boolean);
    const checks: Check[] = [
      checkOneSide(a.lines),
      checkBalanced(a.lines),
      { name: 'vat_amount_given', ok: !missingVat.length, message: missingVat.length ? `line(s) ${missingVat.join(', ')} have a VAT code but no vat_amount` : 'VAT amounts given' },
      checkVatCodes(vatCodes, vat, 'any'),
      checkGlKnown(a.lines.map((l: any) => l.gl_account_id), gl),
      checkNoDuplicate(duplicates),
    ];
    const { tier, reasons } = decideTier({
      kind: 'general_journal', amount: debit, currency: ledgerKey.currency, journal: a.journal, supplierEntries: 0,
      balanceAccounts: a.lines.map((l: any) => gl.get(l.gl_account_id.toLowerCase())).filter((g: any) => g?.balance).map((g: any) => g.code),
      validatorsGreen: !failed(checks).length, duplicate: duplicates.length > 0,
    }, ctx.config.tiers);
    const body = compact({
      JournalCode: a.journal, Currency: ledgerKey.currency, FinancialYear: a.financial_year, FinancialPeriod: a.financial_period, Reversal: a.reversal || undefined,
      GeneralJournalEntryLines: a.lines.map((l: any, i: number) => {
        const sign = l.debit ? 1 : -1;
        return compact({
          GLAccount: l.gl_account_id, AmountFC: l.debit ? l.debit : -l.credit, VATCode: l.vat_code, AmountVATFC: l.vat_code ? sign * (l.vat_amount ?? 0) : undefined,
          Description: descriptions[i], Date: a.entry_date, Account: l.account_id, CostCenter: l.cost_center, CostUnit: l.cost_unit,
        });
      }),
    }) as Record<string, unknown>;
    return executeDraft(ctx, 'draft_general_journal_entry', {
      kind: 'general_journal', division: div, resource: 'generaljournalentry/GeneralJournalEntries', body, ledgerKey, checks, tier, tierReasons: reasons, duplicates, file,
      document: { subject: descriptions[0]!, date: a.entry_date },
      attachDocument: (b, id) => { for (const l of b.GeneralJournalEntryLines as any[]) l.Document = id; }, idField: 'EntryID',
      approvalSummary: `Journal ${a.journal} ${descriptions[0]}: ${ledgerKey.currency} ${debit.toFixed(2)} debit = credit, ${a.lines.length} lines`,
    }, a.dry_run);
  },
});

// --- attach_document ---

export const attachDocument = defineTool({
  name: 'attach_document',
  title: 'Attach document to purchase entry',
  description: 'Attaches a file (the supplier invoice PDF) to a purchase entry: adds it to the document already linked to the entry, or creates a document for the supplier and links it. Refuses a file whose SHA-256 the ledger already holds for another entry, or that differs from the document_sha256 given at draft time. Give the file as content_base64 or an https file_url. WRITES to Exact Online; dry_run first.',
  inputSchema: {
    entry_id: guidField('Purchase entry GUID (from draft_purchase_entry or list_purchase_entries).'),
    file_name: fileInput.shape.file_name,
    content_base64: fileInput.shape.content_base64,
    file_url: fileInput.shape.file_url,
    subject: z.string().min(1).max(200).optional().describe('Document subject; omitted: the entry description.'),
    document_type: fileInput.shape.document_type,
    division: divisionField, dry_run: dryRun,
  },
  annotations: writeAnnotations,
  async run(ctx, a) {
    const ledger = requireLedger(ctx);
    const div = await ctx.exact.resolveDivision(a.division);
    const file = await loadFile(ctx, { file_name: a.file_name, content_base64: a.content_base64, file_url: a.file_url, document_type: a.document_type });
    const e: any = await findEntry(ctx, { entry_id: a.entry_id, division: div });
    if (!e) throw new ExactError('invalid_input', 'Purchase entry not found.');
    const row = await ledger.getByExactId(div, e.EntryID);
    const others = (await ledger.findByPdf(div, file.sha256)).filter((r) => r.exactEntryId !== String(e.EntryID).toLowerCase());
    if (others.length) return refused(`this file is already attached to ${others.map((o) => o.exactEntryId).join(', ')}.`, { duplicate: true, existing: others.map(shapeDup) });
    if (row?.pdfSha256 && row.pdfSha256 !== file.sha256) return refused('the entry was drafted for a different file (document_sha256).', { expected_sha256: row.pdfSha256, sha256: file.sha256 });
    const plan = {
      entry: { id: e.EntryID, entry_number: e.EntryNumber, supplier_name: e.SupplierName, your_ref: e.YourRef, status: entryStatusName(e.Status) },
      document: e.Document ? { existing: e.Document } : { create: { subject: a.subject ?? e.Description ?? `${e.SupplierName ?? 'Supplier'} ${e.YourRef ?? e.EntryNumber}` } },
      attachment: { file_name: file.name, bytes: file.bytes.length, mime: file.mime, sha256: file.sha256 },
    };
    if (a.dry_run) {
      return { summary: `DRY RUN (nothing was changed in division ${div}). ${file.name} (${file.bytes.length} bytes) to purchase entry ${e.EntryNumber}${e.Document ? ' (added to its existing document)' : ' (new document)'}. Confirm with the user, then call again with dry_run=false.`, data: { dry_run: true, division: div, ...plan } };
    }
    let docId: string | null = e.Document ?? null;
    let attId: string | null = null;
    let linked = !!e.Document;
    try {
      if (!docId) {
        docId = await uploadDocument(ctx, div, file, { subject: plan.document.create!.subject, account: e.Supplier, date: e.EntryDate?.slice(0, 10) });
      } else {
        const att: any = await ctx.exact.post('documents/DocumentAttachments', { Document: docId, FileName: file.name, Attachment: file.bytes.toString('base64') }, { division: div });
        attId = att?.ID ?? null;
      }
      if (row) await ledger.setPdf(row.id, file.sha256);
      if (!linked) {
        try {
          await ctx.exact.put(`purchaseentry/PurchaseEntries(${guid(e.EntryID)})`, { Document: docId }, { division: div });
          linked = true;
        } catch (err) {
          const msg = err instanceof ExactError ? err.userMessage : 'unknown error';
          return { summary: `Created document ${docId} with ${file.name}, but could not link it to purchase entry ${e.EntryNumber}: ${msg}`, data: { dry_run: false, division: div, document_id: docId, attachment_id: attId, linked: false } };
        }
      }
    } finally {
      ctx.audit({ tool: 'attach_document', division: div, payloadHash: file.sha256, exactId: docId });
    }
    return { summary: `Attached ${file.name} to purchase entry ${e.EntryNumber} (document ${docId}).`, data: { dry_run: false, division: div, entry_id: e.EntryID, document_id: docId, attachment_id: attId, linked, sha256: file.sha256 } };
  },
});

// --- process_entry ---

export const processEntry = defineTool({
  name: 'process_entry',
  title: 'Process (release) a drafted entry',
  description: 'Releases an entry this server drafted, after enforcing its approval tier: auto entries after their hold time without approval; approve entries with the approver\'s answer and one approval token; two-step entries with two answers and two tokens from different approvers. Give the draftId the draft tool returned, the answer text exactly as the approver gave it, and the token(s) the approval flow issued. The drafter cannot approve their own entry. The entry must still be open (Status 20) in Exact. WRITES.',
  inputSchema: {
    draftId: guidField('draftId returned by draft_purchase_entry or draft_general_journal_entry.').optional(),
    entry_id: guidField('Same as draftId (Exact entry GUID).').optional(),
    ...approvalFields,
    division: divisionField,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async run(ctx, a) {
    const ledger = requireLedger(ctx);
    const entryId: string | undefined = a.draftId ?? a.entry_id;
    if (!entryId) throw new ExactError('invalid_input', 'Provide draftId.');
    if (a.draftId && a.entry_id && a.draftId.toLowerCase() !== a.entry_id.toLowerCase()) throw new ExactError('invalid_input', 'draftId and entry_id differ.');
    a.entry_id = entryId;
    const div = await ctx.exact.resolveDivision(a.division);
    const row = await ledger.getByExactId(div, a.entry_id);
    if (!row) return refused('this entry was not drafted by this server, so it has no approval tier.', { entry_id: a.entry_id });
    if (row.status !== 'drafted') return refused(`the entry is already ${row.status}.`, { entry_id: a.entry_id, status: row.status, approved_by: row.approvedBy });
    const nowMs = ctx.now();
    const tier = row.tier as Tier;
    if (tier === 'auto' && row.holdUntil && Date.parse(row.holdUntil) > nowMs) {
      return refused(`automatic entries are held until ${row.holdUntil}.`, { entry_id: a.entry_id, tier: contractTier(tier), hold_until: row.holdUntil });
    }
    let approvers: string[] = [];
    if (tier !== 'auto') {
      if (!ctx.config.approvalSigningKey) return refused('approval tokens cannot be checked: APPROVAL_SIGNING_KEY is not configured.', { entry_id: a.entry_id, tier: contractTier(tier) });
      const { tokens, answers } = approvalInput(a);
      const check = checkApprovals(ctx.config.approvalSigningKey, tokens, { entry: row.exactEntryId!, tier, drafter: row.createdBy, nowMs, answers, answerPolicy: ctx.config.answerPolicy });
      if (!check.ok) return refused(check.problems.join('; ') + '.', { entry_id: a.entry_id, tier: contractTier(tier), problems: check.problems });
      approvers = check.approvers;
    }
    const resource = row.kind === 'purchase' ? `purchaseentry/PurchaseEntries(${guid(row.exactEntryId!)})` : `generaljournalentry/GeneralJournalEntries(${guid(row.exactEntryId!)})`;
    const live: any = await ctx.exact.getOne(resource, { select: ['EntryID', 'EntryNumber', 'Status'] }, { division: div });
    if (!live) return refused('the entry no longer exists in Exact.', { entry_id: a.entry_id });
    if (Number(live.Status) !== STATUS_OPEN) return refused(`the entry is ${entryStatusName(Number(live.Status))} in Exact, not open.`, { entry_id: a.entry_id, exact_status: Number(live.Status) });
    let processed = false;
    if (ctx.config.processMode === 'api') {
      if (row.kind !== 'purchase') return refused('Exact Online has no API update for general journal entries; process it in Exact.', { entry_id: a.entry_id, tier: contractTier(tier), approvers });
      try {
        await ctx.exact.put(resource, { Status: 50 }, { division: div });
      } finally {
        ctx.audit({ tool: 'process_entry', division: div, payloadHash: createHash('sha256').update(`${row.exactEntryId}|50`).digest('hex'), exactId: row.exactEntryId });
      }
      processed = true;
    } else {
      ctx.audit({ tool: 'process_entry', division: div, payloadHash: createHash('sha256').update(`${row.exactEntryId}|release`).digest('hex'), exactId: row.exactEntryId });
    }
    const released = await ledger.markReleased(row.id, processed ? 'processed' : 'approved', approvers, new Date(nowMs));
    if (!released) return refused('another call released this entry first.', { entry_id: a.entry_id });
    return {
      summary: processed
        ? `Processed entry ${live.EntryNumber} (tier ${contractTier(tier)}${approvers.length ? `, approved by ${approvers.join(' and ')}` : ''}).`
        : `Released entry ${live.EntryNumber} for processing (tier ${contractTier(tier)}${approvers.length ? `, approved by ${approvers.join(' and ')}` : ''}); it stays open in Exact until a person processes it there.`,
      data: { draftId: row.exactEntryId, entry_id: row.exactEntryId, entry_number: live.EntryNumber, tier: contractTier(tier), approvers, status: processed ? 'processed' : 'approved' },
    };
  },
});

// --- create_matchset (ENABLE_MATCHSETS) ---

const xmlAttr = (v: string | number) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function matchSetXml(m: { gl_account_code: string; account_code?: string; lines: { fin_year: number; fin_period: number; journal: string; entry_number: number; amount_dc: number }[] }): string {
  const lines = m.lines.map((l) => `<MatchLine finyear="${l.fin_year}" finperiod="${l.fin_period}" journal="${xmlAttr(l.journal)}" entry="${l.entry_number}" amountdc="${l.amount_dc.toFixed(2)}" />`).join('');
  return `<?xml version="1.0" encoding="utf-8"?><eExact xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="eExact-XML.xsd"><MatchSets><MatchSet><GLAccount code="${xmlAttr(m.gl_account_code)}" />${m.account_code ? `<Account code="${xmlAttr(m.account_code)}" />` : ''}<MatchLines>${lines}</MatchLines></MatchSet></MatchSets></eExact>`;
}

export interface XmlMessage { type: number; description: string; topic: string | null; key: string | null }

/**
 * Every Message element of an XMLUpload response. Type 0 (error) and 3 (fatal) are failures, 1 a warning, 2 success;
 * Exact answers HTTP 200 for all of them.
 */
export function xmlMessages(xml: string): XmlMessage[] {
  const text = (v: string) => v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return [...xml.matchAll(/<Message\b([^>]*)>([\s\S]*?)<\/Message>/g)].map((m) => {
    const type = Number(/\btype="(\d+)"/.exec(m[1]!)?.[1] ?? NaN);
    const body = m[2]!;
    const desc = /<Description>([\s\S]*?)<\/Description>/.exec(body)?.[1];
    const topic = /<Topic\b[^>]*\bcode="([^"]*)"/.exec(body)?.[1] ?? null;
    const key = /<Data\b[^>]*\bkey(?:Alt)?="([^"]*)"/.exec(body)?.[1] ?? null;
    return { type, description: text(desc ?? body).slice(0, 300), topic, key };
  });
}

export const xmlFailed = (msgs: XmlMessage[]) => !msgs.length || msgs.some((m) => m.type === 0 || m.type === 3 || Number.isNaN(m.type)) || !msgs.some((m) => m.type === 2);

export const createMatchset = defineTool({
  name: 'create_matchset',
  title: 'Create match set',
  description: 'Matches open items on a G/L account (for example a bank line against a purchase invoice) by uploading an Exact XML MatchSet. Always tier two-step: the dry run returns draftId (matchset:<id>); the call with dry_run=false needs the same lines, two approving answers and two approval tokens for that draftId from different approvers. The matched amounts must cancel out, and the same match set is uploaded once. Exact offers no API to undo a match: unmatch in Exact. WRITES to Exact Online.',
  inputSchema: {
    gl_account_code: z.string().min(1).max(20).describe('Code of the G/L account the items are on (e.g. the creditors account).'),
    account_code: z.string().min(1).max(20).optional().describe('Relation code of the matched items.'),
    lines: z.array(z.object({
      fin_year: z.number().int().min(2000).max(2100), fin_period: z.number().int().min(1).max(13),
      journal: z.string().min(1).max(10), entry_number: z.number().int().positive(), amount_dc: z.number().describe('Amount in the division currency, signed as in Exact.'),
    })).min(2).max(50),
    draftId: z.string().regex(/^matchset:[0-9a-f]{64}$/).optional().describe('draftId of the dry run; must match the lines.'),
    ...approvalFields,
    division: divisionField, dry_run: dryRun,
  },
  annotations: writeAnnotations,
  async run(ctx, a) {
    const ledger = requireLedger(ctx);
    const div = await ctx.exact.resolveDivision(a.division);
    const xml = matchSetXml(a);
    const matchsetId = createHash('sha256').update(`${div}|${xml}`).digest('hex');
    const draftId = `matchset:${matchsetId}`;
    const checks = [checkMatchBalanced(a.lines.map((l: any) => l.amount_dc))];
    const total = a.lines.filter((l: any) => l.amount_dc > 0).reduce((s: number, l: any) => s + l.amount_dc, 0);
    const preview = { division: div, matchset_id: matchsetId, tier: contractTier('two_step'), checks, xml };
    if (failed(checks).length) return refused(`${failed(checks).map((c) => c.message).join('; ')}.`, preview);
    const done = await ledger.pool.query(`SELECT ts FROM audit_log WHERE tool = 'create_matchset' AND exact_id = $1 AND outcome = 'ok' LIMIT 1`, [draftId]);
    if (done.rows.length) return refused('this match set was already uploaded.', { ...preview, duplicate: true });
    if (a.dry_run) {
      return {
        summary: `DRY RUN (nothing was written in division ${div}). Match set of ${a.lines.length} lines; needs two approvals for ${draftId}.`,
        data: { ...approvalContract(draftId, 'two_step', `Match ${a.lines.length} items on ${a.gl_account_code}${a.account_code ? ` for ${a.account_code}` : ''}: ${total.toFixed(2)}`), dry_run: true, ...preview },
      };
    }
    if (a.draftId && a.draftId !== draftId) return refused('draftId does not match these lines; run the dry run again.', preview);
    if (!ctx.config.approvalSigningKey) return refused('approval tokens cannot be checked: APPROVAL_SIGNING_KEY is not configured.', preview);
    const { tokens, answers } = approvalInput(a);
    const check = checkApprovals(ctx.config.approvalSigningKey, tokens, { entry: draftId, tier: 'two_step', drafter: ctx.caller.id, nowMs: ctx.now(), answers, answerPolicy: ctx.config.answerPolicy });
    if (!check.ok) return refused(check.problems.join('; ') + '.', { ...preview, problems: check.problems });
    let response = '';
    try {
      response = await ctx.exact.postXml('MatchSets', xml, { division: div });
    } finally {
      ctx.audit({ tool: 'create_matchset', division: div, payloadHash: matchsetId, exactId: draftId });
    }
    const messages = xmlMessages(response);
    if (xmlFailed(messages)) {
      const why = messages.filter((m) => m.type !== 2).map((m) => `type ${m.type}: ${m.description}`).join('; ') || 'no success message in the response';
      throw new ExactError('api', `Exact Online did not create the match set (${why}).`);
    }
    return { summary: `Created match set of ${a.lines.length} lines on ${a.gl_account_code} (approved by ${check.approvers.join(' and ')}).`, data: { draftId, division: div, matchset_id: matchsetId, approvers: check.approvers, messages } };
  },
});

