import { z } from 'zod';
import { defineTool, type ToolContext } from './types.js';
import { divisionField, fmt, readOnly, round2, todayIso, trimCode } from './common.js';
import { and, date, str } from '../exact/odata.js';
import { ExactError } from '../exact/errors.js';

/**
 * Balances per G/L account, from the bulk transaction lines (1000 rows per call). Exact Online does not carry balances
 * forward into a new year with entries: a year has opening balance lines (Type 10) only when the administration started
 * then. The balance of a balance sheet account is therefore the sum of every line up to the reporting date, and the
 * result of the profit and loss accounts of earlier years is shown as one line.
 */
interface GlInfo { id: string; code: string; description: string; balanceType: 'B' | 'W'; typeDescription: string | null }
interface Sums { debit: number; credit: number }
type SumMap = Map<string, Sums>;

const PRIOR_CACHE_MS = 15 * 60 * 1000;
const priorCache = new Map<string, { at: number; sums: SumMap }>();

const add = (m: SumMap, code: string, amount: number) => {
  const s = m.get(code) ?? { debit: 0, credit: 0 };
  if (amount >= 0) s.debit += amount; else s.credit -= amount;
  m.set(code, s);
};

async function glTable(ctx: ToolContext, div: number): Promise<Map<string, GlInfo>> {
  const { rows, truncated } = await ctx.exact.list('financial/GLAccounts', { select: ['ID', 'Code', 'Description', 'BalanceType', 'TypeDescription'] }, { division: div, maxRows: 5000, maxPages: 100 });
  if (truncated) throw new ExactError('api', 'Too many G/L accounts to classify in one call.');
  return new Map(rows.map((g: any) => [String(trimCode(g.Code)), { id: g.ID, code: String(trimCode(g.Code)), description: g.Description, balanceType: g.BalanceType === 'B' ? 'B' : 'W', typeDescription: g.TypeDescription ?? null }]));
}

async function sumLines(ctx: ToolContext, div: number, filter: string, keep: (r: any) => boolean = () => true): Promise<SumMap> {
  const { rows, truncated } = await ctx.exact.list('bulk/Financial/TransactionLines', { select: ['GLAccountCode', 'AmountDC', 'FinancialPeriod', 'Status'], filter }, { division: div, maxRows: 500_000, maxPages: 500 });
  if (truncated) throw new ExactError('api', 'Too many transaction lines to total in one call; narrow the year.');
  const m: SumMap = new Map();
  for (const r of rows) if (keep(r)) add(m, String(trimCode(r.GLAccountCode)), Number(r.AmountDC ?? 0));
  return m;
}

/** Year and period of a date, from the division's financial periods. */
export async function periodOf(ctx: ToolContext, div: number, iso: string): Promise<{ year: number; period: number }> {
  const { rows } = await ctx.exact.list('financial/FinancialPeriods', { select: ['FinYear', 'FinPeriod'], filter: `StartDate le ${date(iso)} and EndDate ge ${date(iso)}` }, { division: div, maxRows: 1, maxPages: 1 });
  if (!rows[0]) throw new ExactError('invalid_input', `No financial period covers ${iso}; give year and period.`);
  return { year: Number(rows[0].FinYear), period: Number(rows[0].FinPeriod) };
}

interface BalanceRow { code: string; description: string; balance_type: 'B' | 'W'; category: string | null; opening: number; debit: number; credit: number; closing: number }

async function balances(ctx: ToolContext, a: { year?: number; period?: number; processed_only: boolean; division?: number }) {
  const div = await ctx.exact.resolveDivision(a.division);
  // a given year without a period runs to its last period, 13 included
  const at = a.year === undefined ? await periodOf(ctx, div, todayIso()) : { year: a.year, period: a.period ?? 13 };
  if (a.year === undefined && a.period !== undefined) at.period = a.period;
  const status = a.processed_only ? ' and Status eq 50' : '';
  const key = `${ctx.user.id}|${div}|${at.year}|${a.processed_only}`;
  const cached = priorCache.get(key);
  const prior = cached && ctx.now() - cached.at < PRIOR_CACHE_MS ? cached.sums : await sumLines(ctx, div, `FinancialYear lt ${at.year}${status}`);
  if (!cached || cached.sums !== prior) priorCache.set(key, { at: ctx.now(), sums: prior });
  const [gl, current] = await Promise.all([
    glTable(ctx, div),
    sumLines(ctx, div, `FinancialYear eq ${at.year}${status}`, (r) => Number(r.FinancialPeriod) <= at.period),
  ]);
  const rows: BalanceRow[] = [];
  let priorResult = 0;
  const unknown: string[] = [];
  for (const code of new Set([...prior.keys(), ...current.keys()])) {
    const info = gl.get(code);
    if (!info) unknown.push(code);
    const type = info?.balanceType ?? 'W';
    const p = prior.get(code) ?? { debit: 0, credit: 0 };
    const c = current.get(code) ?? { debit: 0, credit: 0 };
    if (type === 'W') priorResult += p.debit - p.credit;
    const opening = type === 'B' ? round2(p.debit - p.credit) : 0;
    const row = { code, description: info?.description ?? '(unknown G/L account)', balance_type: type, category: info?.typeDescription ?? null, opening, debit: round2(c.debit), credit: round2(c.credit), closing: round2(opening + c.debit - c.credit) };
    if (row.opening || row.debit || row.credit) rows.push(row);
  }
  rows.sort((x, y) => x.code.localeCompare(y.code, 'nl', { numeric: true }));
  return { div, at, rows, priorResult: round2(priorResult), unknown };
}

const yearField = z.number().int().min(2000).max(2100).optional().describe('Financial year; omitted: the year of today.');
const periodField = z.number().int().min(1).max(13).optional().describe('Up to and including this period; omitted: the current period, or the last period of the given year.');
const processedOnly = z.boolean().default(false).describe('true: only processed entries (Status 50); default also counts open entries, as the Exact reports do.');

export const getTrialBalance = defineTool({
  name: 'get_trial_balance',
  title: 'Get trial balance (proefbalans)',
  description: 'Trial balance per G/L account up to a financial period: opening balance at the start of the year (balance sheet accounts), debit and credit movements of the year up to the period, and the closing balance (debit positive). Profit and loss accounts start the year at zero; result_earlier_years is the total profit and loss of all earlier years (debit positive), before any appropriation booked on balance sheet accounts. Totals must balance. Totals transaction lines of all years, so the first call can take a minute.',
  inputSchema: { year: yearField, period: periodField, processed_only: processedOnly, division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    const { div, at, rows, priorResult, unknown } = await balances(ctx, a);
    const debit = round2(rows.reduce((s, r) => s + r.debit, 0));
    const credit = round2(rows.reduce((s, r) => s + r.credit, 0));
    const closing = round2(rows.reduce((s, r) => s + r.closing, 0) + priorResult);
    return {
      summary: `Trial balance division ${div}, ${at.year} up to period ${at.period}: ${rows.length} accounts, movements debit ${fmt(debit)} / credit ${fmt(credit)}, closing balances sum to ${fmt(closing)}${closing === 0 ? ' (balanced)' : ' (NOT balanced: check entries without a G/L account)'}${unknown.length ? `. WARNING: G/L account(s) ${unknown.join(', ')} not found, counted as profit and loss` : ''}.`,
      data: { division: div, year: at.year, period: at.period, totals: { debit, credit, closing_sum: closing }, result_earlier_years: priorResult, unknown_accounts: unknown, accounts: rows },
    };
  },
});

export const getBalanceSheet = defineTool({
  name: 'get_balance_sheet',
  title: 'Get balance sheet (balans)',
  description: 'Balance sheet at the end of a financial period: every balance sheet account with its balance (debit positive), grouped by the Exact account category, with total debit (assets) and credit (equity and liabilities) balances, the total profit and loss of all earlier years (before any appropriation booked on balance sheet accounts, which then shows as a balance there) and the result of the current year up to the period. Debit total equals credit total plus results. Totals transaction lines of all years, so the first call can take a minute.',
  inputSchema: { year: yearField, period: periodField, processed_only: processedOnly, division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    const { div, at, rows, priorResult, unknown } = await balances(ctx, a);
    const accounts = rows.filter((r) => r.balance_type === 'B' && r.closing !== 0).map((r) => ({ code: r.code, description: r.description, category: r.category, balance: r.closing }));
    const result = round2(rows.filter((r) => r.balance_type === 'W').reduce((s, r) => s + r.closing, 0));
    const groups: Record<string, number> = {};
    for (const r of accounts) groups[r.category ?? 'other'] = round2((groups[r.category ?? 'other'] ?? 0) + r.balance);
    const debit = round2(accounts.filter((r) => r.balance > 0).reduce((s, r) => s + r.balance, 0));
    const credit = round2(-accounts.filter((r) => r.balance < 0).reduce((s, r) => s + r.balance, 0));
    // profit is a credit balance: P&L closing sums are debit-positive, so a profit is negative
    const check = round2(debit - credit + priorResult + result);
    return {
      summary: `Balance sheet division ${div} at ${at.year}/${at.period}: debit balances ${fmt(debit)}, credit balances ${fmt(credit)}, result earlier years ${fmt(-priorResult)}, result ${at.year} ${fmt(-result)} (profit positive)${check === 0 ? '' : `; difference ${fmt(check)}`}${unknown.length ? `. WARNING: G/L account(s) ${unknown.join(', ')} not found, counted as profit and loss` : ''}.`,
      data: { division: div, year: at.year, period: at.period, unknown_accounts: unknown, total_debit: debit, total_credit: credit, result_earlier_years: round2(-priorResult), result_current_year: round2(-result), difference: check, categories: groups, accounts },
    };
  },
});

export const listFinancialPeriods = defineTool({
  name: 'list_financial_periods',
  title: 'List financial periods',
  description: 'Lists the financial periods of a year with start and end dates. Draft tools take financial_year and financial_period; get_trial_balance takes year and period.',
  inputSchema: { year: yearField, division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    const div = await ctx.exact.resolveDivision(a.division);
    const year = a.year ?? (await periodOf(ctx, div, todayIso())).year;
    const { rows } = await ctx.exact.list('financial/FinancialPeriods', { select: ['FinYear', 'FinPeriod', 'StartDate', 'EndDate'], filter: `FinYear eq ${year}`, orderby: 'FinPeriod' }, { division: div, maxRows: 20, maxPages: 1 });
    return { summary: `${rows.length} period(s) in ${year}.`, data: rows.map((p: any) => ({ year: p.FinYear, period: p.FinPeriod, start: p.StartDate?.slice(0, 10), end: p.EndDate?.slice(0, 10) })) };
  },
});

export const listCostCenters = defineTool({
  name: 'list_cost_centers',
  title: 'List cost centers',
  description: 'Lists cost centers (kostenplaatsen) with code and description. Draft tools take the code as cost_center.',
  inputSchema: { include_inactive: z.boolean().default(false), division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    const { rows } = await ctx.exact.list('hrm/Costcenters', { select: ['Code', 'Description', 'Active'], filter: a.include_inactive ? undefined : 'Active eq true', orderby: 'Code' }, { division: a.division, maxRows: 500, maxPages: 10 });
    return { summary: `Found ${rows.length} cost center(s).`, data: rows.map((c: any) => ({ code: trimCode(c.Code), description: c.Description, active: !!c.Active })) };
  },
});

export const listPaymentConditions = defineTool({
  name: 'list_payment_conditions',
  title: 'List payment conditions',
  description: 'Lists payment conditions (code, description, days). create_account takes the code.',
  inputSchema: { query: z.string().min(1).max(60).optional(), division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    const { rows } = await ctx.exact.list('cashflow/PaymentConditions', { select: ['Code', 'Description', 'PaymentDays'], filter: and([a.query && `substringof(${str(a.query)}, Description) eq true`]), orderby: 'Code' }, { division: a.division, maxRows: 200, maxPages: 4 });
    return { summary: `Found ${rows.length} payment condition(s).`, data: rows.map((p: any) => ({ code: trimCode(p.Code), description: p.Description, days: p.PaymentDays })) };
  },
});
