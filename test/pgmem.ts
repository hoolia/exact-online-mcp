import { newDb } from 'pg-mem';
import { migrate, type PoolLike } from '../src/db/pg.js';
import { PgStore } from '../src/db/ledger.js';

/** In-memory Postgres (pg-mem) with the repository migrations applied. */
export async function memStore(): Promise<PgStore> {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool() as unknown as PoolLike;
  await migrate(pool);
  return new PgStore(pool);
}
