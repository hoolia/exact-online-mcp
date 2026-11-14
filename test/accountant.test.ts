import { afterEach, describe, expect, it } from 'vitest';
import { callTool, getTokens, json, odata, parseResult, startApp, type TestEnv } from './helpers.js';
import { memStore } from './pgmem.js';
import { collectionRows } from '../src/exact/client.js';
import { ibanValid } from '../src/tools/accounts.js';

// synthetic fixtures only
const CUSTOMER = '55555555-5555-5555-5555-555555555555';
const GL_REVENUE = '66666666-6666-6666-6666-666666666661';
const ENTRY = '77777777-7777-7777-7777-777777777777';
const DOC = '88888888-8888-8888-8888-888888888888';
const ATT = '99999999-9999-9999-9999-999999999999';

let env: TestEnv;
afterEach(() => env?.close());

async function login(over: Record<string, string> = {}, ledger = false) {
  env = await startApp(over, undefined, ledger ? { ledger: await memStore() } : {});
  env.fake.withLogin({ division: 100 });
  return (await getTokens(env)).tokens.access_token as string;
}

/** Exact answers a query with $top as a bare array. */
const bare = (rows: unknown[]) => json({ d: rows });

describe('collection responses', () => {
  it('reads both collection shapes and a single entity', () => {
    expect(collectionRows({ d: [{ A: 1 }, { A: 2 }] })).toHaveLength(2);
    expect(collectionRows({ d: { results: [{ A: 1 }] } })).toEqual([{ A: 1 }]);
    expect(collectionRows({ d: [] })).toEqual([]);
    expect(collectionRows({ d: { A: 1 } })).toEqual([{ A: 1 }]);
  });

  it('list_purchase_entries returns the rows of a bare-array answer', async () => {
    const token = await login();
    env.fake.on((url) => {
      if (!url.pathname.endsWith('/purchaseentry/PurchaseEntries')) return undefined;
      expect(url.searchParams.get('$top')).toBe('3');
      return bare([
        { EntryID: ENTRY, EntryNumber: 26600096, SupplierName: 'Acme', AmountFC: -81, Currency: 'EUR', Status: 20, Type: 30, YourRef: 'X1', EntryDate: '/Date(1793404800000)/' },
        { EntryID: DOC, EntryNumber: 26600095, SupplierName: 'Beta', AmountFC: -19, Currency: 'EUR', Status: 50, Type: 30, YourRef: 'X2' },
      ]);
    });
    const r = parseResult((await callTool(env, token, 'list_purchase_entries', { top: 3 })).body);
    expect(r.summary).toContain('Found 2 purchase entries');
    expect(r.data.entries.map((e: any) => [e.supplier_name, e.status])).toEqual([['Acme', 'open'], ['Beta', 'processed']]);
  });

  it('whoami reports the division the tools use', async () => {
    const token = await login();
    const r = parseResult((await callTool(env, token, 'whoami')).body);
    expect(r.data).toMatchObject({ default_division: 100, exact_web_division: 100 });
  });
});

describe('balances', () => {
  const gl = [
    { ID: 'g1', Code: '1000', Description: 'Bank', BalanceType: 'B', TypeDescription: 'Bank' },
    { ID: 'g2', Code: '1600', Description: 'Creditors', BalanceType: 'B', TypeDescription: 'Accounts payable' },
    { ID: 'g3', Code: '0500', Description: 'Equity', BalanceType: 'B', TypeDescription: 'Equity' },
    { ID: 'g4', Code: '4000', Description: 'Costs', BalanceType: 'W', TypeDescription: 'Costs' },
    { ID: 'g5', Code: '8000', Description: 'Revenue', BalanceType: 'W', TypeDescription: 'Revenue' },
  ];
  // 2025: equity 1000 in the bank, revenue 500 received. 2026: costs 200 on credit, 100 paid; a period 12 line is outside period 11
  const prior = [{ GLAccountCode: '1000', AmountDC: 1500 }, { GLAccountCode: '0500', AmountDC: -1000 }, { GLAccountCode: '8000', AmountDC: -500 }];
  const current = [
    { GLAccountCode: '4000', AmountDC: 200, FinancialPeriod: 3 }, { GLAccountCode: '1600', AmountDC: -200, FinancialPeriod: 3 },
    { GLAccountCode: '1600', AmountDC: 100, FinancialPeriod: 4 }, { GLAccountCode: '1000', AmountDC: -100, FinancialPeriod: 4 },
    { GLAccountCode: '1000', AmountDC: 999, FinancialPeriod: 12 }, { GLAccountCode: '8000', AmountDC: -999, FinancialPeriod: 12 },
  ];
  function fake() {
    env.fake.on((url) => {
      const p = url.pathname;
      if (p.endsWith('/financial/GLAccounts')) return odata(gl);
      if (p.endsWith('/financial/FinancialPeriods')) return bare([{ FinYear: 2026, FinPeriod: 11 }]);
      if (p.endsWith('/bulk/Financial/TransactionLines')) {
        const f = url.searchParams.get('$filter') ?? '';
        if (f.startsWith('FinancialYear lt 2026')) return odata(prior);
        if (f.startsWith('FinancialYear eq 2026')) return odata(current);
      }
      return undefined;
    });
  }

  it('get_trial_balance carries balance accounts forward and balances', async () => {
    const token = await login();
    fake();
    const r = parseResult((await callTool(env, token, 'get_trial_balance', {})).body);
    expect(r.data).toMatchObject({ year: 2026, period: 11, result_earlier_years: -500, totals: { debit: 300, credit: 300, closing_sum: 0 } });
    const bank = r.data.accounts.find((x: any) => x.code === '1000');
    expect(bank).toMatchObject({ opening: 1500, credit: 100, closing: 1400 });
    expect(r.data.accounts.find((x: any) => x.code === '8000')).toBeUndefined();
  });

  it('get_balance_sheet totals equal with the results', async () => {
    const token = await login();
    fake();
    const r = parseResult((await callTool(env, token, 'get_balance_sheet', { year: 2026, period: 11 })).body);
    expect(r.data).toMatchObject({ total_debit: 1400, total_credit: 1100, result_earlier_years: 500, result_current_year: -200, difference: 0 });
    expect(r.data.categories).toMatchObject({ Bank: 1400, 'Accounts payable': -100, Equity: -1000 });
  });
});

describe('entries and documents', () => {
  it('get_document downloads an Exact attachment', async () => {
    const token = await login();
    const pdf = Buffer.from('%PDF-1.7\n%synthetic\n');
    env.fake.on((url) => {
      if (url.pathname.endsWith(`/documents/Documents(guid'${DOC}')`)) return json({ d: { ID: DOC, Subject: 'Invoice', Type: 20, TypeDescription: 'Purchase invoice' } });
      if (url.pathname.endsWith('/documents/DocumentAttachments')) return bare([{ ID: ATT, FileName: 'inv.pdf', FileSize: pdf.length, Url: `https://start.exactonline.nl/docs/SysAttachment.aspx?ID=${ATT}` }]);
      if (url.pathname === '/docs/SysAttachment.aspx') return new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } });
      return undefined;
    });
    const r = parseResult((await callTool(env, token, 'get_document', { document_id: DOC, download_attachment_id: ATT })).body);
    expect(Buffer.from(r.data.download.content_base64, 'base64').equals(pdf)).toBe(true);
  });

  it('get_document refuses an attachment URL outside Exact', async () => {
    const token = await login();
    env.fake.on((url) => {
      if (url.pathname.endsWith(`/documents/Documents(guid'${DOC}')`)) return json({ d: { ID: DOC, Subject: 'Invoice' } });
      if (url.pathname.endsWith('/documents/DocumentAttachments')) return bare([{ ID: ATT, FileName: 'inv.pdf', Url: 'https://evil.example/x' }]);
      return undefined;
    });
    const r = parseResult((await callTool(env, token, 'get_document', { document_id: DOC, download_attachment_id: ATT })).body);
    expect(r.isError).toBe(true);
    expect(env.fake.calls.some((c) => c.url.host === 'evil.example')).toBe(false);
  });

  it('query_exact passes select and filter, and refuses a path outside the division', async () => {
    const token = await login();
    env.fake.on((url) => {
      if (!url.pathname.endsWith('/100/cashflow/Payments')) return undefined;
      expect(url.searchParams.get('$filter')).toBe("Status eq 20");
      return bare([{ ID: 'p', AmountDC: 10 }]);
    });
    const ok = parseResult((await callTool(env, token, 'query_exact', { resource: 'cashflow/Payments', select: ['ID', 'AmountDC'], filter: 'Status eq 20', top: 10 })).body);
    expect(ok.data.rows).toEqual([{ ID: 'p', AmountDC: 10 }]);
    const bad = (await callTool(env, token, 'query_exact', { resource: '../current/Me', select: ['ID'] })).body;
    expect(JSON.stringify(bad)).toMatch(/area\/Resource|Invalid|error/i);
  });
});

describe('accountant write tools', () => {
  it('create_account refuses a duplicate VAT number and creates with IBAN', async () => {
    const token = await login({ ENABLE_WRITE_TOOLS: 'true' });
    const posted: { path: string; body: any }[] = [];
    let existing = true;
    env.fake.on((url, init) => {
      const p = url.pathname;
      if (p.endsWith('/crm/Accounts') && (init.method ?? 'GET') === 'GET') {
        expect(url.searchParams.get('$filter')).toContain("VATNumber eq 'NL123456789B01'");
        return bare(existing ? [{ ID: CUSTOMER, Code: '  42', Name: 'Acme BV', IsSupplier: true }] : []);
      }
      if (p.endsWith('/crm/Accounts')) { posted.push({ path: 'Accounts', body: JSON.parse(String(init.body)) }); return json({ d: { ID: CUSTOMER, Code: '  43' } }, 201); }
      if (p.endsWith('/crm/BankAccounts') && (init.method ?? 'GET') === 'GET') return bare([]);
      if (p.endsWith('/crm/BankAccounts')) { posted.push({ path: 'BankAccounts', body: JSON.parse(String(init.body)) }); return json({ d: { ID: 'b' } }, 201); }
      return undefined;
    });
    const args = { name: 'Acme BV', vat_number: 'nl 1234.56789B01', iban: 'NL91 ABNA 0417 1643 00' };
    const dup = parseResult((await callTool(env, token, 'create_account', { ...args, dry_run: false })).body);
    expect(dup.data).toMatchObject({ refused: true, duplicate: true });
    expect(posted).toEqual([]);
    existing = false;
    const r = parseResult((await callTool(env, token, 'create_account', { ...args, dry_run: false })).body);
    expect(r.data).toMatchObject({ id: CUSTOMER, code: '43', bank_account_id: 'b' });
    expect(posted[0]!.body).toMatchObject({ Name: 'Acme BV', VATNumber: 'NL123456789B01', IsSupplier: true });
    expect(posted[1]!.body).toMatchObject({ Account: CUSTOMER, BankAccount: 'NL91ABNA0417164300', Main: true });
  });

  it('ibanValid checks the mod-97 digits', () => {
    expect(ibanValid('NL91ABNA0417164300')).toBe(true);
    expect(ibanValid('NL92ABNA0417164300')).toBe(false);
  });

  it('update_account refuses an extra IBAN for a relation that has one, and an IBAN with wrong digits', async () => {
    const token = await login({ ENABLE_WRITE_TOOLS: 'true' });
    const posted: string[] = [];
    env.fake.on((url, init) => {
      const p = url.pathname;
      const method = init.method ?? 'GET';
      if (p.endsWith(`/crm/Accounts(guid'${CUSTOMER}')`) && method === 'GET') return json({ d: { ID: CUSTOMER, Name: 'Acme BV', Status: 'P', IsSupplier: true } });
      if (p.endsWith('/crm/BankAccounts') && method === 'GET') return bare([{ ID: 'b', BankAccount: 'NL02ABNA0123456789' }]);
      if (method !== 'GET') { posted.push(`${method} ${p}`); return json({ d: {} }, 201); }
      return undefined;
    });
    const extra = parseResult((await callTool(env, token, 'update_account', { account_id: CUSTOMER, add_iban: 'NL91ABNA0417164300', dry_run: false })).body);
    expect(extra.data).toMatchObject({ refused: true, existing_bank_accounts: ['NL02ABNA0123456789'] });
    const bad = parseResult((await callTool(env, token, 'update_account', { account_id: CUSTOMER, add_iban: 'NL92ABNA0417164300', dry_run: false })).body);
    expect(bad.isError).toBe(true);
    // customer=false leaves a prospect a prospect
    const r = parseResult((await callTool(env, token, 'update_account', { account_id: CUSTOMER, customer: false, city: 'Arnhem' })).body);
    expect(r.data.after).toEqual({ City: 'Arnhem' });
    expect(posted).toEqual([]);
  });

  it('draft_sales_entry checks, posts a Type 20 sales entry and refuses an Exact duplicate', async () => {
    const token = await login({ ENABLE_WRITE_TOOLS: 'true' }, true);
    const posted: any[] = [];
    let dup = false;
    env.fake.on((url, init) => {
      const p = url.pathname;
      const method = init.method ?? 'GET';
      if (p.endsWith('/vat/VATCodes')) return odata([{ Code: '2  ', Percentage: 0.21, IsBlocked: false, VATTransactionType: 'S' }]);
      if (p.endsWith('/financial/GLAccounts')) return bare([{ ID: GL_REVENUE, Code: '8000', BalanceType: 'W' }]);
      if (p.endsWith('/salesentry/SalesEntries') && method === 'GET') return bare(dup ? [{ EntryID: ENTRY, EntryNumber: 7, Status: 20, YourRef: 'SB-1' }] : []);
      if (p.endsWith('/salesentry/SalesEntries') && method === 'POST') { posted.push(JSON.parse(String(init.body))); return json({ d: { EntryID: ENTRY, EntryNumber: 8, Status: 20 } }, 201); }
      return undefined;
    });
    const args = {
      customer_id: CUSTOMER, journal: '70', your_ref: 'SB-1', entry_date: '2026-11-13', description: { supplier: 'Acme', period: '2026-10', short: 'detachering' },
      totals: { net: 4100, vat: 861, gross: 4961 }, lines: [{ gl_account_id: GL_REVENUE, amount: 4100, vat_code: '2' }],
    };
    const dry = parseResult((await callTool(env, token, 'draft_sales_entry', args)).body);
    expect(dry.data).toMatchObject({ dry_run: true, tier: 'approve' });
    expect(dry.data.checks.every((c: any) => c.ok)).toBe(true);
    const r = parseResult((await callTool(env, token, 'draft_sales_entry', { ...args, dry_run: false })).body);
    expect(r.data).toMatchObject({ approvalRequired: true, draftId: ENTRY, entry_number: 8 });
    expect(posted[0]).toMatchObject({ Journal: '70', Customer: CUSTOMER, Type: 20, SalesEntryLines: [{ GLAccount: GL_REVENUE, AmountFC: 4100, VATCode: '2' }] });
    dup = true;
    const again = parseResult((await callTool(env, token, 'draft_sales_entry', { ...args, your_ref: 'SB-1', dry_run: false })).body);
    expect(again.data).toMatchObject({ refused: true, duplicate: true });
    expect(posted).toHaveLength(1);
  });

  it('draft_sales_entry files the source document as a sales invoice', async () => {
    const token = await login({ ENABLE_WRITE_TOOLS: 'true' }, true);
    const docs: any[] = [];
    env.fake.on((url, init) => {
      const p = url.pathname;
      const method = init.method ?? 'GET';
      if (p.endsWith('/vat/VATCodes')) return odata([{ Code: '2  ', Percentage: 0.21, IsBlocked: false, VATTransactionType: 'S' }]);
      if (p.endsWith('/financial/GLAccounts')) return bare([{ ID: GL_REVENUE, Code: '8000', BalanceType: 'W' }]);
      if (p.endsWith('/salesentry/SalesEntries') && method === 'GET') return bare([]);
      if (p.endsWith('/salesentry/SalesEntries')) return json({ d: { EntryID: ENTRY, EntryNumber: 9, Status: 20 } }, 201);
      if (p.endsWith('/documents/Documents')) { docs.push(JSON.parse(String(init.body))); return json({ d: { ID: DOC } }, 201); }
      if (p.endsWith('/documents/DocumentAttachments')) return json({ d: { ID: ATT } }, 201);
      return undefined;
    });
    const pdf = Buffer.from('%PDF-1.7\n%synthetic\n').toString('base64');
    const r = parseResult((await callTool(env, token, 'draft_sales_entry', {
      customer_id: CUSTOMER, journal: '70', your_ref: 'SB-2', entry_date: '2026-11-13', description: { supplier: 'Acme', period: '2026-10', short: 'detachering' },
      totals: { net: 100, vat: 21, gross: 121 }, lines: [{ gl_account_id: GL_REVENUE, amount: 100, vat_code: '2' }],
      file: { file_name: 'sb-2.pdf', content_base64: pdf }, dry_run: false,
    })).body);
    expect(r.data).toMatchObject({ document_id: DOC });
    expect(docs[0]).toMatchObject({ Type: 10, Account: CUSTOMER });
  });
});
