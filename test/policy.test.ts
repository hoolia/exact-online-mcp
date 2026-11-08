import { describe, expect, it } from 'vitest';
import {
  checkBalanced, checkGross, checkLineSum, checkSign, checkMatchBalanced, checkNoDuplicate, checkOneSide, checkVatCodes, checkVatTotal, normaliseRef, vatOverrides, type VatCodeInfo,
} from '../src/policy/validators.js';
import { DescriptionError, checkTemplate, renderDescription, DEFAULT_DESCRIPTION_TEMPLATE as T } from '../src/policy/description.js';
import { DEFAULT_TIER_POLICY, decideTier, type TierInput } from '../src/policy/tiers.js';
import { checkApprovals, mintApproval, readApproval } from '../src/policy/approval.js';

const VAT = new Map<string, VatCodeInfo>([
  ['2', { code: '2', percentage: 0.21, blocked: false, use: 'B' }],
  ['1', { code: '1', percentage: 0.09, blocked: false, use: 'P' }],
  ['9', { code: '9', percentage: 0.21, blocked: true, use: 'B' }],
  ['S', { code: 'S', percentage: 0.21, blocked: false, use: 'S' }],
]);

describe('validators', () => {
  it('debit = credit, VAT on the side of its line', () => {
    expect(checkBalanced([{ debit: 100 }, { credit: 100 }]).ok).toBe(true);
    expect(checkBalanced([{ debit: 100, vat_amount: 21 }, { credit: 121 }]).ok).toBe(true);
    expect(checkBalanced([{ debit: 100 }, { credit: 99.99 }]).ok).toBe(false);
    expect(checkBalanced([]).ok).toBe(false);
    // floating point: 0.1 + 0.2 is compared in cents
    expect(checkBalanced([{ debit: 0.1 }, { debit: 0.2 }, { credit: 0.3 }]).ok).toBe(true);
  });
  it('one side per journal line', () => {
    expect(checkOneSide([{ debit: 1 }, { credit: 1 }]).ok).toBe(true);
    expect(checkOneSide([{ debit: 1, credit: 1 }]).ok).toBe(false);
    expect(checkOneSide([{}]).ok).toBe(false);
  });
  it('line sum = net, also for a credit note', () => {
    expect(checkLineSum([60, 40], 100).ok).toBe(true);
    expect(checkLineSum([-60, -40], -100).ok).toBe(true);
    expect(checkLineSum([60, 40.01], 100).ok).toBe(false);
  });
  it('net + VAT = gross', () => {
    expect(checkGross(100, 21, 121).ok).toBe(true);
    expect(checkGross(100, 21, 121.01).ok).toBe(false);
  });
  it('finds line VAT amounts that differ from the code percentage', () => {
    expect(vatOverrides([{ amount: 100, vat_code: '2', vat_amount: 21.01 }, { amount: 100, vat_code: '2' }], VAT)).toEqual([]);
    expect(vatOverrides([{ amount: 100, vat_code: '2', vat_amount: 0 }, { amount: -10, vat_code: '2', vat_amount: -2.1 }], VAT)).toEqual([1]);
  });
  it('gross sign matches invoice or credit note', () => {
    expect(checkSign(121, false).ok).toBe(true);
    expect(checkSign(-121, true).ok).toBe(true);
    expect(checkSign(121, true).ok).toBe(false);
    expect(checkSign(-121, false).ok).toBe(false);
    expect(checkSign(0.004, false).ok).toBe(false);
  });
  it('VAT code known, not blocked, usable for purchases', () => {
    expect(checkVatCodes(['2', '1'], VAT, 'purchase').ok).toBe(true);
    const r = checkVatCodes(['7', '9', 'S'], VAT, 'purchase');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('7 unknown');
    expect(r.message).toContain('9 blocked');
    expect(r.message).toContain('S is a sales code');
  });
  it('VAT total matches the lines within a cent per line', () => {
    expect(checkVatTotal([{ amount: 100, vat_code: '2' }, { amount: 50, vat_code: '1' }], 25.5, VAT).ok).toBe(true);
    expect(checkVatTotal([{ amount: 100, vat_code: '2', vat_amount: 20.99 }], 20.99, VAT).ok).toBe(true);
    expect(checkVatTotal([{ amount: 100, vat_code: '2' }], 9, VAT).ok).toBe(false);
  });
  it('duplicate check names the existing entry', () => {
    expect(checkNoDuplicate([]).ok).toBe(true);
    const r = checkNoDuplicate([{ exactEntryId: 'g-1', exactEntryNumber: 7, status: 'drafted' }]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('g-1 (entry 7)');
  });
  it('match set amounts cancel out', () => {
    expect(checkMatchBalanced([-12.1, 12.1]).ok).toBe(true);
    expect(checkMatchBalanced([-12.1, 12]).ok).toBe(false);
    expect(checkMatchBalanced([0]).ok).toBe(false);
  });
  it('normalises invoice numbers', () => {
    expect(normaliseRef(' inv-2026/0012 ')).toBe('INV20260012');
    expect(normaliseRef('000123')).toBe('123');
    expect(normaliseRef('0')).toBe('0');
    expect(normaliseRef('INV 2026.0012')).toBe(normaliseRef('inv-2026-0012'));
  });
});

describe('description template', () => {
  const p = { supplier: 'Acme Hosting BV', period: '2026-11', ref: 'INV-1', short: 'servers' };
  it('renders the parts', () => {
    expect(renderDescription(T, p)).toBe('Acme Hosting BV|2026-11|INV-1|servers');
  });
  it('rejects a separator, an empty part and a bad period', () => {
    expect(() => renderDescription(T, { ...p, short: 'a|b' })).toThrow(DescriptionError);
    expect(() => renderDescription(T, { ...p, supplier: '  ' })).toThrow(/supplier is empty/);
    expect(() => renderDescription(T, { ...p, period: 'nov' })).toThrow(/period/);
    expect(renderDescription(T, { ...p, period: '2026-Q4' })).toContain('2026-Q4');
  });
  it('shortens short, then supplier, never ref', () => {
    const long = renderDescription(T, { ...p, supplier: 'A Very Long Supplier Name International', short: 'monthly managed hosting services' }, 60);
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).toContain('|INV-1|');
    expect(() => renderDescription(T, { ...p, ref: 'R'.repeat(60) }, 60)).toThrow(/shorten the reference/);
  });
  it('checks the template itself', () => {
    expect(() => checkTemplate('{supplier} {ref} {foo}')).toThrow(/foo/);
    expect(() => checkTemplate('{supplier}|{short}')).toThrow(/\{ref\}/);
    expect(() => checkTemplate(T)).not.toThrow();
  });
});

describe('approval tiers', () => {
  const base: TierInput = { kind: 'purchase', amount: 121, currency: 'EUR', journal: '60', supplierEntries: 3, balanceAccounts: [], validatorsGreen: true, duplicate: false };
  const tier = (o: Partial<TierInput>, p = DEFAULT_TIER_POLICY) => decideTier({ ...base, ...o }, p).tier;
  it('auto for a small purchase of a known supplier with green checks', () => expect(tier({})).toBe('auto'));
  it('approve when any auto condition fails', () => {
    expect(tier({ amount: 250 })).toBe('approve');
    expect(tier({ supplierEntries: 2 })).toBe('approve');
    expect(tier({ validatorsGreen: false })).toBe('approve');
    expect(tier({ duplicate: true })).toBe('approve');
    expect(tier({ currency: 'USD' })).toBe('approve');
    expect(tier({ kind: 'general_journal' })).toBe('approve');
    expect(tier({ mixedSigns: true })).toBe('approve');
    expect(tier({ vatOverrides: [1] })).toBe('approve');
    expect(tier({ vatOverrides: [] })).toBe('auto');
  });
  it('two-step for match sets, payroll, large amounts and balance accounts off the allow-list', () => {
    expect(tier({ kind: 'matchset' })).toBe('two_step');
    expect(tier({ journal: '95' }, { ...DEFAULT_TIER_POLICY, payrollJournals: ['95'] })).toBe('two_step');
    expect(tier({ amount: 5000.01 })).toBe('two_step');
    expect(tier({ amount: 5000 })).toBe('approve');
    expect(tier({ balanceAccounts: ['1100'] })).toBe('two_step');
    expect(tier({ balanceAccounts: ['1100'] }, { ...DEFAULT_TIER_POLICY, balanceAccountAllowlist: ['1100'] })).toBe('auto');
  });
  it('follows the configured thresholds', () => {
    expect(tier({ amount: 400 }, { ...DEFAULT_TIER_POLICY, autoMaxEur: 500 })).toBe('auto');
  });
});

describe('approval tokens', () => {
  const KEY = 'k'.repeat(40);
  const NOW = Date.parse('2026-11-08T12:00:00Z');
  const exp = NOW / 1000 + 3600;
  const tok = (approver: string, tier: 'approve' | 'two_step' | 'two-step' = 'approve', entry = 'E1', e = exp, answer?: string) => mintApproval(KEY, { entry, tier, approver, exp: e, answer });
  const check = (tokens: string[], tier: 'approve' | 'two_step' | 'auto' = 'approve', answers = ['ja', 'akkoord']) =>
    checkApprovals(KEY, tokens, { entry: 'e1', tier, drafter: 'jwt:agent', nowMs: NOW, answers });
  const two = (approver: string, ch?: string, iat: number | null = NOW / 1000 - 3600, entry = 'E1') => mintApproval(KEY, { entry, tier: 'two-step', approver, ch, iat: iat ?? undefined, exp: NOW / 1000 + 3600 });

  it('round-trips, accepts the contract tier spelling and rejects tampering or another key', () => {
    const t = tok('alice');
    expect(readApproval(KEY, t)).toMatchObject({ entry: 'e1', approver: 'alice', tier: 'approve' });
    expect(readApproval(KEY, tok('bob', 'two-step'))).toMatchObject({ tier: 'two_step' });
    expect(readApproval('x'.repeat(40), t)).toBeNull();
    expect(readApproval(KEY, t.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')))).toBeNull();
  });
  it('approve needs one valid token and an approving answer', () => {
    expect(check([]).ok).toBe(false);
    expect(check([tok('alice')])).toMatchObject({ ok: true, approvers: ['alice'] });
    expect(check([tok('alice', 'two_step')]).ok).toBe(true);
    expect(check([tok('alice')], 'approve', []).problems.join()).toContain('approving answer');
    expect(check([tok('alice')], 'approve', ['nee']).problems.join()).toContain('not an approval');
    expect(check([tok('alice')], 'approve', ['misschien']).ok).toBe(false);
  });
  it('binds a token to the answer it was issued for', () => {
    expect(check([tok('alice', 'approve', 'E1', exp, 'Ja  akkoord')], 'approve', ['ja akkoord']).ok).toBe(true);
    expect(check([tok('alice', 'approve', 'E1', exp, 'ja')], 'approve', ['ok']).problems.join()).toContain('different answer');
  });
  it('refuses expired, foreign, self-approved and lower-tier tokens', () => {
    expect(check([tok('alice', 'approve', 'E1', NOW / 1000 - 1)]).problems.join()).toContain('expired');
    expect(check([tok('alice', 'approve', 'E2')]).problems.join()).toContain('another draft');
    expect(check([tok('jwt:agent')]).problems.join()).toContain('drafter');
    expect(check([tok('alice'), tok('bob')], 'two_step').problems.join()).toContain('tier approve');
  });
  it('two-step needs two approvals on different channels and two answers', () => {
    expect(check([two('alice', 'whatsapp')], 'two_step').ok).toBe(false);
    expect(check([two('alice', 'whatsapp'), two('alice', 'WhatsApp ')], 'two_step').problems.join()).toContain('repeats channel whatsapp');
    expect(check([two('alice', 'whatsapp'), two('bob', 'whatsapp')], 'two_step').problems.join()).toContain('repeats channel whatsapp');
    expect(check([two('alice', 'whatsapp'), two('alice', 'tui')], 'two_step', ['ja']).ok).toBe(false);
    expect(check([two('alice', 'whatsapp'), two('alice', 'tui')], 'two_step')).toEqual({ ok: true, approvers: ['alice via whatsapp', 'alice via tui'], problems: [] });
    expect(check([two('alice', 'whatsapp'), two('bob', 'tui')], 'two_step')).toMatchObject({ ok: true, approvers: ['alice via whatsapp', 'bob via tui'] });
  });
  it('two-step refuses tokens without a channel or approval time', () => {
    expect(check([tok('alice', 'two_step'), tok('bob', 'two_step')], 'two_step').problems.join()).toContain('names no channel');
    expect(check([two('alice', 'whatsapp', null), two('alice', 'tui')], 'two_step').problems.join()).toContain('no approval time');
  });
  it('two-step needs both approvals within 72 h', () => {
    expect(check([two('alice', 'whatsapp', NOW / 1000 - 72 * 3600), two('alice', 'tui')], 'two_step').ok).toBe(true);
    expect(check([two('alice', 'whatsapp', NOW / 1000 - 72 * 3600 - 1), two('alice', 'tui')], 'two_step').problems.join()).toContain('more than 72 h ago');
    expect(check([two('alice', 'whatsapp', NOW / 1000 + 301), two('alice', 'tui')], 'two_step').problems.join()).toContain('in the future');
  });
  it('the drafter cannot approve on any channel', () => {
    expect(check([two('jwt:agent', 'whatsapp'), two('alice', 'tui')], 'two_step').problems.join()).toContain('drafter');
  });
  it('approve accepts one token with or without a channel and still counts approvers', () => {
    expect(check([two('alice', 'whatsapp')])).toMatchObject({ ok: true, approvers: ['alice via whatsapp'] });
    expect(check([tok('alice'), tok('alice')]).problems.join()).toContain('repeats approver');
  });
  it('reads ch and iat and refuses malformed ones', () => {
    expect(readApproval(KEY, two('Alice', ' TUI '))).toMatchObject({ approver: 'alice', ch: 'tui', iat: NOW / 1000 - 3600 });
    expect(readApproval(KEY, mintApproval(KEY, { entry: 'E1', tier: 'two-step', approver: 'a', ch: ' ', exp: NOW / 1000 + 60 }))).toBeNull();
    expect(readApproval(KEY, mintApproval(KEY, { entry: 'E1', tier: 'two-step', approver: 'a', ch: 'tui', iat: 1.5, exp: NOW / 1000 + 60 }))).toBeNull();
  });
  it('auto needs no token', () => expect(check([], 'auto', []).ok).toBe(true));
});
