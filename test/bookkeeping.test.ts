import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { callTool, getTokens, json, mcpCall, odata, parseResult, startApp, type TestEnv } from './helpers.js';
import { memStore } from './pgmem.js';
import { mintApproval } from '../src/policy/approval.js';
import type { PgStore } from '../src/db/ledger.js';

// synthetic fixtures only
const SUPPLIER = '11111111-1111-1111-1111-111111111111';
const GL_COST = '22222222-2222-2222-2222-222222222222';
const GL_BALANCE = '22222222-2222-2222-2222-222222222223';
const GL_VAT = '22222222-2222-2222-2222-222222222224';
const ENTRY = '33333333-3333-3333-3333-333333333333';
const ENTRY2 = '33333333-3333-3333-3333-333333333334';
const DOC = '44444444-4444-4444-4444-444444444444';
const KEY = 'approval-key-'.padEnd(40, 'x');
const PDF = Buffer.from('%PDF-1.7\n%synthetic\n');
const T0 = Date.parse('2026-11-08T09:00:00Z');
const YES = ['ja', 'akkoord'];

const purchase = (over: Record<string, unknown> = {}) => ({
  supplier_id: SUPPLIER, journal: '60', your_ref: 'INV-2026-0001', entry_date: '2026-11-01',
  description: { supplier: 'Acme', period: '2026-11', short: 'hosting' },
  totals: { net: 100, vat: 21, gross: 121 }, lines: [{ gl_account_id: GL_COST, amount: 100, vat_code: '2' }], ...over,
});
const journal = (over: Record<string, unknown> = {}) => ({
  journal: '90', entry_date: '2026-11-30', reference: 'MEM-11', description: { supplier: 'Internal', period: '2026-11', short: 'accrual' },
  lines: [{ gl_account_id: GL_COST, debit: 500 }, { gl_account_id: GL_VAT, credit: 500 }], ...over,
});

let env: TestEnv;
let ledger: PgStore;
let clock = T0;
afterEach(() => env?.close());

interface ExactState { posted: { path: string; body: any }[]; puts: { path: string; body: any }[]; xml: string[]; status: number; existingYourRef: boolean }

async function start(over: Record<string, string> = {}) {
  clock = T0;
  ledger = await memStore();
  env = await startApp({ ENABLE_WRITE_TOOLS: 'true', APPROVAL_SIGNING_KEY: KEY, ...over }, () => clock, { ledger });
  env.fake.withLogin();
  const token = (await getTokens(env)).tokens.access_token as string;
  const st: ExactState = { posted: [], puts: [], xml: [], status: 20, existingYourRef: false };
  let n = 0;
  env.fake.on((url, init) => {
    const p = url.pathname;
    const method = init.method ?? 'GET';
    if (p.endsWith('/vat/VATCodes')) return odata([{ Code: '2  ', Percentage: 0.21, IsBlocked: false, VATTransactionType: 'B' }, { Code: '5', Percentage: 0, IsBlocked: false, VATTransactionType: 'S' }]);
    if (p.endsWith('/financial/GLAccounts')) {
      const all = [{ ID: GL_COST, Code: '4000', BalanceType: 'W' }, { ID: GL_BALANCE, Code: '1100', BalanceType: 'B' }, { ID: GL_VAT, Code: '1500', BalanceType: 'B' }];
      const f = url.searchParams.get('$filter') ?? '';
      return odata(all.filter((g) => f.includes(g.ID)));
    }
    if (p.endsWith('/purchaseentry/PurchaseEntries') && method === 'GET') return odata(st.existingYourRef ? [{ EntryID: ENTRY2, EntryNumber: 5, Status: 50, YourRef: 'INV-2026-0001' }] : []);
    if (p.endsWith('/documents/Documents')) { st.posted.push({ path: 'Documents', body: JSON.parse(String(init.body)) }); return json({ d: { ID: DOC } }, 201); }
    if (p.endsWith('/documents/DocumentAttachments')) { st.posted.push({ path: 'DocumentAttachments', body: JSON.parse(String(init.body)) }); return json({ d: { ID: 'att' } }, 201); }
    if ((p.endsWith('/purchaseentry/PurchaseEntries') || p.endsWith('/generaljournalentry/GeneralJournalEntries')) && method === 'POST') {
      const body = JSON.parse(String(init.body));
      st.posted.push({ path: p.split('/').pop()!, body });
      n++;
      return json({ d: { EntryID: n === 1 ? ENTRY : ENTRY2, EntryNumber: 26000000 + n, Status: 20 } }, 201);
    }
    if (p.includes('PurchaseEntries(') || p.includes('GeneralJournalEntries(')) {
      if (method === 'PUT') { st.puts.push({ path: p, body: JSON.parse(String(init.body)) }); return new Response(null, { status: 204 }); }
      return json({ d: { EntryID: ENTRY, EntryNumber: 26000001, Status: st.status, Supplier: SUPPLIER, SupplierName: 'Acme', YourRef: 'INV-2026-0001', EntryDate: '/Date(1761955200000)/' } });
    }
    if (p === '/docs/XMLUpload.aspx') { st.xml.push(String(init.body)); return new Response('<?xml version="1.0"?><eExact><Messages><Message type="2"><Topic code="MatchSets"/><Description>Created</Description></Message></Messages></eExact>', { status: 200, headers: { 'content-type': 'application/xml' } }); }
    return undefined;
  });
  return { token, st };
}

const call = async (token: string, tool: string, args: unknown) => { const r = await callTool(env, token, tool, args); if (!r.body?.result) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return parseResult(r.body); };
const approval = (entry: string, approver: string, tier: 'approve' | 'two_step' = 'approve', expSec = T0 / 1000 + 86_400, answer?: string) => mintApproval(KEY, { entry, tier, approver, exp: expSec, answer });

describe('registration', () => {
  it('without a ledger the ledger tools stay disabled', async () => {
    env = await startApp({ ENABLE_WRITE_TOOLS: 'true' });
    env.fake.withLogin();
    const token = (await getTokens(env)).tokens.access_token as string;
    const names = ((await mcpCall(env, token, 'tools/list')).body.result.tools as any[]).map((t) => t.name);
    expect(names).toContain('create_sales_invoice');
    expect(names).not.toContain('draft_purchase_entry');
    expect(names).not.toContain('process_entry');
  });
  it('naming a ledger tool without DATABASE_URL stops the server', async () => {
    await expect(startApp({ WRITE_TOOLS: 'draft_purchase_entry' })).rejects.toThrow(/WRITE_TOOLS: draft_purchase_entry needs DATABASE_URL/);
    await expect(startApp({ WRITE_TOOLS: 'no_such_tool' })).rejects.toThrow(/unknown write tool/);
  });
  it('create_matchset is off unless ENABLE_MATCHSETS is set', async () => {
    const { token } = await start();
    const names = ((await mcpCall(env, token, 'tools/list')).body.result.tools as any[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['draft_purchase_entry', 'draft_general_journal_entry', 'attach_document', 'process_entry', 'list_gl_account_rgs_mappings']));
    expect(names).not.toContain('create_matchset');
  });
});

describe('draft_purchase_entry', () => {
  it('dry run renders the description, runs the checks and writes nothing', async () => {
    const { token, st } = await start();
    const r = await call(token, 'draft_purchase_entry', purchase());
    expect(r.summary).toContain('DRY RUN');
    expect(r.data.payload).toMatchObject({ Description: 'Acme|2026-11|INV-2026-0001|hosting', Currency: 'EUR', Type: 30, PurchaseEntryLines: [{ GLAccount: GL_COST, AmountFC: 100, VATCode: '2' }] });
    expect(r.data.checks.every((c: any) => c.ok)).toBe(true);
    expect(r.data.tier).toBe('approve');
    expect(st.posted).toEqual([]);
  });
  it('takes an explicit ref part for the description', async () => {
    const { token } = await start();
    const r = await call(token, 'draft_purchase_entry', purchase({ description: { supplier: 'Acme', period: '2026-11', ref: 'A1', short: 'hosting' } }));
    expect(r.data.payload.Description).toBe('Acme|2026-11|A1|hosting');
  });
  it.each([
    ['lines that do not add up to net', { lines: [{ gl_account_id: GL_COST, amount: 99, vat_code: '2' }] }, 'line_sum_equals_net'],
    ['net + VAT that is not gross', { totals: { net: 100, vat: 21, gross: 120 } }, 'net_plus_vat_equals_gross'],
    ['an unknown VAT code', { lines: [{ gl_account_id: GL_COST, amount: 100, vat_code: '77' }] }, 'vat_code_known'],
    ['a sales VAT code', { lines: [{ gl_account_id: GL_COST, amount: 100, vat_code: '5' }], totals: { net: 100, vat: 0, gross: 100 } }, 'vat_code_known'],
    ['VAT that does not match the lines', { totals: { net: 100, vat: 9, gross: 109 } }, 'vat_matches_lines'],
  ])('refuses %s before any write', async (_n, over, check) => {
    const { token, st } = await start();
    const r = await call(token, 'draft_purchase_entry', { ...purchase(over), dry_run: false });
    expect(r.summary).toContain('REFUSED');
    expect(r.data.refused).toBe(true);
    expect(r.data.checks.find((c: any) => c.name === check).ok).toBe(false);
    expect(st.posted).toEqual([]);
  });
  it('refuses a bad description part', async () => {
    const { token } = await start();
    const r = await call(token, 'draft_purchase_entry', purchase({ description: { supplier: 'Ac|me', period: '2026-11', short: 'x' } }));
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('must not contain "|"');
  });
  it('drafts as Status 20, records the ledger row and the audit row', async () => {
    const { token, st } = await start();
    const r = await call(token, 'draft_purchase_entry', { ...purchase(), dry_run: false });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ exact_entry_id: ENTRY, status: 'open', status_warning: null, tier: 'approve' });
    expect(st.posted.map((p) => p.path)).toEqual(['PurchaseEntries']);
    expect(await ledger.getByExactId(100, ENTRY)).toMatchObject({ status: 'drafted', refNorm: 'INV20260001', amountCents: 12100, tier: 'approve' });
    const { rows } = await ledger.pool.query(`SELECT tool, outcome, exact_status, exact_id, caller_kind, args_sha256 FROM audit_log WHERE tool = 'draft_purchase_entry'`);
    expect(rows).toEqual([expect.objectContaining({ outcome: 'ok', exact_status: 201, exact_id: ENTRY, caller_kind: 'human' })]);
    expect(rows[0].args_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('refuses the same invoice again with the existing Exact GUID, whatever its formatting', async () => {
    const { token, st } = await start();
    await call(token, 'draft_purchase_entry', { ...purchase(), dry_run: false });
    const r = await call(token, 'draft_purchase_entry', { ...purchase({ your_ref: 'inv 2026/0001' }), dry_run: false });
    expect(r.summary).toContain('REFUSED');
    expect(r.data.existing[0].exact_entry_id).toBe(ENTRY);
    expect(st.posted).toHaveLength(1);
  });
  it('refuses the same supplier and amount inside the date window', async () => {
    const { token } = await start();
    await call(token, 'draft_purchase_entry', { ...purchase(), dry_run: false });
    const r = await call(token, 'draft_purchase_entry', { ...purchase({ your_ref: 'OTHER-9', entry_date: '2026-11-05' }), dry_run: false });
    expect(r.data.duplicate).toBe(true);
    const later = await call(token, 'draft_purchase_entry', purchase({ your_ref: 'OTHER-9', entry_date: '2026-12-15' }));
    expect(later.summary).toContain('DRY RUN');
  });
  it('refuses the same PDF for another invoice', async () => {
    const { token } = await start();
    const file = { file_name: 'inv.pdf', content_base64: PDF.toString('base64') };
    const first = await call(token, 'draft_purchase_entry', { ...purchase({ file }), dry_run: false });
    expect(first.data.document_id).toBe(DOC);
    const r = await call(token, 'draft_purchase_entry', { ...purchase({ your_ref: 'X-2', totals: { net: 200, vat: 42, gross: 242 }, lines: [{ gl_account_id: GL_COST, amount: 200, vat_code: '2' }], file }), dry_run: false });
    expect(r.data.duplicate).toBe(true);
  });
  it('uploads the invoice file and links it in the same POST', async () => {
    const { token, st } = await start();
    await call(token, 'draft_purchase_entry', { ...purchase({ file: { file_name: 'inv.pdf', content_base64: PDF.toString('base64') } }), dry_run: false });
    expect(st.posted.map((p) => p.path)).toEqual(['Documents', 'DocumentAttachments', 'PurchaseEntries']);
    expect(st.posted[2]!.body.Document).toBe(DOC);
    expect((await ledger.getByExactId(100, ENTRY))!.pdfSha256).toBe(createHash('sha256').update(PDF).digest('hex'));
  });
  it('refuses an invoice number already booked in Exact', async () => {
    const { token, st } = await start();
    st.existingYourRef = true;
    const r = await call(token, 'draft_purchase_entry', { ...purchase(), dry_run: false });
    expect(r.summary).toContain('already booked in Exact');
  });
  it('is auto for a small invoice of a supplier with 3 earlier entries', async () => {
    const { token } = await start();
    for (let i = 1; i <= 3; i++) {
      const id = await ledger.reserve({ division: 100, kind: 'purchase', supplierId: SUPPLIER, refNorm: `OLD${i}`, journal: '60', entryDate: `2026-0${i}-01`, currency: 'EUR', amountCents: i, pdfSha256: null, tier: 'approve', tierReasons: [], createdBy: 'x', createdAt: new Date(T0), holdUntil: null });
      await ledger.markDrafted(id, `00000000-0000-0000-0000-00000000000${i}`, i);
      await ledger.markReleased(id, 'approved', ['alice'], new Date(T0));
    }
    const r = await call(token, 'draft_purchase_entry', { ...purchase(), dry_run: false });
    expect(r.data.tier).toBe('auto');
    expect(r.data.hold_until).toBe(new Date(T0 + 24 * 3_600_000).toISOString());
  });
  it('does not count drafts that were never approved as supplier history', async () => {
    const { token } = await start();
    for (let i = 1; i <= 3; i++) {
      const id = await ledger.reserve({ division: 100, kind: 'purchase', supplierId: SUPPLIER, refNorm: `OLD${i}`, journal: '60', entryDate: `2026-0${i}-01`, currency: 'EUR', amountCents: i, pdfSha256: null, tier: 'approve', tierReasons: [], createdBy: 'x', createdAt: new Date(T0), holdUntil: null });
      await ledger.markDrafted(id, `00000000-0000-0000-0000-00000000000${i}`, i);
    }
    const r = await call(token, 'draft_purchase_entry', purchase());
    expect(r.data.tier).toBe('approve');
    expect(r.data.tier_reasons.join()).toContain('0 earlier entries');
  });
  it('rates offsetting lines on their volume, not on their small net', async () => {
    const { token } = await start();
    for (let i = 1; i <= 3; i++) {
      const id = await ledger.reserve({ division: 100, kind: 'purchase', supplierId: SUPPLIER, refNorm: `OLD${i}`, journal: '60', entryDate: `2026-0${i}-01`, currency: 'EUR', amountCents: i, pdfSha256: null, tier: 'approve', tierReasons: [], createdBy: 'x', createdAt: new Date(T0), holdUntil: null });
      await ledger.markDrafted(id, `00000000-0000-0000-0000-00000000000${i}`, i);
      await ledger.markReleased(id, 'approved', ['alice'], new Date(T0));
    }
    const lines = [{ gl_account_id: GL_COST, amount: 10000, vat_code: '2', vat_amount: 21 }, { gl_account_id: GL_COST, amount: -9900, vat_code: '2', vat_amount: 0 }];
    const big = await call(token, 'draft_purchase_entry', purchase({ lines }));
    expect(big.data.tier).toBe('two-step');
    const small = await call(token, 'draft_purchase_entry', purchase({ totals: { net: 100, vat: 21, gross: 121 }, lines: [{ gl_account_id: GL_COST, amount: 110, vat_code: '2', vat_amount: 23.1 }, { gl_account_id: GL_COST, amount: -10, vat_code: '2', vat_amount: -2.1 }] }));
    expect(small.data.tier).toBe('approve');
    expect(small.data.tier_reasons.join()).toContain('both positive and negative');
  });
  it('is two-step above 5,000 EUR and for a balance account off the allow-list', async () => {
    const { token } = await start();
    const big = await call(token, 'draft_purchase_entry', purchase({ totals: { net: 5000, vat: 1050, gross: 6050 }, lines: [{ gl_account_id: GL_COST, amount: 5000, vat_code: '2' }] }));
    expect(big.data.tier).toBe('two-step');
    const bal = await call(token, 'draft_purchase_entry', purchase({ lines: [{ gl_account_id: GL_BALANCE, amount: 100, vat_code: '2' }] }));
    expect(bal.data.tier).toBe('two-step');
    expect(bal.data.tier_reasons.join()).toContain('1100');
  });
});

describe('draft_general_journal_entry', () => {
  it('posts signed amounts with rendered line descriptions, tier approve', async () => {
    const { token, st } = await start();
    const r = await call(token, 'draft_general_journal_entry', { ...journal(), dry_run: false });
    expect(r.data.tier).toBe('two-step'); // GL_VAT is a balance account off the empty allow-list
    expect(st.posted[0]!.body).toMatchObject({
      JournalCode: '90', GeneralJournalEntryLines: [
        { GLAccount: GL_COST, AmountFC: 500, Description: 'Internal|2026-11|MEM-11|accrual', Date: '2026-11-30' },
        { GLAccount: GL_VAT, AmountFC: -500 },
      ],
    });
  });
  it('is approve when the balance account is allowed, two-step for a payroll journal', async () => {
    const { token } = await start({ TIER_BALANCE_ACCOUNT_ALLOWLIST: '1500', TIER_PAYROLL_JOURNALS: '95' });
    expect((await call(token, 'draft_general_journal_entry', journal())).data.tier).toBe('approve');
    expect((await call(token, 'draft_general_journal_entry', journal({ journal: '95' }))).data.tier).toBe('two-step');
  });
  it('refuses an unbalanced entry and a line with both sides', async () => {
    const { token, st } = await start();
    const r = await call(token, 'draft_general_journal_entry', { ...journal({ lines: [{ gl_account_id: GL_COST, debit: 500 }, { gl_account_id: GL_VAT, credit: 499 }] }), dry_run: false });
    expect(r.data.checks.find((c: any) => c.name === 'debit_equals_credit').ok).toBe(false);
    const both = await call(token, 'draft_general_journal_entry', journal({ lines: [{ gl_account_id: GL_COST, debit: 5, credit: 5 }, { gl_account_id: GL_VAT, credit: 0.01 }] }));
    expect(both.data.checks.find((c: any) => c.name === 'one_side_per_line').ok).toBe(false);
    expect(st.posted).toEqual([]);
  });
  it('balances VAT on the debit side and refuses the same reference twice', async () => {
    const { token } = await start({ TIER_BALANCE_ACCOUNT_ALLOWLIST: '1500' });
    const lines = [{ gl_account_id: GL_COST, debit: 100, vat_code: '2', vat_amount: 21 }, { gl_account_id: GL_VAT, credit: 121 }];
    const r = await call(token, 'draft_general_journal_entry', { ...journal({ lines }), dry_run: false });
    expect(r.data.exact_entry_id).toBe(ENTRY);
    const again = await call(token, 'draft_general_journal_entry', { ...journal({ lines, reference: 'mem 11' }), dry_run: false });
    expect(again.data.existing[0].exact_entry_id).toBe(ENTRY);
  });
});

describe('attach_document', () => {
  it('attaches, links and records the PDF hash; refuses a different PDF afterwards', async () => {
    const { token, st } = await start();
    await call(token, 'draft_purchase_entry', { ...purchase(), dry_run: false });
    const r = await call(token, 'attach_document', { entry_id: ENTRY, file_name: 'inv.pdf', content_base64: PDF.toString('base64'), dry_run: false });
    expect(r.data).toMatchObject({ document_id: DOC, linked: true });
    expect(st.puts).toEqual([{ path: expect.stringContaining(ENTRY), body: { Document: DOC } }]);
    const other = Buffer.from('%PDF-1.7\n%other\n').toString('base64');
    const again = await call(token, 'attach_document', { entry_id: ENTRY, file_name: 'b.pdf', content_base64: other });
    expect(again.summary).toContain('different file');
  });
  it('rejects content that is not a PDF', async () => {
    const { token } = await start();
    const r = await call(token, 'attach_document', { entry_id: ENTRY, file_name: 'inv.pdf', content_base64: Buffer.from('hello').toString('base64') });
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('not a PDF');
  });
});

describe('process_entry', () => {
  async function drafted(over: Record<string, string> = {}, args = purchase()) {
    const s = await start(over);
    await call(s.token, 'draft_purchase_entry', { ...args, dry_run: false });
    return s;
  }
  it('answers the approval contract after a draft and takes draftId', async () => {
    const { token } = await start();
    const r = await call(token, 'draft_purchase_entry', { ...purchase(), dry_run: false });
    expect(r.data).toMatchObject({ approvalRequired: true, draftId: ENTRY, tier: 'approve', summary: 'Purchase invoice Acme|2026-11|INV-2026-0001|hosting: EUR 121.00 incl. VAT 21.00' });
    const ok = await call(token, 'process_entry', { draftId: r.data.draftId, answer: 'Ja, akkoord', approvalToken: approval(ENTRY, 'alice', 'approve', undefined, 'ja,  AKKOORD') });
    expect(ok.data).toMatchObject({ draftId: ENTRY, status: 'approved', approvers: ['alice'] });
  });
  it('refuses a rejecting answer and a token issued for another answer', async () => {
    const { token } = await drafted();
    const no = await call(token, 'process_entry', { draftId: ENTRY, answer: 'nee, eerst bellen', approvalToken: approval(ENTRY, 'alice') });
    expect(no.data.problems.join()).toContain('not an approval');
    const other = await call(token, 'process_entry', { draftId: ENTRY, answer: 'ja', approvalToken: approval(ENTRY, 'alice', 'approve', undefined, 'ja maar alleen deze maand') });
    expect(other.data.problems.join()).toContain('different answer');
    const none = await call(token, 'process_entry', { draftId: ENTRY, approvalToken: approval(ENTRY, 'alice') });
    expect(none.data.problems.join()).toContain('approving answer');
  });
  it('refuses an entry the server did not draft', async () => {
    const { token } = await start();
    expect((await call(token, 'process_entry', { entry_id: ENTRY })).summary).toContain('not drafted by this server');
  });
  it('approve tier: refuses without a token, with the drafter as approver, then releases once', async () => {
    const { token, st } = await drafted();
    expect((await call(token, 'process_entry', { entry_id: ENTRY })).data.problems.join()).toContain('needs 1 approv');
    const self = await call(token, 'process_entry', { entry_id: ENTRY, answer: YES, approval_tokens: [approval(ENTRY, 'exact:a1b2c3d4-0000-0000-0000-000000000001')] });
    expect(self.data.problems.join()).toContain('drafter');
    const ok = await call(token, 'process_entry', { entry_id: ENTRY, answer: YES, approval_tokens: [approval(ENTRY, 'alice')] });
    expect(ok.isError).toBe(false);
    expect(ok.data).toMatchObject({ tier: 'approve', approvers: ['alice'], status: 'approved' });
    expect(st.puts).toEqual([]);
    expect((await call(token, 'process_entry', { entry_id: ENTRY, answer: YES, approval_tokens: [approval(ENTRY, 'alice')] })).summary).toContain('already approved');
  });
  it('refuses expired tokens and tokens for another entry', async () => {
    const { token } = await drafted();
    expect((await call(token, 'process_entry', { entry_id: ENTRY, answer: YES, approval_tokens: [approval(ENTRY, 'alice', 'approve', T0 / 1000 - 1)] })).data.problems.join()).toContain('expired');
    expect((await call(token, 'process_entry', { entry_id: ENTRY, answer: YES, approval_tokens: [approval(ENTRY2, 'alice')] })).data.problems.join()).toContain('another draft');
    expect((await call(token, 'process_entry', { entry_id: ENTRY, answer: YES, approval_tokens: ['not-a-token-at-all'] })).data.problems.join()).toContain('not a valid');
  });
  it('two-step tier needs two approvers', async () => {
    const { token } = await drafted({}, purchase({ totals: { net: 5000, vat: 1050, gross: 6050 }, lines: [{ gl_account_id: GL_COST, amount: 5000, vat_code: '2' }] }));
    expect((await call(token, 'process_entry', { entry_id: ENTRY, answer: YES, approval_tokens: [approval(ENTRY, 'alice', 'two_step')] })).summary).toContain('REFUSED');
    expect((await call(token, 'process_entry', { entry_id: ENTRY, answer: YES, approval_tokens: [approval(ENTRY, 'alice'), approval(ENTRY, 'bob')] })).summary).toContain('REFUSED');
    const ok = await call(token, 'process_entry', { entry_id: ENTRY, answer: YES, approval_tokens: [approval(ENTRY, 'alice', 'two_step'), approval(ENTRY, 'bob', 'two_step')] });
    expect(ok.data).toMatchObject({ tier: 'two-step', approvers: ['alice', 'bob'] });
  });
  it('auto tier: held for 24 h, then released without a token', async () => {
    const { token } = await start();
    for (let i = 1; i <= 3; i++) {
      const id = await ledger.reserve({ division: 100, kind: 'purchase', supplierId: SUPPLIER, refNorm: `OLD${i}`, journal: '60', entryDate: `2026-0${i}-01`, currency: 'EUR', amountCents: i, pdfSha256: null, tier: 'approve', tierReasons: [], createdBy: 'x', createdAt: new Date(T0), holdUntil: null });
      await ledger.markDrafted(id, `00000000-0000-0000-0000-00000000000${i}`, i);
      await ledger.markReleased(id, 'approved', ['alice'], new Date(T0));
    }
    await call(token, 'draft_purchase_entry', { ...purchase(), dry_run: false });
    expect((await call(token, 'process_entry', { entry_id: ENTRY })).summary).toContain('held until');
    // the broker token lives one hour, so the hold ends by moving the row instead of the clock
    await ledger.pool.query('UPDATE ledger SET hold_until = $1 WHERE exact_entry_id = $2', [new Date(T0 - 1).toISOString(), ENTRY]);
    expect((await call(token, 'process_entry', { entry_id: ENTRY })).data).toMatchObject({ tier: 'auto', status: 'approved' });
  });
  it('refuses when the entry is no longer open in Exact', async () => {
    const { token, st } = await drafted();
    st.status = 50;
    expect((await call(token, 'process_entry', { entry_id: ENTRY, answer: YES, approval_tokens: [approval(ENTRY, 'alice')] })).summary).toContain('processed in Exact');
  });
  it('api mode sets Status 50 on a purchase entry', async () => {
    const { token, st } = await drafted({ EXACT_PROCESS_MODE: 'api' });
    const r = await call(token, 'process_entry', { entry_id: ENTRY, answer: YES, approval_tokens: [approval(ENTRY, 'alice')] });
    expect(r.data.status).toBe('processed');
    expect(st.puts).toEqual([{ path: expect.stringContaining(ENTRY), body: { Status: 50 } }]);
  });
});

describe('create_matchset', () => {
  const ms = { gl_account_code: '1600', account_code: 'S001', lines: [{ fin_year: 2026, fin_period: 11, journal: '20', entry_number: 26200003, amount_dc: -121 }, { fin_year: 2026, fin_period: 11, journal: '60', entry_number: 26600001, amount_dc: 121 }] };
  it('dry run returns the XML and id; the upload needs two approvals', async () => {
    const { token, st } = await start({ ENABLE_MATCHSETS: 'true' });
    const dry = await call(token, 'create_matchset', ms);
    expect(dry.data.xml).toContain('<MatchLine finyear="2026" finperiod="11" journal="20" entry="26200003" amountdc="-121.00" />');
    const id = `matchset:${dry.data.matchset_id}`;
    expect((await call(token, 'create_matchset', { ...ms, dry_run: false, answer: YES, approval_tokens: [approval(id, 'alice', 'two_step')] })).summary).toContain('REFUSED');
    const ok = await call(token, 'create_matchset', { ...ms, dry_run: false, answer: YES, approval_tokens: [approval(id, 'alice', 'two_step'), approval(id, 'bob', 'two_step')] });
    expect(ok.isError).toBe(false);
    expect(st.xml).toHaveLength(1);
  });
  it('answers the approval contract on the dry run and uploads a match set once', async () => {
    const { token, st } = await start({ ENABLE_MATCHSETS: 'true' });
    const dry = await call(token, 'create_matchset', ms);
    expect(dry.data).toMatchObject({ approvalRequired: true, tier: 'two-step', draftId: `matchset:${dry.data.matchset_id}` });
    const args = { ...ms, dry_run: false, draftId: dry.data.draftId, answer: YES, approval_tokens: [approval(dry.data.draftId, 'alice', 'two_step'), approval(dry.data.draftId, 'bob', 'two_step')] };
    expect((await call(token, 'create_matchset', args)).isError).toBe(false);
    expect((await call(token, 'create_matchset', args)).summary).toContain('already uploaded');
    expect(st.xml).toHaveLength(1);
  });
  it.each([
    ['an error message', '<Messages><Message type="0"><Description>Boeking niet gevonden</Description></Message></Messages>'],
    ['a fatal message', '<Messages><Message type="2"><Description>ok</Description></Message><Message type="3"><Description>Fatal</Description></Message></Messages>'],
    ['no success message', '<Messages><Message type="1"><Description>Warning</Description></Message></Messages>'],
  ])('fails on HTTP 200 with %s', async (_n, body) => {
    const { token } = await start({ ENABLE_MATCHSETS: 'true' });
    env.fake.on((url) => (url.pathname === '/docs/XMLUpload.aspx' ? new Response(`<?xml version="1.0"?><eExact>${body}</eExact>`, { status: 200 }) : undefined));
    const dry = await call(token, 'create_matchset', ms);
    const r = await call(token, 'create_matchset', { ...ms, dry_run: false, answer: YES, approval_tokens: [approval(dry.data.draftId, 'alice', 'two_step'), approval(dry.data.draftId, 'bob', 'two_step')] });
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('did not create the match set');
  });
  it('refuses a draftId that does not match the lines', async () => {
    const { token } = await start({ ENABLE_MATCHSETS: 'true' });
    const r = await call(token, 'create_matchset', { ...ms, dry_run: false, draftId: `matchset:${'0'.repeat(64)}`, answer: YES, approval_tokens: [] });
    expect(r.summary).toContain('does not match');
  });
  it('refuses amounts that do not cancel out', async () => {
    const { token } = await start({ ENABLE_MATCHSETS: 'true' });
    const r = await call(token, 'create_matchset', { ...ms, lines: [ms.lines[0], { ...ms.lines[1], amount_dc: 120 }] });
    expect(r.summary).toContain('REFUSED');
  });
});

describe('audit log', () => {
  it('records every tool call with caller and model version, never the arguments', async () => {
    const { token } = await start();
    await fetch(`${env.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'x-model-version': 'model-x-1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
    });
    await call(token, 'list_vat_codes', { query: 'secret-looking-value' });
    const { rows } = await ledger.pool.query('SELECT * FROM audit_log ORDER BY id');
    expect(rows.map((r: any) => r.tool)).toEqual(['whoami', 'list_vat_codes']);
    expect(rows[0]).toMatchObject({ model_version: 'model-x-1', outcome: 'ok', caller_kind: 'human', exact_status: 200, division: 100 });
    expect(JSON.stringify(rows)).not.toContain('secret-looking-value');
  });
  it('records refusals', async () => {
    const { token } = await start();
    await call(token, 'process_entry', { entry_id: ENTRY });
    const { rows } = await ledger.pool.query(`SELECT outcome FROM audit_log WHERE tool = 'process_entry'`);
    expect(rows).toEqual([{ outcome: 'refused' }]);
  });
});
