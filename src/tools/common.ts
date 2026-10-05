import { createHash } from 'node:crypto';
import { z } from 'zod';

export const divisionField = z.number().int().positive().optional()
  .describe('Exact division (administration) code. Omit to use the user\'s current division; call list_divisions to see others.');

export const topField = (def = 50, max = 500) =>
  z.number().int().min(1).max(max).default(def).describe(`Maximum rows to return (default ${def}, max ${max}).`);

export const guidField = (what: string) =>
  z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, 'must be a GUID').describe(what);

export const isoDate = (what: string) =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD').describe(what);

export const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export const hashPayload = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export const fmt = (n: number) => n.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Sum amounts per currency code (no silent mixing of currencies). */
export function totalsByCurrency(rows: { amount: number; currency: string }[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const r of rows) t[r.currency] = round2((t[r.currency] ?? 0) + r.amount);
  return t;
}

export const totalsText = (t: Record<string, number>) =>
  Object.entries(t).map(([c, v]) => `${c} ${fmt(v)}`).join(' + ') || 'EUR 0,00';

export const todayIso = () => new Date().toISOString().slice(0, 10);
export const trimCode = (c: unknown) => (typeof c === 'string' ? c.trim() : c);
