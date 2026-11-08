import { describe, expect, it } from 'vitest';
import { answerHash, checkApprovals, mintApproval, readApproval } from '../src/policy/approval.js';

// The test vector of "Approval token format" in TOOLS.md; an independent implementation must produce the same tokens.
const KEY = 'test-vector-approval-key-0123456789abcdef';
const ENTRY = '33333333-3333-3333-3333-333333333333';
const EXP = 1794132000; // 2026-11-08T10:00:00Z
const NOW = Date.parse('2026-11-08T09:00:00Z');
const ANSWER_HASH = 'c057d277a56085d5e988165be31bdd27ef5534cdd7f3238efabbf78c05d720fa';
const APPROVE_TOKEN = 'eyJ2IjoxLCJlbnRyeSI6IjMzMzMzMzMzLTMzMzMtMzMzMy0zMzMzLTMzMzMzMzMzMzMzMyIsInRpZXIiOiJhcHByb3ZlIiwiYXBwcm92ZXIiOiJhbGljZSIsImV4cCI6MTc5NDEzMjAwMCwiYW5zIjoiYzA1N2QyNzdhNTYwODVkNWU5ODgxNjViZTMxYmRkMjdlZjU1MzRjZGQ3ZjMyMzhlZmFiYmY3OGMwNWQ3MjBmYSJ9.ooZVlE-72yRTjYVSsXW7nINfKV4-9lz8wAovLecvOe4';
const IAT = 1794128400; // 2026-11-08T09:00:00Z
const TWO_STEP_EXP = 1794387600; // IAT + 72 h
const TWO_STEP_WHATSAPP_TOKEN = 'eyJ2IjoxLCJlbnRyeSI6IjMzMzMzMzMzLTMzMzMtMzMzMy0zMzMzLTMzMzMzMzMzMzMzMyIsInRpZXIiOiJ0d28tc3RlcCIsImFwcHJvdmVyIjoiYWxpY2UiLCJjaCI6IndoYXRzYXBwIiwiaWF0IjoxNzk0MTI4NDAwLCJleHAiOjE3OTQzODc2MDAsImFucyI6ImMwNTdkMjc3YTU2MDg1ZDVlOTg4MTY1YmUzMWJkZDI3ZWY1NTM0Y2RkN2YzMjM4ZWZhYmJmNzhjMDVkNzIwZmEifQ.Yd9yy36zcSNZo0Mk0ZGbIBkOgIQnov9zFr_zlOzI4b0';
const TWO_STEP_TUI_TOKEN = 'eyJ2IjoxLCJlbnRyeSI6IjMzMzMzMzMzLTMzMzMtMzMzMy0zMzMzLTMzMzMzMzMzMzMzMyIsInRpZXIiOiJ0d28tc3RlcCIsImFwcHJvdmVyIjoiYWxpY2UiLCJjaCI6InR1aSIsImlhdCI6MTc5NDEyODQwMCwiZXhwIjoxNzk0Mzg3NjAwLCJhbnMiOiJjMDU3ZDI3N2E1NjA4NWQ1ZTk4ODE2NWJlMzFiZGQyN2VmNTUzNGNkZDdmMzIzOGVmYWJiZjc4YzA1ZDcyMGZhIn0.UNCZ8HGSWRevDHFi5Q4VCARrzvwipHRhLkWdD7f_I8s';
// the 0.3.0 two-step vector: no ch, so it no longer counts for two-step but still satisfies approve
const TWO_STEP_TOKEN = 'eyJ2IjoxLCJlbnRyeSI6IjMzMzMzMzMzLTMzMzMtMzMzMy0zMzMzLTMzMzMzMzMzMzMzMyIsInRpZXIiOiJ0d28tc3RlcCIsImFwcHJvdmVyIjoiYWxpY2UiLCJleHAiOjE3OTQxMzIwMDB9.oqam9uIlIuThpUsZbHXmBC7D6mP_Q9HGskHxC66NKg0';

describe('approval token test vector', () => {
  it('normalises and hashes the answer', () => {
    expect(answerHash(`Boek  ${ENTRY}`)).toBe(ANSWER_HASH);
    expect(answerHash(` boek ${ENTRY}\n`)).toBe(ANSWER_HASH);
  });
  it('mints the vector tokens byte for byte', () => {
    expect(mintApproval(KEY, { entry: ENTRY.toUpperCase(), tier: 'approve', approver: ' Alice ', exp: EXP, answer: `Boek  ${ENTRY}` })).toBe(APPROVE_TOKEN);
    expect(mintApproval(KEY, { entry: ENTRY, tier: 'two_step', approver: 'alice', exp: EXP })).toBe(TWO_STEP_TOKEN);
  });
  it('accepts the vector token with the answer "boek <id>"', () => {
    expect(readApproval(KEY, APPROVE_TOKEN)).toEqual({ v: 1, entry: ENTRY, tier: 'approve', approver: 'alice', exp: EXP, ans: ANSWER_HASH });
    const ok = checkApprovals(KEY, [APPROVE_TOKEN], { entry: ENTRY, tier: 'approve', drafter: 'jwt:accountant', nowMs: NOW, answers: [`boek ${ENTRY}`] });
    expect(ok).toEqual({ ok: true, approvers: ['alice'], problems: [] });
  });
});

describe('two-channel test vector', () => {
  const answer = `Boek  ${ENTRY}`;
  it('mints the two-step vector tokens byte for byte', () => {
    expect(mintApproval(KEY, { entry: ENTRY, tier: 'two-step', approver: 'alice', ch: 'whatsapp', iat: IAT, exp: TWO_STEP_EXP, answer })).toBe(TWO_STEP_WHATSAPP_TOKEN);
    expect(mintApproval(KEY, { entry: ENTRY, tier: 'two_step', approver: ' Alice', ch: 'TUI', iat: IAT, exp: TWO_STEP_EXP, answer })).toBe(TWO_STEP_TUI_TOKEN);
    expect(JSON.parse(Buffer.from(TWO_STEP_WHATSAPP_TOKEN.split('.')[0]!, 'base64url').toString())).toEqual({ v: 1, entry: ENTRY, tier: 'two-step', approver: 'alice', ch: 'whatsapp', iat: IAT, exp: TWO_STEP_EXP, ans: ANSWER_HASH });
  });
  it('accepts one approver on two channels for a two-step draft', () => {
    const r = checkApprovals(KEY, [TWO_STEP_WHATSAPP_TOKEN, TWO_STEP_TUI_TOKEN], { entry: ENTRY, tier: 'two_step', drafter: 'jwt:accountant', nowMs: NOW, answers: [`boek ${ENTRY}`, `boek ${ENTRY}`] });
    expect(r).toEqual({ ok: true, approvers: ['alice via whatsapp', 'alice via tui'], problems: [] });
  });
  it('refuses the same pair after 72 h', () => {
    const r = checkApprovals(KEY, [TWO_STEP_WHATSAPP_TOKEN, TWO_STEP_TUI_TOKEN], { entry: ENTRY, tier: 'two_step', drafter: 'jwt:accountant', nowMs: (TWO_STEP_EXP + 1) * 1000, answers: [`boek ${ENTRY}`, `boek ${ENTRY}`] });
    expect(r.ok).toBe(false);
  });
  it('keeps the 0.3.0 vectors valid for the approve tier only', () => {
    const approve = { entry: ENTRY, tier: 'approve' as const, drafter: 'jwt:accountant', nowMs: NOW, answers: [`boek ${ENTRY}`] };
    expect(checkApprovals(KEY, [APPROVE_TOKEN], approve).ok).toBe(true);
    expect(checkApprovals(KEY, [TWO_STEP_TOKEN], approve).ok).toBe(true);
    const twoStep = checkApprovals(KEY, [TWO_STEP_TOKEN, TWO_STEP_TUI_TOKEN], { ...approve, tier: 'two_step', answers: ['ja', 'ja'] });
    expect(twoStep.problems.join()).toContain('token 1 names no channel');
  });
});

describe('approval token rules', () => {
  const tok = (approver: string, exp = EXP, tier: 'approve' | 'two-step' = 'two-step') => mintApproval(KEY, { entry: ENTRY, tier, approver, exp });
  const check = (tokens: string[], drafter = 'jwt:accountant', tier: 'approve' | 'two_step' = 'two_step') =>
    checkApprovals(KEY, tokens, { entry: ENTRY, tier, drafter, nowMs: NOW, answers: ['ja', 'ja'] });
  it('treats approvers that differ only in case as one approver', () => {
    expect(check([tok('Alice'), tok('alice')], 'jwt:accountant', 'approve').problems.join()).toContain('repeats approver');
  });
  it('compares the drafter case-insensitively', () => {
    expect(check([tok('JWT:Accountant')], 'jwt:accountant', 'approve').problems.join()).toContain('drafter');
  });
  it('refuses a token valid more than 14 days ahead', () => {
    expect(check([tok('alice', NOW / 1000 + 15 * 86400), tok('bob')]).problems.join()).toContain('more than 14 days ahead');
  });
  it('refuses a token whose exp is not an integer', () => {
    expect(check([tok('alice', EXP + 0.5), tok('bob')]).problems.join()).toContain('not a valid approval token');
  });
});
