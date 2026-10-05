import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { decrypt, encrypt, sha256 } from './crypto.js';
import type { Region } from './config.js';

export interface UserRecord {
  id: number;
  region: Region;
  exactUserId: string;
  name: string;
  email: string | null;
  currentDivision: number;
  disconnected: boolean;
}

export interface ExactTokens { accessToken: string; refreshToken: string; expiresAt: number }

export interface ClientRecord { clientId: string; clientSecretHash: string | null; redirectUris: string[]; name: string | null }
export interface PendingAuth { id: string; clientId: string; redirectUri: string; state: string | null; codeChallenge: string; region: Region | null; expiresAt: number }
export interface AuthCode { clientId: string; redirectUri: string; codeChallenge: string; userId: number }
export interface TokenRow { userId: number; clientId: string; accessExpiresAt: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY, client_secret_hash TEXT, redirect_uris TEXT NOT NULL, name TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending_auth (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, state TEXT, code_challenge TEXT NOT NULL,
  region TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, region TEXT NOT NULL, exact_user_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT,
  current_division INTEGER NOT NULL, access_enc TEXT NOT NULL, refresh_enc TEXT NOT NULL, expires_at INTEGER NOT NULL,
  disconnected INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, UNIQUE(region, exact_user_id));
CREATE TABLE IF NOT EXISTS auth_codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
  user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  access_hash TEXT PRIMARY KEY, refresh_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, user_id INTEGER NOT NULL,
  access_expires_at INTEGER NOT NULL, refresh_expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id INTEGER NOT NULL, division INTEGER, tool TEXT NOT NULL,
  payload_hash TEXT NOT NULL, exact_id TEXT);
`;

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;
export const PENDING_TTL_MS = 15 * 60 * 1000;

export class Store {
  readonly db: Database.Database;

  constructor(path: string, private key: Buffer, private now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  // --- clients ---
  saveClient(c: ClientRecord) {
    this.db.prepare('INSERT INTO clients VALUES (?,?,?,?,?)').run(c.clientId, c.clientSecretHash, JSON.stringify(c.redirectUris), c.name, this.now());
  }
  getClient(clientId: string): ClientRecord | null {
    const r = this.db.prepare('SELECT * FROM clients WHERE client_id=?').get(clientId) as any;
    return r ? { clientId: r.client_id, clientSecretHash: r.client_secret_hash, redirectUris: JSON.parse(r.redirect_uris), name: r.name } : null;
  }

  // --- pending auth ---
  savePending(p: PendingAuth) {
    this.db.prepare('INSERT INTO pending_auth VALUES (?,?,?,?,?,?,?)').run(p.id, p.clientId, p.redirectUri, p.state, p.codeChallenge, p.region, p.expiresAt);
  }
  getPending(id: string): PendingAuth | null {
    const r = this.db.prepare('SELECT * FROM pending_auth WHERE id=?').get(id) as any;
    if (!r || r.expires_at < this.now()) return null;
    return { id: r.id, clientId: r.client_id, redirectUri: r.redirect_uri, state: r.state, codeChallenge: r.code_challenge, region: r.region, expiresAt: r.expires_at };
  }
  setPendingRegion(id: string, region: Region) {
    this.db.prepare('UPDATE pending_auth SET region=? WHERE id=?').run(region, id);
  }
  deletePending(id: string) { this.db.prepare('DELETE FROM pending_auth WHERE id=?').run(id); }

  // --- users & Exact tokens ---
  upsertUser(u: { region: Region; exactUserId: string; name: string; email: string | null; currentDivision: number }, t: ExactTokens): UserRecord {
    this.db.prepare(`INSERT INTO users (region, exact_user_id, name, email, current_division, access_enc, refresh_enc, expires_at, disconnected, updated_at)
      VALUES (?,?,?,?,?,?,?,?,0,?)
      ON CONFLICT(region, exact_user_id) DO UPDATE SET name=excluded.name, email=excluded.email, current_division=excluded.current_division,
        access_enc=excluded.access_enc, refresh_enc=excluded.refresh_enc, expires_at=excluded.expires_at, disconnected=0, updated_at=excluded.updated_at`)
      .run(u.region, u.exactUserId, u.name, u.email, u.currentDivision, encrypt(this.key, t.accessToken), encrypt(this.key, t.refreshToken), t.expiresAt, this.now());
    const row = this.db.prepare('SELECT * FROM users WHERE region=? AND exact_user_id=?').get(u.region, u.exactUserId) as any;
    return this.toUser(row);
  }
  getUser(id: number): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as any;
    return row ? this.toUser(row) : null;
  }
  getExactTokens(userId: number): ExactTokens | null {
    const r = this.db.prepare('SELECT access_enc, refresh_enc, expires_at FROM users WHERE id=?').get(userId) as any;
    if (!r) return null;
    return { accessToken: decrypt(this.key, r.access_enc), refreshToken: decrypt(this.key, r.refresh_enc), expiresAt: r.expires_at };
  }
  saveExactTokens(userId: number, t: ExactTokens) {
    this.db.prepare('UPDATE users SET access_enc=?, refresh_enc=?, expires_at=?, disconnected=0, updated_at=? WHERE id=?')
      .run(encrypt(this.key, t.accessToken), encrypt(this.key, t.refreshToken), t.expiresAt, this.now(), userId);
  }
  markDisconnected(userId: number) {
    this.db.prepare('UPDATE users SET disconnected=1, updated_at=? WHERE id=?').run(this.now(), userId);
  }
  private toUser(r: any): UserRecord {
    return { id: r.id, region: r.region, exactUserId: r.exact_user_id, name: r.name, email: r.email, currentDivision: r.current_division, disconnected: !!r.disconnected };
  }

  // --- our authorization codes ---
  saveCode(code: string, c: AuthCode) {
    this.db.prepare('INSERT INTO auth_codes VALUES (?,?,?,?,?,?)').run(sha256(code), c.clientId, c.redirectUri, c.codeChallenge, c.userId, this.now() + CODE_TTL_MS);
  }
  /** Single use: the row is deleted whether or not it is still valid. */
  consumeCode(code: string): AuthCode | null {
    const h = sha256(code);
    const r = this.db.prepare('SELECT * FROM auth_codes WHERE code_hash=?').get(h) as any;
    if (!r) return null;
    this.db.prepare('DELETE FROM auth_codes WHERE code_hash=?').run(h);
    if (r.expires_at < this.now()) return null;
    return { clientId: r.client_id, redirectUri: r.redirect_uri, codeChallenge: r.code_challenge, userId: r.user_id };
  }

  // --- our access/refresh tokens (hashes only) ---
  saveTokens(access: string, refresh: string, clientId: string, userId: number) {
    const now = this.now();
    this.db.prepare('INSERT INTO tokens VALUES (?,?,?,?,?,?)').run(sha256(access), sha256(refresh), clientId, userId, now + ACCESS_TTL_MS, now + REFRESH_TTL_MS);
  }
  resolveAccess(access: string): TokenRow | null {
    const r = this.db.prepare('SELECT * FROM tokens WHERE access_hash=?').get(sha256(access)) as any;
    if (!r || r.access_expires_at < this.now()) return null;
    return { userId: r.user_id, clientId: r.client_id, accessExpiresAt: r.access_expires_at };
  }
  /** Rotating refresh: old row is removed; a replayed refresh token finds nothing. */
  consumeRefresh(refresh: string): { userId: number; clientId: string } | null {
    const h = sha256(refresh);
    const r = this.db.prepare('SELECT * FROM tokens WHERE refresh_hash=?').get(h) as any;
    if (!r) return null;
    this.db.prepare('DELETE FROM tokens WHERE refresh_hash=?').run(h);
    if (r.refresh_expires_at < this.now()) return null;
    return { userId: r.user_id, clientId: r.client_id };
  }

  purgeExpired() {
    const now = this.now();
    this.db.prepare('DELETE FROM pending_auth WHERE expires_at<?').run(now);
    this.db.prepare('DELETE FROM auth_codes WHERE expires_at<?').run(now);
    this.db.prepare('DELETE FROM tokens WHERE refresh_expires_at<?').run(now);
  }

  audit(e: { userId: number; division: number | null; tool: string; payloadHash: string; exactId?: string | null }) {
    this.db.prepare('INSERT INTO audit_log (ts,user_id,division,tool,payload_hash,exact_id) VALUES (?,?,?,?,?,?)')
      .run(this.now(), e.userId, e.division, e.tool, e.payloadHash, e.exactId ?? null);
  }
}
