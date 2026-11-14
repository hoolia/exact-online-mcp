import { afterEach, describe, expect, it } from 'vitest';
import { callTool, getTokens, json, mcpCall, odata, parseResult, startApp, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.close());

async function login(over: Record<string, string> = {}, loginOpts: Parameters<TestEnv['fake']['withLogin']>[0] = {}) {
  env = await startApp(over);
  env.fake.withLogin(loginOpts);
  const { tokens } = await getTokens(env);
  return tokens.access_token as string;
}
const apiCalls = () => env.fake.calls.filter((c) => c.url.pathname.startsWith('/api/v1/') && !c.url.pathname.includes('current/Me'));

describe('Exact token handling', () => {
  it('two parallel tool calls at token expiry refresh exactly once', async () => {
    const token = await login({}, { expiresIn: 10, refreshExpiresIn: 600 });
    const [a, b] = await Promise.all([callTool(env, token, 'whoami'), callTool(env, token, 'whoami')]);
    expect(parseResult(a.body).isError).toBe(false);
    expect(parseResult(b.body).isError).toBe(false);
    expect(env.fake.refreshCount).toBe(1);
    const meAuth = env.fake.calls.filter((c) => c.url.pathname === '/api/v1/current/Me').map((c) => (c.init.headers as any).authorization);
    // login Me call used the first token; both tool calls used the refreshed one
    expect(new Set(meAuth.slice(1)).size).toBe(1);
  });

  it('persists the rotated refresh token before use', async () => {
    const token = await login({}, { expiresIn: 10 });
    const before = env.store.getExactTokens(1)!.refreshToken;
    await callTool(env, token, 'whoami');
    expect(env.store.getExactTokens(1)!.refreshToken).not.toBe(before);
  });

  it('tells the user to reconnect when Exact rejects the refresh', async () => {
    const token = await login({}, { expiresIn: 10 });
    env.fake.on((url) => (url.pathname === '/api/oauth2/token' ? json({ error: 'invalid_grant' }, 400) : undefined));
    const r = parseResult((await callTool(env, token, 'whoami')).body);
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('Please reconnect the connector');
    expect(env.store.getUser(1)!.disconnected).toBe(true);
    // subsequent calls keep returning the same message without hitting Exact again
    expect(parseResult((await callTool(env, token, 'whoami')).body).summary).toContain('reconnect');
  });
});

describe('Exact client', () => {
  it('follows __next pagination, caps rows, converts dates and sends $select', async () => {
    const token = await login();
    env.fake.on((url) => {
      if (!url.pathname.endsWith('/salesinvoice/SalesInvoices')) return undefined;
      if (!url.searchParams.has('page')) {
        expect(url.searchParams.get('$select')).toContain('InvoiceID');
        return odata([{ InvoiceID: 'g1', InvoiceNumber: 1, InvoiceDate: '/Date(1700000000000)/', Status: 20, Currency: 'EUR', AmountFC: 100 }], `${url.origin}${url.pathname}?page=2`);
      }
      return odata([{ InvoiceID: 'g2', InvoiceNumber: 2, InvoiceDate: '/Date(1700086400000)/', Status: 50, Currency: 'EUR', AmountFC: 50.5 }]);
    });
    const r = parseResult((await callTool(env, token, 'list_sales_invoices', { top: 10 })).body);
    expect(r.data.invoices).toHaveLength(2);
    expect(r.data.invoices[0].invoice_date).toBe('2023-11-14');
    expect(r.summary).toContain('EUR 150,50');
    const capped = parseResult((await callTool(env, token, 'list_sales_invoices', { top: 1 })).body);
    expect(capped.data.invoices).toHaveLength(1);
    expect(capped.data.truncated).toBe(true);
  });

  it('retries a short minutely rate limit and then succeeds', async () => {
    const token = await login();
    let n = 0;
    env.fake.on((url) => {
      if (!url.pathname.endsWith('/logistics/Items')) return undefined;
      if (n++ === 0) return json({}, 429, { 'x-ratelimit-minutely-reset': String(Date.now() + 2000), 'x-ratelimit-minutely-remaining': '0' });
      return odata([{ ID: 'i1', Code: 'A1', Description: 'Thing' }]);
    });
    const r = parseResult((await callTool(env, token, 'search_items', { query: 'Thing' })).body);
    expect(r.isError).toBe(false);
    expect(r.data[0].code).toBe('A1');
  });

  it('returns a readable message for a long rate limit instead of hanging', async () => {
    const token = await login();
    env.fake.on((url) => url.pathname.endsWith('/logistics/Items') ? json({}, 429, { 'x-ratelimit-minutely-reset': String(Date.now() + 45_000) }) : undefined);
    const r = parseResult((await callTool(env, token, 'search_items')).body);
    expect(r.isError).toBe(true);
    expect(r.summary).toMatch(/rate limit reached, try again in \d+ seconds/);
  });

  it('rejects divisions the user cannot access', async () => {
    const token = await login();
    env.fake.on((url) => url.pathname.endsWith('/system/Divisions') ? odata([{ Code: 100, Description: 'Main', Status: 1 }]) : undefined);
    const r = parseResult((await callTool(env, token, 'search_items', { division: 999 })).body);
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('not accessible');
  });

  it('maps Exact errors without leaking internals', async () => {
    const token = await login();
    env.fake.on((url) => url.pathname.endsWith('/crm/Accounts') ? json({ error: { message: { value: 'Bad field' } } }, 400) : undefined);
    const r = parseResult((await callTool(env, token, 'search_accounts', { query: 'x' })).body);
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('Bad field');
  });
});

describe('read tools', () => {
  it('lists tools with readOnlyHint and no write tools by default', async () => {
    const token = await login();
    const { body } = await mcpCall(env, token, 'tools/list');
    const tools = body.result.tools as any[];
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['whoami', 'list_divisions', 'search_accounts', 'get_account', 'list_open_receivables', 'list_open_payables', 'list_sales_invoices', 'get_sales_invoice', 'list_purchase_entries', 'search_items', 'list_gl_accounts', 'get_profit_and_loss', 'get_revenue_by_period', 'list_transactions']));
    expect(tools.every((t) => t.annotations.readOnlyHint === true)).toBe(true);
    expect(tools.some((t) => t.name.startsWith('create_'))).toBe(false);
  });

  it('computes ageing buckets and per-currency totals for receivables', async () => {
    const token = await login();
    const day = (n: number) => `/Date(${Date.now() - n * 86_400_000})/`;
    env.fake.on((url) => url.pathname.endsWith('/read/financial/ReceivablesList') ? odata([
      { Id: '1', AccountId: 'a1', AccountName: 'Acme', Amount: 1000.5, CurrencyCode: 'EUR', DueDate: day(45), InvoiceNumber: 1 },
      { Id: '2', AccountId: 'a1', AccountName: 'Acme', Amount: 200, CurrencyCode: 'EUR', DueDate: day(-5), InvoiceNumber: 2 },
      { Id: '3', AccountId: 'a2', AccountName: 'Beta', Amount: 50, CurrencyCode: 'USD', DueDate: day(100), InvoiceNumber: 3 },
    ]) : undefined);
    const r = parseResult((await callTool(env, token, 'list_open_receivables', { min_days_overdue: 30 })).body);
    expect(r.data.ageing.overdue_31_60).toEqual({ EUR: 1000.5 });
    expect(r.data.ageing.overdue_90_plus).toEqual({ USD: 50 });
    expect(r.data.ageing.not_due).toEqual({ EUR: 200 });
    expect(r.data.totals).toEqual({ EUR: 1200.5, USD: 50 });
    expect(r.summary).toContain('3 open receivable');
    expect(decodeURIComponent(apiCalls().at(-1)!.url.searchParams.get('$filter')!)).toMatch(/^DueDate lt datetime'\d{4}-\d{2}-\d{2}'$/);
  });

  it('compares P&L current vs previous year', async () => {
    const token = await login();
    env.fake.on((url) => url.pathname.endsWith('/ProfitLossOverview') ? odata([{ CurrentYear: 2026, PreviousYear: 2025, CurrencyCode: 'EUR', RevenueCurrentYear: 120, RevenuePreviousYear: 100, CostsCurrentYear: 80, CostsPreviousYear: 90, ResultCurrentYear: 40, ResultPreviousYear: 10 }]) : undefined);
    const r = parseResult((await callTool(env, token, 'get_profit_and_loss')).body);
    expect(r.data.year_to_date.revenue).toEqual({ current: 120, previous: 100, difference: 20, difference_pct: 20 });
    expect(r.data.year_to_date.result.difference).toBe(30);
  });

  it('escapes quotes in search filters', async () => {
    const token = await login();
    env.fake.on((url) => url.pathname.endsWith('/crm/Accounts') ? odata([]) : undefined);
    await callTool(env, token, 'search_accounts', { query: "O'Brien" });
    expect(decodeURIComponent(apiCalls().at(-1)!.url.searchParams.get('$filter')!)).toBe("substringof('O''Brien', Name) eq true");
  });

  it('requires a filter for transactions', async () => {
    const token = await login();
    const r = parseResult((await callTool(env, token, 'list_transactions', { date_from: '2026-01-01', date_to: '2026-01-31' })).body);
    expect(r.isError).toBe(true);
  });

  it('gets an invoice with its lines', async () => {
    const token = await login();
    const id = '11111111-1111-1111-1111-111111111111';
    env.fake.on((url) => {
      if (url.pathname.includes('SalesInvoiceLines')) return odata([{ LineNumber: 1, Description: 'Work', Quantity: 2, UnitPrice: 50, AmountFC: 100 }]);
      if (url.pathname.includes('SalesInvoices(')) return json({ d: { InvoiceID: id, InvoiceNumber: 7, OrderedByName: 'Acme', Currency: 'EUR', AmountFC: 100, Status: 20 } });
      return undefined;
    });
    const r = parseResult((await callTool(env, token, 'get_sales_invoice', { invoice_id: id })).body);
    expect(r.data.lines).toHaveLength(1);
    expect(r.summary).toContain('Invoice 7 for Acme');
  });
});

describe('write tools', () => {
  const customer = '22222222-2222-2222-2222-222222222222';
  const item = '33333333-3333-3333-3333-333333333333';

  it('dry-runs by default, posts only when dry_run=false, and audits', async () => {
    const token = await login({ ENABLE_WRITE_TOOLS: 'true' });
    const tools = ((await mcpCall(env, token, 'tools/list')).body.result.tools as any[]).filter((t) => t.name.startsWith('create_'));
    expect(tools.map((t) => t.name).sort()).toEqual(['create_account', 'create_quotation', 'create_sales_invoice', 'create_sales_order']);
    expect(tools.every((t) => t.annotations.destructiveHint === true)).toBe(true);

    env.fake.on((url, init) => url.pathname.endsWith('/salesorder/SalesOrders') && init.method === 'POST' ? json({ d: { OrderID: 'order-guid', OrderNumber: 42 } }, 201) : undefined);
    const args = { customer_id: customer, lines: [{ item_id: item, quantity: 2 }] };
    const dry = parseResult((await callTool(env, token, 'create_sales_order', args)).body);
    expect(dry.data.dry_run).toBe(true);
    expect(dry.data.payload.OrderedBy).toBe(customer);
    expect(env.fake.calls.some((c) => c.init.method === 'POST' && c.url.pathname.includes('SalesOrders'))).toBe(false);

    const real = parseResult((await callTool(env, token, 'create_sales_order', { ...args, dry_run: false })).body);
    expect(real.data.id).toBe('order-guid');
    const audit = env.store.db.prepare('SELECT * FROM audit_log').all() as any[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tool: 'create_sales_order', division: 100, exact_id: 'order-guid' });
    expect(audit[0].payload_hash).toHaveLength(64);
  });

  it('creates invoices as drafts', async () => {
    const token = await login({ ENABLE_WRITE_TOOLS: 'true' });
    const r = parseResult((await callTool(env, token, 'create_sales_invoice', { customer_id: customer, journal: '70', lines: [{ item_id: item, quantity: 1 }] })).body);
    expect(r.data.payload.Status).toBe(10);
  });
});
