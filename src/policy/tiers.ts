export type Tier = 'auto' | 'approve' | 'two_step';
export const TIER_RANK: Record<Tier, number> = { auto: 0, approve: 1, two_step: 2 };

export interface TierPolicy {
  /** Auto: gross below this many EUR */
  autoMaxEur: number;
  /** Auto: at least this many earlier entries of the supplier in the ledger */
  autoMinSupplierEntries: number;
  /** Auto: processed no earlier than this many hours after the draft */
  autoHoldHours: number;
  /** Two-step: gross above this many EUR */
  twoStepAboveEur: number;
  /** Two-step unless every balance sheet G/L account code used is in this list */
  balanceAccountAllowlist: string[];
  /** Two-step for these journal codes (payroll) */
  payrollJournals: string[];
}

export const DEFAULT_TIER_POLICY: TierPolicy = {
  autoMaxEur: 250, autoMinSupplierEntries: 3, autoHoldHours: 24, twoStepAboveEur: 5000, balanceAccountAllowlist: [], payrollJournals: [],
};

export interface TierInput {
  kind: 'purchase' | 'general_journal' | 'matchset';
  /** gross, or the sum of the absolute line amounts plus VAT when larger (purchase); total debit (journal); in the entry currency */
  amount: number;
  /** purchase lines with both positive and negative amounts */
  mixedSigns?: boolean;
  /** line numbers whose given VAT amount differs from the VAT code percentage */
  vatOverrides?: number[];
  currency: string;
  journal: string;
  supplierEntries: number;
  /** codes of the balance sheet G/L accounts on the lines */
  balanceAccounts: string[];
  validatorsGreen: boolean;
  duplicate: boolean;
}

/** The approval tier of an entry, with the reasons that decided it. */
export function decideTier(i: TierInput, p: TierPolicy): { tier: Tier; reasons: string[] } {
  const two: string[] = [];
  if (i.kind === 'matchset') two.push('match sets always need two approvals');
  if (p.payrollJournals.includes(i.journal.trim())) two.push(`journal ${i.journal} is a payroll journal`);
  if (Math.abs(i.amount) > p.twoStepAboveEur) two.push(`amount ${Math.abs(i.amount).toFixed(2)} is above ${p.twoStepAboveEur}`);
  const outside = [...new Set(i.balanceAccounts.map((c) => c.trim()))].filter((c) => !p.balanceAccountAllowlist.includes(c));
  if (outside.length) two.push(`balance account(s) ${outside.join(', ')} not on the allow-list`);
  if (two.length) return { tier: 'two_step', reasons: two };

  const notAuto: string[] = [];
  if (i.kind !== 'purchase') notAuto.push('only purchase entries can be automatic');
  if (i.mixedSigns) notAuto.push('lines have both positive and negative amounts');
  if (i.vatOverrides?.length) notAuto.push(`line(s) ${i.vatOverrides.join(', ')} have a VAT amount that differs from the VAT code percentage`);
  if (i.currency !== 'EUR') notAuto.push(`currency ${i.currency} is not EUR`);
  if (!(Math.abs(i.amount) < p.autoMaxEur)) notAuto.push(`amount ${Math.abs(i.amount).toFixed(2)} is not below ${p.autoMaxEur}`);
  if (i.supplierEntries < p.autoMinSupplierEntries) notAuto.push(`supplier has ${i.supplierEntries} earlier entr${i.supplierEntries === 1 ? 'y' : 'ies'}, automatic needs ${p.autoMinSupplierEntries}`);
  if (!i.validatorsGreen) notAuto.push('a validator failed');
  if (i.duplicate) notAuto.push('possible duplicate');
  if (notAuto.length) return { tier: 'approve', reasons: notAuto };
  return { tier: 'auto', reasons: [`below ${p.autoMaxEur} EUR, known supplier, all checks green; processed after a ${p.autoHoldHours} h hold`] };
}
