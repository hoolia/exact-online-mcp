/** Checks that run before any write to Exact Online. Pure functions; amounts are compared in cents. */

export interface Check { name: string; ok: boolean; message: string }

export const cents = (n: number) => Math.round(n * 100);
const eur = (c: number) => (c / 100).toFixed(2);

/** Normalised supplier invoice number: NFKC, upper case, letters and digits only, no leading zeros. */
export function normaliseRef(ref: string): string {
  const s = ref.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=.)/, '');
  return s;
}

export interface JournalLine { debit?: number; credit?: number; vat_amount?: number }

/** General journal: total debit equals total credit, VAT included on the side of its line. */
export function checkBalanced(lines: JournalLine[]): Check {
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    const d = cents(l.debit ?? 0);
    const c = cents(l.credit ?? 0);
    const v = cents(l.vat_amount ?? 0);
    if (d > 0) debit += d + v; else credit += c + v;
  }
  const ok = debit === credit && debit > 0;
  return { name: 'debit_equals_credit', ok, message: ok ? `debit ${eur(debit)} = credit ${eur(credit)}` : `debit ${eur(debit)} differs from credit ${eur(credit)}` };
}

/** Every journal line has exactly one of debit or credit, positive. */
export function checkOneSide(lines: JournalLine[]): Check {
  const bad = lines.map((l, i) => ({ i, d: l.debit ?? 0, c: l.credit ?? 0 })).filter(({ d, c }) => (d > 0) === (c > 0) || d < 0 || c < 0);
  return { name: 'one_side_per_line', ok: !bad.length, message: bad.length ? `line(s) ${bad.map((b) => b.i + 1).join(', ')} need exactly one positive debit or credit` : 'each line has one side' };
}

/** Purchase entry: the line amounts (excl. VAT) add up to the invoice net amount. */
export function checkLineSum(lineAmounts: number[], net: number): Check {
  const sum = lineAmounts.reduce((s, a) => s + cents(a), 0);
  const ok = sum === cents(net);
  return { name: 'line_sum_equals_net', ok, message: ok ? `lines ${eur(sum)} = net ${eur(cents(net))}` : `lines add up to ${eur(sum)}, the invoice net is ${eur(cents(net))}` };
}

/** Purchase entry: net plus VAT equals gross. */
export function checkGross(net: number, vat: number, gross: number): Check {
  const ok = cents(net) + cents(vat) === cents(gross);
  return { name: 'net_plus_vat_equals_gross', ok, message: ok ? `${eur(cents(net))} + ${eur(cents(vat))} = ${eur(cents(gross))}` : `net ${eur(cents(net))} + VAT ${eur(cents(vat))} is not gross ${eur(cents(gross))}` };
}

export interface VatCodeInfo { code: string; percentage: number; blocked: boolean; use: 'P' | 'S' | 'B' | string }

/** Every VAT code exists in the division, is not blocked and may be used for this kind of entry. */
export function checkVatCodes(codes: string[], known: Map<string, VatCodeInfo>, use: 'purchase' | 'sales' | 'any'): Check {
  const problems: string[] = [];
  for (const raw of new Set(codes)) {
    const v = known.get(raw.trim());
    if (!v) problems.push(`${raw} unknown`);
    else if (v.blocked) problems.push(`${raw} blocked`);
    else if (use === 'purchase' && v.use === 'S') problems.push(`${raw} is a sales code`);
    else if (use === 'sales' && v.use === 'P') problems.push(`${raw} is a purchase code`);
  }
  return { name: 'vat_code_known', ok: !problems.length, message: problems.length ? `VAT code ${problems.join(', ')}` : 'VAT codes known' };
}

/**
 * The invoice VAT matches the lines: a line's own vat_amount, or its amount times the code percentage.
 * Tolerates one cent of rounding per line.
 */
export function checkVatTotal(lines: { amount: number; vat_code: string; vat_amount?: number }[], vat: number, known: Map<string, VatCodeInfo>): Check {
  let expected = 0;
  for (const l of lines) {
    const pct = known.get(l.vat_code.trim())?.percentage ?? 0;
    expected += l.vat_amount !== undefined ? cents(l.vat_amount) : Math.round(cents(l.amount) * pct);
  }
  const ok = Math.abs(expected - cents(vat)) <= lines.length;
  return { name: 'vat_matches_lines', ok, message: ok ? `VAT ${eur(cents(vat))} matches the lines` : `the lines give VAT ${eur(expected)}, the invoice says ${eur(cents(vat))}` };
}

/** The ledger holds no entry this one duplicates. */
export function checkNoDuplicate(existing: { exactEntryId: string | null; exactEntryNumber: number | null; status: string }[]): Check {
  const ok = existing.length === 0;
  return {
    name: 'no_duplicate', ok,
    message: ok ? 'no duplicate in the ledger' : `already booked: ${existing.map((e) => `${e.exactEntryId ?? 'reserved'}${e.exactEntryNumber ? ` (entry ${e.exactEntryNumber})` : ''}, ${e.status}`).join('; ')}`,
  };
}

/** Match set: the matched amounts cancel out. */
export function checkMatchBalanced(amounts: number[]): Check {
  const sum = amounts.reduce((s, a) => s + cents(a), 0);
  return { name: 'match_lines_balance', ok: sum === 0 && amounts.length >= 2, message: sum === 0 ? 'matched amounts cancel out' : `matched amounts add up to ${eur(sum)}, not 0.00` };
}

export const failed = (checks: Check[]) => checks.filter((c) => !c.ok);
