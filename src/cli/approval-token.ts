/**
 * Mints an approval token for process_entry or create_matchset, for an approval flow or an operator.
 * Usage: APPROVAL_SIGNING_KEY=... node dist/cli/approval-token.js --entry <draftId> --tier approve|two-step --approver <id> [--channel <ch>] [--answer <text>] [--hours 24]
 */
import { parseArgs } from 'node:util';
import { mintApproval } from '../policy/approval.js';

const { values } = parseArgs({ options: { entry: { type: 'string' }, tier: { type: 'string' }, approver: { type: 'string' }, channel: { type: 'string' }, hours: { type: 'string', default: '24' }, answer: { type: 'string' } } });
const key = process.env.APPROVAL_SIGNING_KEY;
const hours = Number(values.hours);
const twoStep = values.tier === 'two_step' || values.tier === 'two-step';
if (!key || key.length < 32 || !values.entry || !values.approver || (values.tier !== 'approve' && !twoStep) || (twoStep && !values.channel?.trim()) || !(hours > 0 && hours <= 24 * 14)) {
  console.error('usage: APPROVAL_SIGNING_KEY=<32+ chars> approval-token --entry <entry guid|matchset:id> --tier approve|two-step --approver <id> [--channel <ch>, required for two-step] [--answer <text>] [--hours 1-336]');
  process.exit(2);
}
const now = Math.floor(Date.now() / 1000);
process.stdout.write(`${mintApproval(key, { entry: values.entry, tier: values.tier as 'approve' | 'two-step', approver: values.approver, ch: values.channel, iat: now, answer: values.answer, exp: Math.floor(now + hours * 3600) })}\n`);
