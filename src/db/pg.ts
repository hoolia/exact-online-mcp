import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

/** The subset of pg.Pool the server uses; pg-mem's adapter provides the same. */
export interface PoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
  end(): Promise<void>;
}

export function createPool(databaseUrl: string): PoolLike {
  return new pg.Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 30_000 }) as unknown as PoolLike;
}

export async function transaction<T>(pool: PoolLike, fn: (q: Queryable) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** migrations/ of the repository, from src/ (tsx, vitest) and from dist/src/ (image). */
export function migrationsDir(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(d, 'package.json')) && existsSync(join(d, 'migrations'))) return join(d, 'migrations');
    d = dirname(d);
  }
  throw new Error('migrations directory not found');
}

/** Applies migrations/NNN_*.sql in order, each once, each in its own transaction. */
export async function migrate(pool: PoolLike, dir = migrationsDir()): Promise<string[]> {
  const exists = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'schema_migrations'`);
  if (!exists.rows.length) await pool.query('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)');
  const done = new Set((await pool.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  const applied: string[] = [];
  for (const f of readdirSync(dir).filter((n) => /^\d+_.+\.sql$/.test(n)).sort()) {
    const version = f.replace(/\.sql$/, '');
    if (done.has(version)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    await transaction(pool, async (q) => {
      await q.query(sql);
      await q.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [version, new Date().toISOString()]);
    });
    applied.push(version);
  }
  return applied;
}
