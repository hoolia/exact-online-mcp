import { z } from 'zod';
import { defineTool } from './types.js';
import { divisionField, fmt, guidField, isoDate, readOnly, round2, todayIso, topField, totalsByCurrency, totalsText } from './common.js';
import { and, date, guid, str } from '../exact/odata.js';

const BUCKETS = ['not_due', 'overdue_1_30', 'overdue_31_60', 'overdue_61_90', 'overdue_90_plus'] as const;
const bucketOf = (days: number) => days <= 0 ? BUCKETS[0] : days <= 30 ? BUCKETS[1] : days <= 60 ? BUCKETS[2] : days <= 90 ? BUCKETS[3] : BUCKETS[4];

/** Shared by receivables/payables: ageing, per-account and per-currency totals. */
function openItems(rows: any[], limit: number) {
  const now = Date.parse(todayIso());
  const items = rows.map((r) => {
    const due = r.DueDate ? Date.parse(r.DueDate) : NaN;
    const days = Number.isNaN(due) ? 0 : Math.floor((now - due) / 86_400_000);
    return {
      account_id: r.AccountId, account_code: r.AccountCode?.trim(), account_name: r.AccountName, invoice_number: r.InvoiceNumber, entry_number: r.EntryNumber,
      description: r.Description, invoice_date: r.InvoiceDate?.slice(0, 10), due_date: r.DueDate?.slice(0, 10),
      amount: r.Amount as number, currency: (r.CurrencyCode as string) ?? '', days_overdue: Math.max(days, 0), bucket: bucketOf(days),
    };
  });
  const ageing: Record<string, Record<string, number>> = {};
  for (const b of BUCKETS) ageing[b] = totalsByCurrency(items.filter((i) => i.bucket === b));
  const byAcc = new Map<string, { account_id: string; account_name: string; count: number; rows: any[] }>();
  for (const i of items) {
    const e = byAcc.get(i.account_id) ?? { account_id: i.account_id, account_name: i.account_name, count: 0, rows: [] as any[] };
    e.count++; e.rows.push(i); byAcc.set(i.account_id, e);
  }
  const accounts = [...byAcc.values()].map((e) => ({
    account_id: e.account_id, account_name: e.account_name, open_items: e.count, totals: totalsByCurrency(e.rows),
    max_days_overdue: Math.max(...e.rows.map((r) => r.days_overdue)),
  })).sort((a, b) => Math.max(...Object.values(b.totals)) - Math.max(...Object.values(a.totals)));
  return { items: items.sort((a, b) => b.days_overdue - a.days_overdue).slice(0, limit), ageing, accounts: accounts.slice(0, 25), totals: totalsByCurrency(items), count: items.length };
}

const listSchema = {
  account_id: guidField('Only items of this account (GUID from search_accounts).').optional(),
  overdue_only: z.boolean().default(false).describe('Only items past their due date.'),
  min_days_overdue: z.number().int().min(1).max(3650).optional().describe('Only items overdue by at least this many days (e.g. 30).'),
  division: divisionField,
  top: topField(50, 200),
};

function makeOpenList(kind: 'receivables' | 'payables') {
  const resource = kind === 'receivables' ? 'read/financial/ReceivablesList' : 'read/financial/PayablesList';
  return defineTool({
    name: kind === 'receivables' ? 'list_open_receivables' : 'list_open_payables',
    title: kind === 'receivables' ? 'Open receivables' : 'Open payables',
    description: kind === 'receivables'
      ? 'Lists open (unpaid) customer invoices with ageing buckets (not due, 1-30, 31-60, 61-90, 90+ days overdue), totals per currency and per customer. Use for questions like "which customers have overdue invoices". Items are sorted most-overdue first; totals cover all fetched items (up to ~1200).'
      : 'Lists open (unpaid) supplier invoices with ageing buckets, totals per currency and per supplier. Use for cash planning and "what do we owe".',
    inputSchema: listSchema,
    annotations: readOnly,
    async run(ctx, a) {
      const minDays = a.min_days_overdue ?? (a.overdue_only ? 1 : 0);
      const cutoff = new Date(Date.parse(todayIso()) - Math.max(minDays - 1, 0) * 86_400_000).toISOString().slice(0, 10);
      const filter = and([a.account_id && `AccountId eq ${guid(a.account_id)}`, minDays > 0 && `DueDate lt ${date(cutoff)}`]);
      const select = ['Id', 'AccountId', 'AccountCode', 'AccountName', 'Amount', 'CurrencyCode', 'Description', 'DueDate', 'EntryNumber', 'InvoiceDate', 'InvoiceNumber'];
      const { rows, truncated } = await ctx.exact.list(resource, { select, filter }, { division: a.division, maxRows: 1200, maxPages: 20 });
      const r = openItems(rows, a.top);
      const what = kind === 'receivables' ? 'receivable' : 'payable';
      return {
        summary: `Found ${r.count} open ${what} item(s) totalling ${totalsText(r.totals)}${truncated ? ' (result truncated; narrow with filters)' : ''}.`,
        data: { totals: r.totals, ageing: r.ageing, by_account: r.accounts, items: r.items, truncated },
      };
    },
  });
}
export const listOpenReceivables = makeOpenList('receivables');
export const listOpenPayables = makeOpenList('payables');

export const listGlAccounts = defineTool({
  name: 'list_gl_accounts',
  title: 'List G/L accounts',
  description: 'Lists general ledger accounts (code, description, type). Filter by text in code/description. Use to find GL account ids/codes for list_transactions.',
  inputSchema: { query: z.string().min(1).max(100).optional().describe('Text contained in the description, or a code prefix.'), division: divisionField, top: topField(100, 500) },
  annotations: readOnly,
  async run(ctx, a) {
    const filter = a.query ? `substringof(${str(a.query)}, Description) eq true or startswith(Code, ${str(a.query)}) eq true` : undefined;
    const { rows, truncated } = await ctx.exact.list('financial/GLAccounts', { select: ['ID', 'Code', 'Description', 'Type', 'TypeDescription', 'BalanceSide', 'BalanceType'], filter, orderby: 'Code' }, { division: a.division, maxRows: a.top });
    return { summary: `Found ${rows.length} G/L account(s)${truncated ? ' (more exist)' : ''}.`, data: rows.map((g: any) => ({ id: g.ID, code: g.Code?.trim(), description: g.Description, type: g.TypeDescription ?? g.Type, balance_side: g.BalanceSide, balance_type: g.BalanceType })) };
  },
});

export const getProfitAndLoss = defineTool({
  name: 'get_profit_and_loss',
  title: 'Profit and loss',
  description: 'Returns revenue, costs and result for the current financial year-to-date and period, compared with the same year-to-date/period last year, with absolute and percentage differences. Amounts are in the division currency.',
  inputSchema: { division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    const select = ['CurrentYear', 'PreviousYear', 'CurrentPeriod', 'PreviousYearPeriod', 'CurrencyCode', 'RevenueCurrentYear', 'RevenuePreviousYear', 'CostsCurrentYear', 'CostsPreviousYear', 'ResultCurrentYear', 'ResultPreviousYear', 'RevenueCurrentPeriod', 'RevenuePreviousYearPeriod', 'CostsCurrentPeriod', 'CostsPreviousYearPeriod', 'ResultCurrentPeriod', 'ResultPreviousYearPeriod'];
    const { rows } = await ctx.exact.list('read/financial/ProfitLossOverview', { select }, { division: a.division, maxRows: 1, maxPages: 1 });
    const r = rows[0];
    if (!r) return { summary: 'No profit and loss data returned.', data: {} };
    const cmp = (cur: number, prev: number) => ({ current: cur, previous: prev, difference: round2(cur - prev), difference_pct: prev ? round2(((cur - prev) / Math.abs(prev)) * 100) : null });
    const data = {
      currency: r.CurrencyCode, current_year: r.CurrentYear, previous_year: r.PreviousYear, current_period: r.CurrentPeriod,
      year_to_date: { revenue: cmp(r.RevenueCurrentYear, r.RevenuePreviousYear), costs: cmp(r.CostsCurrentYear, r.CostsPreviousYear), result: cmp(r.ResultCurrentYear, r.ResultPreviousYear) },
      period: { revenue: cmp(r.RevenueCurrentPeriod, r.RevenuePreviousYearPeriod), costs: cmp(r.CostsCurrentPeriod, r.CostsPreviousYearPeriod), result: cmp(r.ResultCurrentPeriod, r.ResultPreviousYearPeriod) },
    };
    return { summary: `${r.CurrentYear} YTD result ${r.CurrencyCode} ${fmt(r.ResultCurrentYear)} vs ${r.PreviousYear}: ${fmt(r.ResultPreviousYear)} (revenue ${fmt(r.RevenueCurrentYear)} vs ${fmt(r.RevenuePreviousYear)}).`, data };
  },
});

export const getRevenueByPeriod = defineTool({
  name: 'get_revenue_by_period',
  title: 'Revenue by period',
  description: 'Returns revenue per financial period for one year (default: current year), in the division currency, with a year total. Call twice (different years) to compare years.',
  inputSchema: { year: z.number().int().min(1990).max(2100).optional().describe('Financial year; default current year.'), division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    const year = a.year ?? new Date().getFullYear();
    const { rows } = await ctx.exact.list('read/financial/RevenueListByYear', { select: ['Period', 'Year', 'Amount'], params: { year } }, { division: a.division, maxRows: 100, maxPages: 2 });
    const periods = rows.filter((r: any) => r.Year === undefined || r.Year === year).map((r: any) => ({ period: r.Period, amount: r.Amount })).sort((x: any, y: any) => x.period - y.period);
    const total = round2(periods.reduce((s: number, p: any) => s + p.amount, 0));
    return { summary: `Revenue ${year}: ${fmt(total)} over ${periods.length} period(s).`, data: { year, total, periods } };
  },
});

export const listTransactions = defineTool({
  name: 'list_transactions',
  title: 'List transactions',
  description: 'Lists general ledger transaction lines in a date range for a G/L account and/or an account (relation). A date range and at least one of gl_account_id / account_id are required; results are capped at 200 rows. Positive AmountDC = debit, negative = credit.',
  inputSchema: {
    date_from: isoDate('Start date (inclusive).'), date_to: isoDate('End date (inclusive).'),
    gl_account_id: guidField('G/L account GUID from list_gl_accounts.').optional(),
    account_id: guidField('Relation account GUID from search_accounts.').optional(),
    division: divisionField, top: topField(100, 200),
  },
  annotations: readOnly,
  async run(ctx, a) {
    if (!a.gl_account_id && !a.account_id) throw new (await import('../exact/errors.js')).ExactError('invalid_input', 'Provide gl_account_id and/or account_id.');
    const filter = and([`Date ge ${date(a.date_from)}`, `Date le ${date(a.date_to)}`, a.gl_account_id && `GLAccount eq ${guid(a.gl_account_id)}`, a.account_id && `Account eq ${guid(a.account_id)}`]);
    const select = ['ID', 'Date', 'EntryNumber', 'JournalCode', 'GLAccountCode', 'GLAccountDescription', 'AccountCode', 'AccountName', 'Description', 'InvoiceNumber', 'AmountDC', 'Currency', 'AmountFC', 'FinancialYear', 'FinancialPeriod'];
    const { rows, truncated } = await ctx.exact.list('financialtransaction/TransactionLines', { select, filter, orderby: 'Date desc' }, { division: a.division, maxRows: a.top, maxPages: 5 });
    const net = round2(rows.reduce((s: number, r: any) => s + (r.AmountDC ?? 0), 0));
    return {
      summary: `Found ${rows.length} transaction line(s), net ${fmt(net)} (default currency)${truncated ? ' — truncated, narrow the date range' : ''}.`,
      data: { net_amount_dc: net, truncated, lines: rows.map((r: any) => ({ id: r.ID, date: r.Date?.slice(0, 10), entry_number: r.EntryNumber, journal: r.JournalCode, gl_account: r.GLAccountCode?.trim(), gl_description: r.GLAccountDescription, account_code: r.AccountCode?.trim(), account_name: r.AccountName, description: r.Description, invoice_number: r.InvoiceNumber, amount_dc: r.AmountDC, currency: r.Currency, amount_fc: r.AmountFC })) },
    };
  },
});
