import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { Config, Region } from '../config.js';
import type { Logger } from '../logger.js';
import { type Store, ACCESS_TTL_MS, PENDING_TTL_MS } from '../store.js';
import { pkceS256, randomToken, sha256, sign, unsign } from '../crypto.js';
import { apiBase, authUrl } from '../exact/regions.js';
import { exchangeCode, type FetchFn } from '../exact/tokens.js';
import { errorPage, regionPage } from './pages.js';

export const DEFAULT_REDIRECTS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

export function redirectAllowed(cfg: Config, uri: string): boolean {
  if ([...DEFAULT_REDIRECTS, ...cfg.extraRedirectUris].includes(uri)) return true;
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && !u.hash;
  } catch { return false; }
}

const oauthError = (res: Response, status: number, error: string, description: string) =>
  res.status(status).set('Cache-Control', 'no-store').json({ error, error_description: description });

function redirectWith(redirectUri: string, params: Record<string, string | null | undefined>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

export interface OAuthDeps { cfg: Config; store: Store; log: Logger; fetchImpl: FetchFn }

export function mountOAuth(app: Express, { cfg, store, log, fetchImpl }: OAuthDeps) {
  const base = cfg.publicBaseUrl;
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const form = express.urlencoded({ extended: false });

  // --- discovery ---
  const resourceMeta = (_: Request, res: Response) => res.json({
    resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'],
  });
  app.get('/.well-known/oauth-protected-resource', resourceMeta);
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMeta);

  const asMeta = (_: Request, res: Response) => res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  });
  app.get('/.well-known/oauth-authorization-server', asMeta);
  app.get('/.well-known/oauth-authorization-server/mcp', asMeta);

  // --- RFC 7591 dynamic client registration ---
  app.post('/register', limiter, express.json(), (req, res) => {
    const b = req.body ?? {};
    const uris: unknown = b.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === 'string')) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be a non-empty array of strings');
    }
    const bad = (uris as string[]).find((u) => !redirectAllowed(cfg, u));
    if (bad) return oauthError(res, 400, 'invalid_redirect_uri', `redirect_uri not allowed: ${bad}`);
    const method = b.token_endpoint_auth_method ?? 'none';
    if (!['none', 'client_secret_post'].includes(method)) {
      return oauthError(res, 400, 'invalid_client_metadata', 'unsupported token_endpoint_auth_method');
    }
    const clientId = randomToken(16);
    const secret = method === 'client_secret_post' ? randomToken(32) : null;
    const name = typeof b.client_name === 'string' ? b.client_name.slice(0, 100) : null;
    store.saveClient({ clientId, clientSecretHash: secret ? sha256(secret) : null, redirectUris: uris as string[], name });
    res.status(201).json({
      client_id: clientId, ...(secret ? { client_secret: secret } : {}), client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name ?? undefined, redirect_uris: uris, token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    });
  });

  // --- authorize ---
  app.get('/authorize', limiter, (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const client = q.client_id ? store.getClient(q.client_id) : null;
    if (!client || !q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
      return res.status(400).send(errorPage('Invalid request', 'Unknown client or redirect URI.'));
    }
    const fail = (error: string, description: string) =>
      res.redirect(redirectWith(q.redirect_uri!, { error, error_description: description, state: q.state }));
    if (q.response_type !== 'code') return fail('unsupported_response_type', 'response_type must be code');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return fail('invalid_request', 'PKCE with S256 is required');

    const id = randomToken(24);
    const onlyRegion = cfg.enabledRegions.length === 1 ? cfg.enabledRegions[0]! : null;
    store.savePending({
      id, clientId: client.clientId, redirectUri: q.redirect_uri, state: q.state ?? null,
      codeChallenge: q.code_challenge, region: onlyRegion, expiresAt: Date.now() + PENDING_TTL_MS,
    });
    const signed = sign(cfg.sessionSigningKey, id);
    if (onlyRegion) return res.redirect(exactAuthRedirect(signed, onlyRegion));
    res.type('html').send(regionPage(signed, cfg.enabledRegions));
  });

  function exactAuthRedirect(signedState: string, region: Region) {
    const u = new URL(authUrl(region));
    u.searchParams.set('client_id', cfg.exactClientId);
    u.searchParams.set('redirect_uri', cfg.exactRedirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('state', signedState);
    return u.toString();
  }

  app.get('/exact/start', limiter, (req, res) => {
    const id = unsign(cfg.sessionSigningKey, String(req.query.p ?? ''));
    const region = String(req.query.region ?? '') as Region;
    const pending = id ? store.getPending(id) : null;
    if (!pending || !cfg.enabledRegions.includes(region)) {
      return res.status(400).send(errorPage('Invalid request', 'This login session is invalid or has expired.'));
    }
    store.setPendingRegion(pending.id, region);
    res.redirect(exactAuthRedirect(sign(cfg.sessionSigningKey, pending.id), region));
  });

  // --- Exact callback ---
  app.get('/exact/callback', limiter, async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const id = unsign(cfg.sessionSigningKey, q.state ?? '');
    const pending = id ? store.getPending(id) : null;
    if (!pending || !pending.region) {
      return res.status(400).send(errorPage('Login expired', 'This login session is invalid or has expired.'));
    }
    if (q.error || !q.code) {
      store.deletePending(pending.id);
      return res.redirect(redirectWith(pending.redirectUri, { error: 'access_denied', error_description: 'Exact Online login was not completed', state: pending.state }));
    }
    try {
      const tokens = await exchangeCode(cfg, fetchImpl, pending.region, q.code);
      const meRes = await fetchImpl(`${apiBase(pending.region)}/current/Me?$select=UserID,FullName,Email,CurrentDivision`, {
        headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
      });
      if (!meRes.ok) throw new Error(`current/Me failed (${meRes.status})`);
      const mj: any = await meRes.json();
      const me = mj?.d?.results?.[0] ?? mj?.d;
      const exactUserId = String(me?.UserID ?? '').toLowerCase();
      if (!exactUserId) throw new Error('current/Me returned no UserID');
      if (cfg.allowedExactUserIds.length && !cfg.allowedExactUserIds.includes(exactUserId)) {
        store.deletePending(pending.id);
        log.warn({ exactUserId }, 'login rejected by allowlist');
        return res.status(403).send(errorPage('Not allowed', 'Your Exact Online user is not allowed to use this connector.'));
      }
      const user = store.upsertUser(
        { region: pending.region, exactUserId, name: String(me.FullName ?? ''), email: me.Email ?? null, currentDivision: Number(me.CurrentDivision) },
        tokens,
      );
      store.deletePending(pending.id);
      const code = randomToken(32);
      store.saveCode(code, { clientId: pending.clientId, redirectUri: pending.redirectUri, codeChallenge: pending.codeChallenge, userId: user.id });
      res.redirect(redirectWith(pending.redirectUri, { code, state: pending.state }));
    } catch (err) {
      log.error({ err: String(err) }, 'exact callback failed');
      store.deletePending(pending.id);
      res.status(502).send(errorPage('Login failed', 'Could not complete the Exact Online login.'));
    }
  });

  // --- token endpoint ---
  app.post('/token', limiter, form, (req, res) => {
    const b = req.body ?? {};
    let clientId: string | undefined = b.client_id;
    let secret: string | undefined = b.client_secret;
    const basic = req.headers.authorization?.match(/^Basic (.+)$/i);
    if (basic) {
      const [id, s] = Buffer.from(basic[1]!, 'base64').toString().split(':');
      clientId = id ? decodeURIComponent(id) : clientId;
      secret = s ? decodeURIComponent(s) : secret;
    }
    const client = clientId ? store.getClient(clientId) : null;
    if (!client) return oauthError(res, 401, 'invalid_client', 'Unknown client');
    if (client.clientSecretHash && sha256(secret ?? '') !== client.clientSecretHash) {
      return oauthError(res, 401, 'invalid_client', 'Bad client credentials');
    }

    const issue = (userId: number) => {
      const access = randomToken(32);
      const refresh = randomToken(32);
      store.saveTokens(access, refresh, client.clientId, userId);
      res.set('Cache-Control', 'no-store').json({
        access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh,
      });
    };

    if (b.grant_type === 'authorization_code') {
      const rec = typeof b.code === 'string' ? store.consumeCode(b.code) : null;
      if (!rec || rec.clientId !== client.clientId) return oauthError(res, 400, 'invalid_grant', 'Invalid or expired code');
      if (b.redirect_uri !== rec.redirectUri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
      if (typeof b.code_verifier !== 'string' || pkceS256(b.code_verifier) !== rec.codeChallenge) {
        return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
      }
      return issue(rec.userId);
    }
    if (b.grant_type === 'refresh_token') {
      const rec = typeof b.refresh_token === 'string' ? store.consumeRefresh(b.refresh_token) : null;
      if (!rec || rec.clientId !== client.clientId) return oauthError(res, 400, 'invalid_grant', 'Invalid or expired refresh token');
      const user = store.getUser(rec.userId);
      if (!user || user.disconnected) return oauthError(res, 400, 'invalid_grant', 'Exact Online connection expired; please reconnect');
      return issue(rec.userId);
    }
    return oauthError(res, 400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  });
}
