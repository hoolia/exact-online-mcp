import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { loadConfig, type Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';

export const baseEnv = (over: Record<string, string> = {}) => ({
  PUBLIC_BASE_URL: 'https://mcp.test', PORT: '8080', EXACT_CLIENT_ID: 'exact-id', EXACT_CLIENT_SECRET: 'exact-secret',
  EXACT_REDIRECT_URI: 'https://mcp.test/exact/callback', EXACT_DEFAULT_REGION: 'nl',
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'), SESSION_SIGNING_KEY: randomBytes(32).toString('base64'),
  DB_PATH: ':memory:', LOG_LEVEL: 'silent', ...over,
});

export type Handler = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Fake fetch for Exact Online; records calls. Unhandled URLs throw. */
export class FakeExact {
  calls: { url: URL; init: RequestInit }[] = [];
  handlers: Handler[] = [];
  refreshCount = 0;
  fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    this.calls.push({ url, init });
    for (const h of [...this.handlers].reverse()) {
      const r = await h(url, init);
      if (r) return r;
    }
    throw new Error(`Unhandled fetch ${init.method ?? 'GET'} ${url}`);
  };
  on(h: Handler) { this.handlers.push(h); return this; }
  /** Standard OAuth + Me handlers. */
  withLogin(opts: { userId?: string; division?: number; expiresIn?: number; refreshExpiresIn?: number } = {}) {
    const userId = opts.userId ?? 'a1b2c3d4-0000-0000-0000-000000000001';
    return this.on((url, init) => {
      if (url.pathname === '/api/oauth2/token') {
        const p = new URLSearchParams(String(init.body));
        if (p.get('grant_type') === 'refresh_token') this.refreshCount++;
        return json({ access_token: `at-${randomBytes(4).toString('hex')}`, refresh_token: `rt-${randomBytes(4).toString('hex')}`, expires_in: p.get('grant_type') === 'refresh_token' ? (opts.refreshExpiresIn ?? 600) : (opts.expiresIn ?? 600) });
      }
      if (url.pathname === '/api/v1/current/Me') return json({ d: { results: [{ UserID: userId, FullName: 'Test User', Email: 't@example.nl', CurrentDivision: opts.division ?? 100 }] } });
      return undefined;
    });
  }
}

export interface TestEnv { cfg: Config; store: Store; fake: FakeExact; base: string; server: Server; close(): void }

export async function startApp(over: Record<string, string> = {}, now?: () => number): Promise<TestEnv> {
  const cfg = loadConfig(baseEnv(over));
  const store = new Store(':memory:', cfg.tokenEncryptionKey, now);
  const fake = new FakeExact();
  const app = createApp({ cfg, store, log: createLogger('silent'), fetchImpl: fake.fetch, sleep: async () => {}, now });
  const server = await new Promise<Server>((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { cfg, store, fake, base, server, close: () => server.close() };
}

export const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

export const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

/** Runs register → authorize → callback and returns our authorization code + client. */
export async function loginFlow(env: TestEnv, opts: { challenge?: string; redirect?: string } = {}) {
  const reg = await fetch(`${env.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [opts.redirect ?? REDIRECT], token_endpoint_auth_method: 'none', client_name: 'Claude' }) });
  const client = (await reg.json()) as any;
  const p = pkce();
  const authz = await fetch(`${env.base}/authorize?` + new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: opts.redirect ?? REDIRECT, code_challenge: opts.challenge ?? p.challenge, code_challenge_method: 'S256', state: 'claude-state' }), { redirect: 'manual' });
  const exactUrl = new URL(authz.headers.get('location')!);
  const cb = await fetch(`${env.base}/exact/callback?code=exact-code&state=${encodeURIComponent(exactUrl.searchParams.get('state')!)}`, { redirect: 'manual' });
  const loc = cb.headers.get('location');
  const back = new URL(loc ?? 'http://none.invalid/');
  return { client, verifier: p.verifier, authz, exactUrl, cb, back, code: back.searchParams.get('code') };
}

export const tokenReq = (env: TestEnv, body: Record<string, string>) =>
  fetch(`${env.base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

export async function getTokens(env: TestEnv) {
  const f = await loginFlow(env);
  const res = await tokenReq(env, { grant_type: 'authorization_code', code: f.code!, redirect_uri: REDIRECT, client_id: f.client.client_id, code_verifier: f.verifier });
  return { ...f, tokens: (await res.json()) as any };
}

let rpcId = 0;
export async function mcpCall(env: TestEnv, accessToken: string, method: string, params?: unknown) {
  const res = await fetch(`${env.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

export const callTool = (env: TestEnv, token: string, name: string, args: unknown = {}) => mcpCall(env, token, 'tools/call', { name, arguments: args });

export const parseResult = (body: any) => {
  const text: string = body.result.content[0].text;
  const i = text.indexOf('\n\n');
  return { isError: !!body.result.isError, summary: i < 0 ? text : text.slice(0, i), data: i < 0 ? undefined : JSON.parse(text.slice(i + 2)) };
};
export const odata = (results: unknown[], next?: string) => json({ d: { results, ...(next ? { __next: next } : {}) } });
