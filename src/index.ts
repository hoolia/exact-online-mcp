import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { Store } from './store.js';
import { createApp } from './app.js';
import { createPool, migrate } from './db/pg.js';
import { PgStore } from './db/ledger.js';

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const log = createLogger(cfg.logLevel);
const store = new Store(cfg.dbPath, cfg.tokenEncryptionKey);
setInterval(() => store.purgeExpired(), 60 * 60 * 1000).unref();

let ledger: PgStore | null = null;
if (cfg.databaseUrl) {
  const pool = createPool(cfg.databaseUrl);
  try {
    const applied = await migrate(pool);
    if (applied.length) log.info({ applied }, 'database migrated');
  } catch (err) {
    log.fatal({ err: String(err) }, 'database migration failed');
    process.exit(1);
  }
  ledger = new PgStore(pool);
}

const server = createApp({ cfg, store, log, ledger }).listen(cfg.port, () => {
  log.info({ port: cfg.port, baseUrl: cfg.publicBaseUrl, writeTools: cfg.enableWriteTools ? (cfg.writeTools.length ? cfg.writeTools : 'all') : 'none', ledger: !!ledger }, 'exact-online-mcp listening');
});
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
