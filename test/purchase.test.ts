import { afterEach, describe, expect, it } from 'vitest';
import { callTool, getTokens, json, mcpCall, odata, parseResult, startApp, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.close());

async function login(over: Record<string, string> = {}) {
  env = await startApp(over);
  env.fake.withLogin();
  const { tokens } = await getTokens(env);
  return tokens.access_token as string;
}
const SUPPLIER = '11111111-1111-1111-1111-111111111111';
const GL = '22222222-2222-2222-2222-222222222222';
const ENTRY = '33333333-3333-3333-3333-333333333333';
const DOC = '44444444-4444-4444-4444-444444444444';
const PDF = Buffer.from('%PDF-1.7\n%test\n').toString('base64');
const draftArgs = { supplier_id: SUPPLIER, journal: '60', your_ref: 'INV-1', entry_date: '2026-11-01', description: 'Hosting november', lines: [{ gl_account_id: GL, amount: 100, vat_code: '2' }] };

describe('WRITE_TOOLS', () => {
  it('registers only the named write tools', async () => {
    const token = await login({ WRITE_TOOLS: 'draft_purchase_entry,attach_document' });
    const names = ((await mcpCall(env, token, 'tools/list')).body.result.tools as any[]).map((t) => t.name);
    expect(names).toContain('draft_purchase_entry');
    expect(names).toContain('attach_document');
    expect(names).toContain('list_bank_transaction_lines');
    expect(names).toContain('list_vat_codes');
    expect(names).not.toContain('create_sales_invoice');
  });
  it('refuses an unknown write tool name', async () => {
    await expect(startApp({ WRITE_TOOLS: 'process_entry' })).rejects.toThrow(/WRITE_TOOLS/);
  });
});

describe('draft_purchase_entry', () => {
  it('dry run posts nothing and shows the payload', async () => {
    const token = await login({ WRITE_TOOLS: 'draft_purchase_entry' });
    env.fake.on((url) => (url.pathname.endsWith('/purchaseentry/PurchaseEntries') ? odata([]) : undefined));
    const r = parseResult((await callTool(env, token, 'draft_purchase_entry', draftArgs)).body);
    expect(r.summary).toContain('DRY RUN');
    expect(r.data.payload).toMatchObject({ Journal: '60', Supplier: SUPPLIER, YourRef: 'INV-1', Type: 30, PurchaseEntryLines: [{ GLAccount: GL, AmountFC: 100, VATCode: '2' }] });
    expect(env.fake.calls.some((c) => c.init.method === 'POST' && c.url.pathname.includes('/api/v1/'))).toBe(false);
  });
  it('refuses a duplicate supplier invoice number', async () => {
    const token = await login({ WRITE_TOOLS: 'draft_purchase_entry' });
    env.fake.on((url, init) => (url.pathname.endsWith('/purchaseentry/PurchaseEntries') && !init.method?.startsWith('P') ? odata([{ EntryID: ENTRY, EntryNumber: 7, Status: 20, YourRef: 'INV-1' }]) : undefined));
    const r = parseResult((await callTool(env, token, 'draft_purchase_entry', { ...draftArgs, dry_run: false })).body);
    expect(r.summary).toContain('REFUSED');
    expect(r.data.existing[0].id).toBe(ENTRY);
  });
  it('creates the entry and reports its status', async () => {
    const token = await login({ WRITE_TOOLS: 'draft_purchase_entry' });
    env.fake.on((url, init) => {
      if (!url.pathname.endsWith('/purchaseentry/PurchaseEntries')) return undefined;
      if (init.method === 'POST') return json({ d: { EntryID: ENTRY, EntryNumber: 8, Status: 20 } }, 201);
      return odata([]);
    });
    const r = parseResult((await callTool(env, token, 'draft_purchase_entry', { ...draftArgs, dry_run: false })).body);
    expect(r.summary).toContain('status open');
    expect(r.data.id).toBe(ENTRY);
    expect(env.store.db.prepare('SELECT tool FROM audit_log').all()).toEqual([{ tool: 'draft_purchase_entry' }]);
  });
});

describe('attach_document', () => {
  it('creates a document, uploads the file and links it to the entry', async () => {
    const token = await login({ WRITE_TOOLS: 'attach_document' });
    const seen: string[] = [];
    env.fake.on((url, init) => {
      const p = url.pathname;
      if (p.includes(`PurchaseEntries(guid'${ENTRY}')`)) {
        seen.push(`${init.method ?? 'GET'} entry`);
        return init.method === 'PUT' ? new Response(null, { status: 204 }) : json({ d: { EntryID: ENTRY, EntryNumber: 8, Supplier: SUPPLIER, SupplierName: 'Acme', YourRef: 'INV-1', Status: 20, EntryDate: '/Date(1761955200000)/' } });
      }
      if (p.endsWith('/documents/Documents')) { seen.push('POST document'); return json({ d: { ID: DOC } }, 201); }
      if (p.endsWith('/documents/DocumentAttachments')) {
        const b = JSON.parse(String(init.body));
        expect(b).toMatchObject({ Document: DOC, FileName: 'inv.pdf', Attachment: PDF });
        seen.push('POST attachment');
        return json({ d: { ID: 'att' } }, 201);
      }
      return undefined;
    });
    const r = parseResult((await callTool(env, token, 'attach_document', { entry_id: ENTRY, file_name: 'inv.pdf', content_base64: PDF, dry_run: false })).body);
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ document_id: DOC, linked: true });
    expect(seen).toEqual(['GET entry', 'POST document', 'POST attachment', 'PUT entry']);
  });
  it('rejects content that is not a PDF', async () => {
    const token = await login({ WRITE_TOOLS: 'attach_document' });
    env.fake.on((url) => (url.pathname.includes('PurchaseEntries(') ? json({ d: { EntryID: ENTRY, EntryNumber: 8, Status: 20 } }) : undefined));
    const r = parseResult((await callTool(env, token, 'attach_document', { entry_id: ENTRY, file_name: 'inv.pdf', content_base64: Buffer.from('hello').toString('base64') })).body);
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('not a PDF');
  });
});

describe('read tools', () => {
  it('list_vat_codes filters purchase codes and maps the type', async () => {
    const token = await login();
    env.fake.on((url) => {
      if (!url.pathname.endsWith('/vat/VATCodes')) return undefined;
      expect(url.searchParams.get('$filter')).toContain("VATTransactionType eq 'P'");
      return odata([{ ID: 'v', Code: '2  ', Description: 'Hoog', Percentage: 0.21, Type: 'E', VATTransactionType: 'B' }]);
    });
    const r = parseResult((await callTool(env, token, 'list_vat_codes', { use: 'purchase' })).body);
    expect(r.data[0]).toMatchObject({ code: '2', type: 'excluding', use: 'both' });
  });
  it('list_bank_transaction_lines needs a date range and filters on it', async () => {
    const token = await login();
    env.fake.on((url) => {
      if (!url.pathname.endsWith('/financialtransaction/BankEntryLines')) return undefined;
      expect(url.searchParams.get('$filter')).toContain("Date ge datetime'2026-10-01'");
      return odata([{ ID: 'b', Date: '/Date(1761955200000)/', AmountDC: -121, AmountFC: -121, Description: 'Acme INV-1' }]);
    });
    const r = parseResult((await callTool(env, token, 'list_bank_transaction_lines', { date_from: '2026-10-01', date_to: '2026-11-30' })).body);
    expect(r.data.lines[0]).toMatchObject({ amount_dc: -121, date: '2025-11-01' });
  });
});
