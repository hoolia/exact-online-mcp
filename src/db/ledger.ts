import { transaction, type PoolLike } from './pg.js';

export type EntryKind = 'purchase' | 'sales' | 'general_journal';
/** unknown: the POST to Exact failed in a way that may still have created the entry; the key stays taken */
export type LedgerStatus = 'reserved' | 'unknown' | 'drafted' | 'approved' | 'processed';

export interface LedgerRow {
  id: number;
  division: number;
  kind: EntryKind;
  supplierId: string | null;
  refNorm: string;
  journal: string;
  entryDate: string;
  currency: string;
  amountCents: number;
  pdfSha256: string | null;
  exactEntryId: string | null;
  exactEntryNumber: number | null;
  status: LedgerStatus;
  tier: string;
  tierReasons: string[];
  createdBy: string;
  createdAt: string;
  holdUntil: string | null;
  approvedBy: string[];
  processedAt: string | null;
}

export interface NewLedgerRow {
  division: number;
  kind: EntryKind;
  supplierId: string | null;
  refNorm: string;
  journal: string;
  entryDate: string;
  currency: string;
  amountCents: number;
  pdfSha256: string | null;
  tier: string;
  tierReasons: string[];
  createdBy: string;
  createdAt: Date;
  holdUntil: Date | null;
}

export interface AuditRow {
  ts: Date;
  callerKind: string;
  callerId: string;
  callerName: string | null;
  clientId: string | null;
  exactUserId: string | null;
  division: number | null;
  tool: string;
  argsSha256: string;
  outcome: 'ok' | 'refused' | 'error';
  exactStatus: number | null;
  exactId: string | null;
  modelVersion: string | null;
}

export class DuplicateKeyError extends Error {
  constructor() { super('ledger key exists'); this.name = 'DuplicateKeyError'; }
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

const toRow = (r: any): LedgerRow => ({
  id: Number(r.id), division: Number(r.division), kind: r.kind, supplierId: r.supplier_id ?? null, refNorm: r.ref_norm,
  journal: r.journal, entryDate: day(r.entry_date), currency: r.currency, amountCents: Number(r.amount_cents),
  pdfSha256: r.pdf_sha256 ?? null, exactEntryId: r.exact_entry_id ?? null,
  exactEntryNumber: r.exact_entry_number == null ? null : Number(r.exact_entry_number), status: r.status, tier: r.tier,
  tierReasons: JSON.parse(r.tier_reasons || '[]'), createdBy: r.created_by, createdAt: iso(r.created_at)!,
  holdUntil: iso(r.hold_until), approvedBy: r.approved_by ? JSON.parse(r.approved_by) : [], processedAt: iso(r.processed_at),
});

export const dedupeKey = (r: { kind: EntryKind; supplierId: string | null; journal: string; refNorm: string }) =>
  r.kind === 'general_journal' ? `general_journal|${r.journal}|${r.refNorm}` : `${r.kind}|${r.supplierId!.toLowerCase()}|${r.refNorm}`;

const addDays = (isoDate: string, n: number) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Postgres store for the idempotency ledger and the tool call audit log. */
export class PgStore {
  constructor(readonly pool: PoolLike) {}

  /**
   * Entries that make a new one a duplicate: same key (supplier or journal plus normalised reference),
   * same PDF, or same supplier and amount with an entry date inside the window.
   */
  async findDuplicates(q: { division: number; kind: EntryKind; supplierId: string | null; journal: string; refNorm: string; amountCents: number; entryDate: string; pdfSha256: string | null; windowDays: number }): Promise<LedgerRow[]> {
    const params: unknown[] = [q.division, dedupeKey(q)];
    const ors = ['dedupe_key = $2'];
    if (q.pdfSha256) { params.push(q.pdfSha256); ors.push(`pdf_sha256 = $${params.length}`); }
    if ((q.kind === 'purchase' || q.kind === 'sales') && q.supplierId) {
      params.push(q.supplierId.toLowerCase(), q.amountCents, addDays(q.entryDate, -q.windowDays), addDays(q.entryDate, q.windowDays));
      const n = params.length;
      ors.push(`(kind = '${q.kind}' AND supplier_id = $${n - 3} AND amount_cents = $${n - 2} AND entry_date >= $${n - 1} AND entry_date <= $${n})`);
    }
    const { rows } = await this.pool.query(`SELECT * FROM ledger WHERE division = $1 AND (${ors.join(' OR ')}) ORDER BY id`, params);
    return rows.map(toRow);
  }

  /** Inserts a reservation; DuplicateKeyError when another call holds the same key. */
  async reserve(r: NewLedgerRow): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ id: string }>(
        `INSERT INTO ledger (division, kind, supplier_id, ref_norm, journal, entry_date, currency, amount_cents, pdf_sha256, dedupe_key, status, tier, tier_reasons, created_by, created_at, hold_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reserved',$11,$12,$13,$14,$15) RETURNING id`,
        [r.division, r.kind, r.supplierId?.toLowerCase() ?? null, r.refNorm, r.journal, r.entryDate, r.currency, r.amountCents, r.pdfSha256,
          dedupeKey(r), r.tier, JSON.stringify(r.tierReasons), r.createdBy, r.createdAt.toISOString(), r.holdUntil?.toISOString() ?? null],
      );
      return Number(rows[0]!.id);
    } catch (e: any) {
      if (e?.code === '23505' || /duplicate key|unique/i.test(String(e?.message))) throw new DuplicateKeyError();
      throw e;
    }
  }

  async release(id: number) {
    await this.pool.query(`DELETE FROM ledger WHERE id = $1 AND status = 'reserved'`, [id]);
  }

  async markUnknown(id: number) {
    await this.pool.query(`UPDATE ledger SET status = 'unknown' WHERE id = $1 AND status = 'reserved'`, [id]);
  }

  async markDrafted(id: number, exactEntryId: string, entryNumber: number | null) {
    await this.pool.query(`UPDATE ledger SET status = 'drafted', exact_entry_id = $2, exact_entry_number = $3 WHERE id = $1`, [id, exactEntryId.toLowerCase(), entryNumber]);
  }

  async getByExactId(division: number, exactEntryId: string): Promise<LedgerRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM ledger WHERE division = $1 AND exact_entry_id = $2', [division, exactEntryId.toLowerCase()]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async findByPdf(division: number, sha: string): Promise<LedgerRow[]> {
    const { rows } = await this.pool.query('SELECT * FROM ledger WHERE division = $1 AND pdf_sha256 = $2 ORDER BY id', [division, sha]);
    return rows.map(toRow);
  }

  async setPdf(id: number, sha: string) {
    await this.pool.query('UPDATE ledger SET pdf_sha256 = $2 WHERE id = $1', [id, sha]);
  }

  /** Earlier entries of this supplier that were released (approved or processed); drafts do not count. */
  async supplierEntryCount(division: number, supplierId: string): Promise<number> {
    const { rows } = await this.pool.query(`SELECT COUNT(*) AS n FROM ledger WHERE division = $1 AND supplier_id = $2 AND status IN ('approved', 'processed')`, [division, supplierId.toLowerCase()]);
    return Number(rows[0]?.n ?? 0);
  }

  /** Moves drafted to approved or processed exactly once; false when another call got there first. */
  async markReleased(id: number, status: 'approved' | 'processed', approvers: string[], at: Date): Promise<boolean> {
    return transaction(this.pool, async (q) => {
      const r = await q.query(`UPDATE ledger SET status = $2, approved_by = $3, processed_at = $4 WHERE id = $1 AND status = 'drafted'`, [id, status, JSON.stringify(approvers), at.toISOString()]);
      return (r.rowCount ?? 0) === 1;
    });
  }

  /** Status of a match set upload; null when it was never reserved. */
  async matchsetStatus(draftId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ status: string }>('SELECT status FROM matchset WHERE draft_id = $1', [draftId]);
    return rows[0]?.status ?? null;
  }

  /** Reserves a match set upload; DuplicateKeyError when it is uploaded or another call holds it. */
  async reserveMatchset(m: { draftId: string; division: number; approvers: string[]; createdBy: string; at: Date }) {
    try {
      await this.pool.query(`INSERT INTO matchset (draft_id, division, status, approved_by, created_by, created_at) VALUES ($1,$2,'reserved',$3,$4,$5)`,
        [m.draftId, m.division, JSON.stringify(m.approvers), m.createdBy, m.at.toISOString()]);
    } catch (e: any) {
      if (e?.code === '23505' || /duplicate key|unique/i.test(String(e?.message))) throw new DuplicateKeyError();
      throw e;
    }
  }

  async finishMatchset(draftId: string, outcome: 'uploaded' | 'unknown' | 'failed') {
    if (outcome === 'failed') await this.pool.query(`DELETE FROM matchset WHERE draft_id = $1 AND status = 'reserved'`, [draftId]);
    else await this.pool.query(`UPDATE matchset SET status = $2 WHERE draft_id = $1 AND status = 'reserved'`, [draftId, outcome]);
  }

  async audit(a: AuditRow) {
    await this.pool.query(
      `INSERT INTO audit_log (ts, caller_kind, caller_id, caller_name, client_id, exact_user_id, division, tool, args_sha256, outcome, exact_status, exact_id, model_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [a.ts.toISOString(), a.callerKind, a.callerId, a.callerName, a.clientId, a.exactUserId, a.division, a.tool, a.argsSha256, a.outcome, a.exactStatus, a.exactId, a.modelVersion],
    );
  }
}
