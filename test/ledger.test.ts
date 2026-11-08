import { describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { migrate, type PoolLike } from '../src/db/pg.js';
import { DuplicateKeyError, type NewLedgerRow } from '../src/db/ledger.js';
import { memStore } from './pgmem.js';

const SUPPLIER = '11111111-1111-1111-1111-111111111111';
const ENTRY = '33333333-3333-3333-3333-333333333333';
const row = (over: Partial<NewLedgerRow> = {}): NewLedgerRow => ({
  division: 100, kind: 'purchase', supplierId: SUPPLIER, refNorm: '2026123', journal: '60', entryDate: '2026-11-01', currency: 'EUR',
  amountCents: 12100, pdfSha256: 'a'.repeat(64), tier: 'approve', tierReasons: [], createdBy: 'jwt:sa', createdAt: new Date('2026-11-02T10:00:00Z'), holdUntil: null, ...over,
});
const query = { division: 100, kind: 'purchase' as const, supplierId: SUPPLIER, journal: '60', refNorm: 'OTHER', amountCents: 999, entryDate: '2026-11-01', pdfSha256: null, windowDays: 7 };

describe('migrations', () => {
  it('apply once and record their version', async () => {
    const { Pool } = newDb().adapters.createPg();
    const pool = new Pool() as unknown as PoolLike;
    expect(await migrate(pool)).toEqual(['001_ledger_and_audit', '002_matchset']);
    expect(await migrate(pool)).toEqual([]);
  });
});

describe('ledger', () => {
  it('maps the drafted Exact entry GUID and finds it again', async () => {
    const s = await memStore();
    const id = await s.reserve(row());
    await s.markDrafted(id, ENTRY.toUpperCase(), 8);
    const r = await s.getByExactId(100, ENTRY);
    expect(r).toMatchObject({ id, status: 'drafted', exactEntryId: ENTRY, exactEntryNumber: 8, entryDate: '2026-11-01', amountCents: 12100 });
  });
  it('refuses a second reservation with the same supplier and invoice number', async () => {
    const s = await memStore();
    await s.reserve(row());
    await expect(s.reserve(row({ amountCents: 1 }))).rejects.toBeInstanceOf(DuplicateKeyError);
    // another division is another administration
    await expect(s.reserve(row({ division: 200 }))).resolves.toBeGreaterThan(0);
  });
  it('finds duplicates by key, by PDF and by amount inside the date window', async () => {
    const s = await memStore();
    await s.reserve(row());
    expect(await s.findDuplicates({ ...query, refNorm: '2026123' })).toHaveLength(1);
    expect(await s.findDuplicates({ ...query, pdfSha256: 'a'.repeat(64) })).toHaveLength(1);
    expect(await s.findDuplicates({ ...query, amountCents: 12100, entryDate: '2026-11-06' })).toHaveLength(1);
    expect(await s.findDuplicates({ ...query, amountCents: 12100, entryDate: '2026-11-20' })).toHaveLength(0);
    expect(await s.findDuplicates(query)).toHaveLength(0);
  });
  it('counts released supplier entries, not reservations or drafts', async () => {
    const s = await memStore();
    const a = await s.reserve(row({ refNorm: '1' }));
    await s.reserve(row({ refNorm: '2' }));
    await s.markDrafted(a, ENTRY, 1);
    expect(await s.supplierEntryCount(100, SUPPLIER)).toBe(0);
    await s.markReleased(a, 'approved', ['alice'], new Date());
    expect(await s.supplierEntryCount(100, SUPPLIER)).toBe(1);
  });
  it('releases an entry once', async () => {
    const s = await memStore();
    const id = await s.reserve(row());
    await s.markDrafted(id, ENTRY, 1);
    expect(await s.markReleased(id, 'approved', ['alice'], new Date())).toBe(true);
    expect(await s.markReleased(id, 'approved', ['bob'], new Date())).toBe(false);
    expect((await s.getByExactId(100, ENTRY))!.approvedBy).toEqual(['alice']);
  });
  it('writes audit rows', async () => {
    const s = await memStore();
    await s.audit({ ts: new Date(), callerKind: 'workload', callerId: 'jwt:sa', callerName: 'sa', clientId: 'agent', exactUserId: null, division: 100, tool: 'whoami', argsSha256: 'x', outcome: 'ok', exactStatus: 200, exactId: null, modelVersion: 'm1' });
    const { rows } = await s.pool.query('SELECT tool, outcome, exact_status FROM audit_log');
    expect(rows).toEqual([{ tool: 'whoami', outcome: 'ok', exact_status: 200 }]);
  });
});
