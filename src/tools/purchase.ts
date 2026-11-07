import { z } from 'zod';
import { defineTool, type ToolContext } from './types.js';
import { divisionField, fmt, guidField, hashPayload, isoDate, readOnly, round2, topField, trimCode } from './common.js';
import { and, date, guid, str } from '../exact/odata.js';
import { ExactError } from '../exact/errors.js';

export const ENTRY_STATUS: Record<string, number> = { rejected: 5, open: 20, processed: 50 };
export const entryStatusName = (n: number) => (n === 5 ? 'rejected' : n === 20 ? 'open' : n === 50 ? 'processed' : String(n));

const ENTRY_SELECT = ['EntryID', 'EntryNumber', 'InvoiceNumber', 'Supplier', 'SupplierName', 'EntryDate', 'DueDate', 'AmountDC', 'AmountFC', 'VATAmountFC', 'Currency', 'Description', 'Journal', 'Status', 'Type', 'YourRef', 'PaymentReference', 'Document', 'DocumentSubject'];

export const entryShape = (r: any) => ({
  id: r.EntryID, entry_number: r.EntryNumber, invoice_number: r.InvoiceNumber, supplier_id: r.Supplier, supplier_name: r.SupplierName,
  entry_date: r.EntryDate?.slice(0, 10), due_date: r.DueDate?.slice(0, 10), amount_dc: r.AmountDC, amount_fc: r.AmountFC, vat_amount_fc: r.VATAmountFC,
  currency: r.Currency, description: r.Description, journal: trimCode(r.Journal), status: entryStatusName(r.Status),
  type: r.Type === 31 ? 'credit_note' : 'invoice', your_ref: r.YourRef, payment_reference: r.PaymentReference,
  document_id: r.Document ?? null, document_subject: r.DocumentSubject ?? null,
});

async function findEntry(ctx: ToolContext, a: { entry_id?: string; entry_number?: number; division?: number }) {
  if (a.entry_id) return ctx.exact.getOne(`purchaseentry/PurchaseEntries(${guid(a.entry_id)})`, { select: ENTRY_SELECT }, { division: a.division });
  if (a.entry_number) return (await ctx.exact.list('purchaseentry/PurchaseEntries', { select: ENTRY_SELECT, filter: `EntryNumber eq ${a.entry_number}` }, { division: a.division, maxRows: 1, maxPages: 1 })).rows[0] ?? null;
  throw new ExactError('invalid_input', 'Provide entry_id or entry_number.');
}

export const getPurchaseEntry = defineTool({
  name: 'get_purchase_entry',
  title: 'Get purchase entry',
  description: 'Returns one purchase entry (supplier invoice booking) with its lines (G/L account, amount, VAT code) and its linked document, if any. Identify it by entry_id (GUID) or entry_number.',
  inputSchema: { entry_id: guidField('Purchase entry GUID.').optional(), entry_number: z.number().int().positive().optional().describe('Entry number.'), division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    const e: any = await findEntry(ctx, a);
    if (!e) throw new ExactError('invalid_input', 'Purchase entry not found.');
    const { rows: lines } = await ctx.exact.list('purchaseentry/PurchaseEntryLines', {
      select: ['ID', 'LineNumber', 'Description', 'GLAccount', 'GLAccountCode', 'GLAccountDescription', 'AmountFC', 'AmountDC', 'VATCode', 'VATCodeDescription', 'VATPercentage', 'VATAmountFC', 'CostCenter', 'Notes'],
      filter: `EntryID eq ${guid(e.EntryID)}`, orderby: 'LineNumber',
    }, { division: a.division, maxRows: 200, maxPages: 4 });
    const data = {
      ...entryShape(e),
      lines: lines.map((l: any) => ({ line: l.LineNumber, description: l.Description, gl_account_id: l.GLAccount, gl_account: trimCode(l.GLAccountCode), gl_description: l.GLAccountDescription, amount_fc: l.AmountFC, amount_dc: l.AmountDC, vat_code: trimCode(l.VATCode), vat_description: l.VATCodeDescription, vat_percentage: l.VATPercentage, vat_amount_fc: l.VATAmountFC, cost_center: l.CostCenter, notes: l.Notes })),
    };
    return { summary: `Purchase entry ${e.EntryNumber} of ${e.SupplierName} (${e.YourRef ?? 'no supplier invoice number'}): ${e.Currency} ${fmt(e.AmountFC ?? 0)}, ${lines.length} line(s), ${entryStatusName(e.Status)}${e.Document ? ', document attached' : ', no document'}.`, data };
  },
});

export const listBankTransactionLines = defineTool({
  name: 'list_bank_transaction_lines',
  title: 'List bank transaction lines',
  description: 'Lists bank statement lines (bank and payment service journals) in a date range, newest first, with the relation, G/L account, description and amount (sign as Exact stores it on the line; compare one known payment first). Lines still on a suspense account have no relation yet. Use to match payments to open purchase or sales invoices (list_open_payables / list_open_receivables).',
  inputSchema: {
    date_from: isoDate('Statement line date from (inclusive).'), date_to: isoDate('Statement line date to (inclusive).'),
    account_id: guidField('Only lines of this relation (supplier/customer GUID from search_accounts).').optional(),
    gl_account_id: guidField('Only lines booked on this G/L account (GUID from list_gl_accounts).').optional(),
    description: z.string().min(1).max(100).optional().describe('Text contained in the line description.'),
    amount_min: z.number().optional().describe('Only lines with amount (transaction currency) >= this value.'),
    amount_max: z.number().optional().describe('Only lines with amount (transaction currency) <= this value.'),
    division: divisionField, top: topField(100, 500),
  },
  annotations: readOnly,
  async run(ctx, a) {
    const filter = and([
      `Date ge ${date(a.date_from)}`, `Date le ${date(a.date_to)}`,
      a.account_id && `Account eq ${guid(a.account_id)}`, a.gl_account_id && `GLAccount eq ${guid(a.gl_account_id)}`,
      a.description && `substringof(${str(a.description)}, Description) eq true`,
      a.amount_min !== undefined && `AmountFC ge ${a.amount_min}`, a.amount_max !== undefined && `AmountFC le ${a.amount_max}`,
    ]);
    const select = ['ID', 'EntryID', 'EntryNumber', 'LineNumber', 'Date', 'Description', 'Notes', 'Account', 'AccountCode', 'AccountName', 'GLAccount', 'GLAccountCode', 'GLAccountDescription', 'AmountFC', 'AmountDC', 'OurRef', 'Document'];
    const { rows, truncated } = await ctx.exact.list('financialtransaction/BankEntryLines', { select, filter, orderby: 'Date desc' }, { division: a.division, maxRows: a.top, maxPages: 10 });
    const net = round2(rows.reduce((s: number, r: any) => s + (r.AmountDC ?? 0), 0));
    return {
      summary: `Found ${rows.length} bank line(s), net ${fmt(net)} (default currency)${truncated ? ' (more exist; narrow the filters)' : ''}.`,
      data: { net_amount_dc: net, truncated, lines: rows.map((r: any) => ({ id: r.ID, entry_id: r.EntryID, entry_number: r.EntryNumber, line: r.LineNumber, date: r.Date?.slice(0, 10), description: r.Description, notes: r.Notes, account_id: r.Account, account_code: trimCode(r.AccountCode), account_name: r.AccountName, gl_account_id: r.GLAccount, gl_account: trimCode(r.GLAccountCode), gl_description: r.GLAccountDescription, amount_fc: r.AmountFC, amount_dc: r.AmountDC, our_ref: r.OurRef, document_id: r.Document ?? null })) },
    };
  },
});

export const listVatCodes = defineTool({
  name: 'list_vat_codes',
  title: 'List VAT codes',
  description: 'Lists VAT codes (code, description, percentage, calculation type, purchase/sales use). Use the code in draft_purchase_entry lines.',
  inputSchema: {
    query: z.string().min(1).max(100).optional().describe('Text contained in the description, or the exact code.'),
    use: z.enum(['purchase', 'sales', 'any']).default('any').describe('Only codes usable for purchase or sales transactions.'),
    include_blocked: z.boolean().default(false),
    division: divisionField,
  },
  annotations: readOnly,
  async run(ctx, a) {
    const filter = and([
      a.query && `(substringof(${str(a.query)}, Description) eq true or Code eq ${str(a.query)})`,
      a.use === 'purchase' && `(VATTransactionType eq 'P' or VATTransactionType eq 'B')`,
      a.use === 'sales' && `(VATTransactionType eq 'S' or VATTransactionType eq 'B')`,
      !a.include_blocked && 'IsBlocked eq false',
    ]);
    const select = ['ID', 'Code', 'Description', 'Percentage', 'Type', 'VATTransactionType', 'IsBlocked', 'Charged', 'GLToClaimCode', 'GLToPayCode'];
    const { rows } = await ctx.exact.list('vat/VATCodes', { select, filter, orderby: 'Code' }, { division: a.division, maxRows: 500, maxPages: 10 });
    const TYPE: Record<string, string> = { B: 'zero_rate_base_only', E: 'excluding', I: 'including', N: 'no_vat' };
    const USE: Record<string, string> = { B: 'both', P: 'purchase', S: 'sales' };
    return { summary: `Found ${rows.length} VAT code(s).`, data: rows.map((v: any) => ({ id: v.ID, code: trimCode(v.Code), description: v.Description, percentage: v.Percentage, type: TYPE[v.Type] ?? v.Type, use: USE[v.VATTransactionType] ?? v.VATTransactionType, blocked: !!v.IsBlocked, reverse_charge: !!v.Charged, gl_to_claim: trimCode(v.GLToClaimCode), gl_to_pay: trimCode(v.GLToPayCode) })) };
  },
});

export const listJournals = defineTool({
  name: 'list_journals',
  title: 'List journals',
  description: 'Lists financial journals (code, description, type: bank, cash, sales, purchase, general). draft_purchase_entry needs the code of a purchase journal.',
  inputSchema: { kind: z.enum(['purchase', 'sales', 'bank', 'cash', 'general', 'any']).default('any'), division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    const TYPES: Record<string, number[]> = { cash: [10], bank: [12], sales: [20, 21], purchase: [22, 23], general: [90] };
    const filter = a.kind === 'any' ? undefined : `(${TYPES[a.kind]!.map((t) => `Type eq ${t}`).join(' or ')})`;
    const { rows } = await ctx.exact.list('financial/Journals', { select: ['ID', 'Code', 'Description', 'Type', 'TypeDescription', 'Currency', 'GLAccountCode'], filter, orderby: 'Code' }, { division: a.division, maxRows: 200, maxPages: 4 });
    return { summary: `Found ${rows.length} journal(s).`, data: rows.map((j: any) => ({ code: trimCode(j.Code), description: j.Description, type: j.TypeDescription ?? j.Type, type_id: j.Type, currency: j.Currency, gl_account: trimCode(j.GLAccountCode) })) };
  },
});

export const listDocumentTypes = defineTool({
  name: 'list_document_types',
  title: 'List document types',
  description: 'Lists Exact document types (id, description, whether documents of the type can be created). attach_document takes the id as document_type.',
  inputSchema: { division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    const { rows } = await ctx.exact.list('documents/DocumentTypes', { select: ['ID', 'Description', 'DocumentIsCreatable'], orderby: 'ID' }, { division: a.division, maxRows: 300, maxPages: 5 });
    return { summary: `Found ${rows.length} document type(s).`, data: rows.map((t: any) => ({ id: t.ID, description: t.Description, creatable: !!t.DocumentIsCreatable })) };
  },
});

// --- write tools ---

const dryRun = z.boolean().default(true).describe('Default true: only returns the payload that would be posted. Set false ONLY after the user explicitly confirmed the details.');
const writeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const compact = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const purchaseLine = z.object({
  gl_account_id: guidField('Cost or balance G/L account GUID (from list_gl_accounts).'),
  amount: z.number().describe('Line amount EXCLUDING VAT, in the entry currency. Negative on a credit note.'),
  vat_code: z.string().min(1).max(8).optional().describe('VAT code (from list_vat_codes); omitted: the G/L account default.'),
  vat_amount: z.number().optional().describe('VAT amount when it differs from what Exact calculates from the VAT code (rounding on the invoice).'),
  description: z.string().max(240).optional(),
  cost_center: z.string().max(8).optional().describe('Cost center code.'),
});

export const draftPurchaseEntry = defineTool({
  name: 'draft_purchase_entry',
  title: 'Draft purchase entry',
  description: 'Creates a purchase entry (supplier invoice booking) that stays OPEN (Status 20, not processed) so a person reviews and processes it in Exact. WRITES to Exact Online. Refuses when an entry with the same supplier and supplier invoice number (your_ref) exists and returns that entry. Always show the dry-run result and get explicit confirmation before calling with dry_run=false. Attach the invoice PDF afterwards with attach_document.',
  inputSchema: {
    supplier_id: guidField('Supplier account GUID (search_accounts kind=supplier).'),
    journal: z.string().min(1).max(10).describe('Purchase journal code (list_journals kind=purchase).'),
    your_ref: z.string().min(1).max(60).describe("The supplier's invoice number."),
    entry_date: isoDate('Invoice date.'),
    due_date: isoDate('Due date; omitted: from the payment condition.').optional(),
    description: z.string().min(1).max(60).describe('Entry description.'),
    currency: z.string().length(3).optional().describe('ISO currency code; omitted: the division currency.'),
    payment_reference: z.string().max(50).optional().describe('Payment reference (betalingskenmerk) from the invoice.'),
    credit_note: z.boolean().default(false).describe('true: purchase credit note (Type 31).'),
    lines: z.array(purchaseLine).min(1).max(50),
    division: divisionField, dry_run: dryRun,
  },
  annotations: writeAnnotations,
  async run(ctx, a) {
    const div = await ctx.exact.resolveDivision(a.division);
    const body = compact({
      Journal: a.journal, Supplier: a.supplier_id, YourRef: a.your_ref, EntryDate: a.entry_date, DueDate: a.due_date, Description: a.description,
      Currency: a.currency, PaymentReference: a.payment_reference, Type: a.credit_note ? 31 : 30,
      PurchaseEntryLines: a.lines.map((l: any) => compact({ GLAccount: l.gl_account_id, AmountFC: l.amount, VATCode: l.vat_code, VATAmountFC: l.vat_amount, Description: l.description, CostCenter: l.cost_center })),
    });
    const { rows: dup } = await ctx.exact.list('purchaseentry/PurchaseEntries', { select: ENTRY_SELECT, filter: `Supplier eq ${guid(a.supplier_id)} and YourRef eq ${str(a.your_ref)}` }, { division: div, maxRows: 5, maxPages: 1 });
    if (dup.length) {
      return { summary: `REFUSED: supplier invoice ${a.your_ref} is already booked as purchase entry ${dup[0].EntryNumber} (${entryStatusName(dup[0].Status)}). Nothing was created.`, data: { duplicate: true, division: div, existing: dup.map(entryShape) } };
    }
    const net = round2(a.lines.reduce((s: number, l: any) => s + l.amount, 0));
    if (a.dry_run) {
      return { summary: `DRY RUN (nothing was created in division ${div}). Purchase entry for ${a.your_ref}, ${a.lines.length} line(s), ${fmt(net)} excl. VAT. Confirm with the user, then call again with dry_run=false.`, data: { dry_run: true, division: div, resource: 'purchaseentry/PurchaseEntries', payload: body } };
    }
    let created: any;
    try {
      created = await ctx.exact.post('purchaseentry/PurchaseEntries', body, { division: div });
    } finally {
      ctx.audit({ tool: 'draft_purchase_entry', division: div, payloadHash: hashPayload(body), exactId: created?.EntryID ?? null });
    }
    const status = Number(created?.Status);
    const warn = status === 50 ? ' WARNING: Exact processed the entry immediately (Status 50); check the journal settings.' : '';
    return { summary: `Created purchase entry ${created?.EntryNumber ?? ''} in division ${div}, status ${entryStatusName(status)}.${warn}`, data: { dry_run: false, division: div, ...entryShape(created ?? {}) } };
  },
});

const MIME: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', xml: 'application/xml', tif: 'image/tiff', tiff: 'image/tiff' };

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

export const attachDocument = defineTool({
  name: 'attach_document',
  title: 'Attach document to purchase entry',
  description: 'Attaches a file (the supplier invoice PDF) to a purchase entry: adds it to the document already linked to the entry, or creates a document of document_type for the supplier and links it to the entry. Give the file as content_base64 or as an https file_url the server downloads. WRITES to Exact Online. Show the dry-run result and get explicit confirmation before calling with dry_run=false.',
  inputSchema: {
    entry_id: guidField('Purchase entry GUID (from draft_purchase_entry or list_purchase_entries).'),
    file_name: z.string().min(1).max(200).regex(/\.(pdf|png|jpe?g|xml|tiff?)$/i, 'use a .pdf, .png, .jpg, .xml or .tif file name').describe('File name with extension, e.g. "INV-2026-123.pdf".'),
    content_base64: z.string().min(4).optional().describe('File content, base64 encoded.'),
    file_url: z.string().url().optional().describe('https URL of the file (a share link) instead of content_base64.'),
    subject: z.string().min(1).max(200).optional().describe('Document subject; omitted: "<supplier> <your_ref>".'),
    document_type: z.number().int().positive().default(20).describe('Document type id for a new document (list_document_types); default 20 = purchase invoice.'),
    division: divisionField, dry_run: dryRun,
  },
  annotations: writeAnnotations,
  async run(ctx, a) {
    if (!!a.content_base64 === !!a.file_url) throw new ExactError('invalid_input', 'Provide exactly one of content_base64 or file_url.');
    const div = await ctx.exact.resolveDivision(a.division);
    const e: any = await findEntry(ctx, { entry_id: a.entry_id, division: div });
    if (!e) throw new ExactError('invalid_input', 'Purchase entry not found.');
    const ext = a.file_name.split('.').pop()!.toLowerCase();
    const file = a.content_base64 ? Buffer.from(a.content_base64, 'base64') : await fetchFile(ctx, a.file_url!);
    if (!file.length || file.length > ctx.config.maxAttachmentBytes) throw new ExactError('invalid_input', 'The file is empty or larger than the attachment limit.');
    if (ext === 'pdf' && file.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ExactError('invalid_input', 'The content is not a PDF file.');
    const subject = a.subject ?? `${e.SupplierName ?? 'Supplier'} ${e.YourRef ?? e.EntryNumber}`.slice(0, 200);
    const plan = {
      entry: { id: e.EntryID, entry_number: e.EntryNumber, supplier_name: e.SupplierName, your_ref: e.YourRef, status: entryStatusName(e.Status) },
      document: e.Document ? { existing: e.Document } : { create: { Subject: subject, Type: a.document_type, Account: e.Supplier, DocumentDate: e.EntryDate?.slice(0, 10) } },
      attachment: { FileName: a.file_name, bytes: file.length, mime: MIME[ext], sha256: hashPayload(file.toString('base64')) },
    };
    if (a.dry_run) {
      return { summary: `DRY RUN (nothing was changed in division ${div}). ${a.file_name} (${file.length} bytes) to purchase entry ${e.EntryNumber}${e.Document ? ' (added to its existing document)' : ' (new document)'}. Confirm with the user, then call again with dry_run=false.`, data: { dry_run: true, division: div, ...plan } };
    }
    let docId: string | null = e.Document ?? null;
    let attId: string | null = null;
    let linked = !!e.Document;
    try {
      if (!docId) {
        const doc: any = await ctx.exact.post('documents/Documents', compact(plan.document.create!), { division: div });
        docId = doc?.ID ?? null;
        if (!docId) throw new ExactError('api', 'Exact Online created no document.');
      }
      const att: any = await ctx.exact.post('documents/DocumentAttachments', { Document: docId, FileName: a.file_name, Attachment: file.toString('base64') }, { division: div });
      attId = att?.ID ?? null;
      if (!linked) {
        try {
          await ctx.exact.put(`purchaseentry/PurchaseEntries(${guid(e.EntryID)})`, { Document: docId }, { division: div });
          linked = true;
        } catch (err) {
          const msg = err instanceof ExactError ? err.userMessage : 'unknown error';
          return { summary: `Created document ${docId} with ${a.file_name}, but could not link it to purchase entry ${e.EntryNumber}: ${msg}`, data: { dry_run: false, division: div, document_id: docId, attachment_id: attId, linked: false } };
        }
      }
    } finally {
      ctx.audit({ tool: 'attach_document', division: div, payloadHash: plan.attachment.sha256, exactId: docId });
    }
    return { summary: `Attached ${a.file_name} to purchase entry ${e.EntryNumber} (document ${docId}).`, data: { dry_run: false, division: div, entry_id: e.EntryID, document_id: docId, attachment_id: attId, linked } };
  },
});

