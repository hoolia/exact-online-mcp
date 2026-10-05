import type { Config } from '../config.js';
import type { Store, ExactTokens } from '../store.js';
import type { Logger } from '../logger.js';
import { tokenUrl } from './regions.js';
import { ExactError, RECONNECT_MESSAGE } from './errors.js';

const REFRESH_MARGIN_MS = 30_000;

export type FetchFn = typeof fetch;

export function parseTokenResponse(j: any, now: number): ExactTokens {
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: now + Number(j.expires_in ?? 600) * 1000 };
}

export async function exchangeCode(cfg: Config, fetchImpl: FetchFn, region: Parameters<typeof tokenUrl>[0], code: string, now = Date.now()): Promise<ExactTokens> {
  const res = await fetchImpl(tokenUrl(region), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: cfg.exactRedirectUri,
      client_id: cfg.exactClientId, client_secret: cfg.exactClientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Exact token exchange failed (${res.status})`);
  return parseTokenResponse(await res.json(), now);
}

/**
 * Hands out valid Exact access tokens. Refresh tokens rotate, so refreshes are serialized per user
 * and the new refresh token is persisted before the new access token is returned.
 */
export class TokenManager {
  private locks = new Map<number, Promise<unknown>>();

  constructor(
    private cfg: Config, private store: Store, private log: Logger,
    private fetchImpl: FetchFn = fetch, private now: () => number = Date.now,
  ) {}

  private withLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(userId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.locks.set(userId, tail);
    tail.then(() => { if (this.locks.get(userId) === tail) this.locks.delete(userId); });
    return next;
  }

  /** @param rejected an access token Exact just answered 401 for; forces a refresh if it is still the stored one */
  getAccessToken(userId: number, rejected?: string): Promise<string> {
    return this.withLock(userId, async () => {
      const user = this.store.getUser(userId);
      if (!user || user.disconnected) throw new ExactError('not_connected', RECONNECT_MESSAGE);
      const t = this.store.getExactTokens(userId);
      if (!t) throw new ExactError('not_connected', RECONNECT_MESSAGE);
      const stale = t.expiresAt - REFRESH_MARGIN_MS <= this.now() || t.accessToken === rejected;
      if (!stale) return t.accessToken;
      return this.refresh(userId, user.region, t.refreshToken);
    });
  }

  private async refresh(userId: number, region: Parameters<typeof tokenUrl>[0], refreshToken: string): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(tokenUrl(region), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'refresh_token', refresh_token: refreshToken,
          client_id: this.cfg.exactClientId, client_secret: this.cfg.exactClientSecret,
        }),
      });
    } catch (err) {
      this.log.warn({ userId, err: String(err) }, 'exact token refresh network error');
      throw new ExactError('api', 'Could not reach Exact Online to refresh the connection. Please try again shortly.');
    }
    if (res.status === 400 || res.status === 401) {
      this.log.warn({ userId, status: res.status }, 'exact refresh rejected; marking user disconnected');
      this.store.markDisconnected(userId);
      throw new ExactError('not_connected', RECONNECT_MESSAGE);
    }
    if (!res.ok) throw new ExactError('api', `Exact Online token service returned ${res.status}. Please try again shortly.`);
    const fresh = parseTokenResponse(await res.json(), this.now());
    this.store.saveExactTokens(userId, fresh); // persist the rotated refresh token first
    return fresh.accessToken;
  }
}
