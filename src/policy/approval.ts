import { createHash } from 'node:crypto';
import { sign, unsign } from '../crypto.js';
import { TIER_RANK, type Tier } from './tiers.js';

/** What an approver signed: this draft, at this tier, until this time, optionally for this answer text. */
export interface Approval {
  v: 1;
  /** draft id: Exact entry GUID (lower case) or matchset:<sha256> */
  entry: string;
  tier: Exclude<Tier, 'auto'>;
  approver: string;
  /** expiry, epoch seconds */
  exp: number;
  /** SHA-256 of the normalised answer text the approver gave; when present the call must carry that answer */
  ans?: string;
}

/** The contract spelling of a tier ("two-step") and the internal one ("two_step") are both accepted. */
export const parseTier = (t: unknown): Tier | null => (t === 'two-step' || t === 'two_step' ? 'two_step' : t === 'approve' ? 'approve' : t === 'auto' ? 'auto' : null);
export const contractTier = (t: Tier) => (t === 'two_step' ? 'two-step' : t);

export const normaliseAnswer = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
export const answerHash = (s: string) => createHash('sha256').update(normaliseAnswer(s)).digest('hex');

export function mintApproval(key: string, a: { entry: string; tier: 'approve' | 'two_step' | 'two-step'; approver: string; exp: number; answer?: string }): string {
  const body: Approval = { v: 1, entry: a.entry.toLowerCase(), tier: parseTier(a.tier) as Approval['tier'], approver: a.approver, exp: a.exp, ...(a.answer !== undefined ? { ans: answerHash(a.answer) } : {}) };
  return sign(key, Buffer.from(JSON.stringify(body)).toString('base64url'));
}

export function readApproval(key: string, token: string): Approval | null {
  const value = unsign(key, token);
  if (!value) return null;
  try {
    const a = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (a?.v !== 1 || typeof a.entry !== 'string' || typeof a.approver !== 'string' || !a.approver || typeof a.exp !== 'number') return null;
    const tier = parseTier(a.tier);
    if (tier !== 'approve' && tier !== 'two_step') return null;
    if (a.ans !== undefined && typeof a.ans !== 'string') return null;
    return { ...a, tier } as Approval;
  } catch {
    return null;
  }
}

export interface AnswerPolicy { approve: RegExp; reject: RegExp }

export const DEFAULT_ANSWER_POLICY: AnswerPolicy = {
  approve: /^(ja|yes|akkoord|goedgekeurd|goed|approved?|ok|oke|okay|prima|doen)\b/i,
  reject: /^(nee|no|niet|afgekeurd|afwijzen|reject(ed)?|stop|wacht)\b/i,
};

export interface ApprovalCheck { ok: boolean; approvers: string[]; problems: string[] }

/**
 * Checks the tokens and the approvers' answers against the draft and its tier. Approve needs one valid token,
 * two-step two tokens from different approvers, each with an affirmative answer; a token that carries an answer
 * hash only counts with that answer. The caller that drafted the entry cannot approve it.
 */
export function checkApprovals(key: string, tokens: string[], o: { entry: string; tier: Tier; drafter: string; nowMs: number; answers?: string[]; answerPolicy?: AnswerPolicy }): ApprovalCheck {
  if (o.tier === 'auto') return { ok: true, approvers: [], problems: [] };
  const need = o.tier === 'two_step' ? 2 : 1;
  const policy = o.answerPolicy ?? DEFAULT_ANSWER_POLICY;
  const problems: string[] = [];
  const answers = (o.answers ?? []).map((s) => s.trim()).filter(Boolean);
  answers.forEach((ans, i) => {
    if (policy.reject.test(ans) || !policy.approve.test(ans)) problems.push(`answer ${i + 1} is not an approval`);
  });
  if (answers.length < need) problems.push(`tier ${contractTier(o.tier)} needs ${need} approving answer(s), got ${answers.length}`);
  const hashes = new Set(answers.map(answerHash));
  const approvers = new Set<string>();
  tokens.forEach((t, i) => {
    const a = readApproval(key, t);
    const n = `token ${i + 1}`;
    if (!a) return problems.push(`${n} is not a valid approval token`);
    if (a.entry !== o.entry.toLowerCase()) return problems.push(`${n} approves another draft`);
    if (a.exp * 1000 <= o.nowMs) return problems.push(`${n} expired`);
    if (TIER_RANK[a.tier] < TIER_RANK[o.tier]) return problems.push(`${n} is for tier ${contractTier(a.tier)}, the draft needs ${contractTier(o.tier)}`);
    if (a.approver === o.drafter) return problems.push(`${n} is from the drafter, who cannot approve their own entry`);
    if (approvers.has(a.approver)) return problems.push(`${n} repeats approver ${a.approver}`);
    if (a.ans !== undefined && !hashes.has(a.ans)) return problems.push(`${n} was issued for a different answer`);
    approvers.add(a.approver);
  });
  if (approvers.size < need) problems.push(`tier ${contractTier(o.tier)} needs ${need} approval token(s) from different approvers, got ${approvers.size}`);
  const ok = approvers.size >= need && !problems.length;
  return { ok, approvers: [...approvers], problems };
}
