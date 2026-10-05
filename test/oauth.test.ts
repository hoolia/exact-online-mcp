import { afterEach, describe, expect, it } from 'vitest';
import { REDIRECT, getTokens, loginFlow, mcpCall, startApp, tokenReq, type TestEnv, pkce } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.close());

describe('discovery + 401', () => {
  it('serves metadata and a 401 challenge', async () => {
    env = await startApp();
    const as = await (await fetch(`${env.base}/.well-known/oauth-authorization-server`)).json() as any;
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.token_endpoint_auth_methods_supported).toEqual(['none', 'client_secret_post']);
    expect(as.registration_endpoint).toBe('https://mcp.test/register');
    const pr = await (await fetch(`${env.base}/.well-known/oauth-protected-resource`)).json() as any;
    expect(pr.authorization_servers).toEqual(['https://mcp.test']);
    const r = await fetch(`${env.base}/mcp`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe('Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource"');
    expect((await fetch(`${env.base}/healthz`)).status).toBe(200);
  });
});

describe('registration + authorize', () => {
  it('rejects disallowed redirect URIs', async () => {
    env = await startApp();
    const r = await fetch(`${env.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) });
    expect(r.status).toBe(400);
    const ok = await fetch(`${env.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://localhost:6274/oauth/callback'] }) });
    expect(ok.status).toBe(201);
  });
  it('requires PKCE S256 and a registered redirect', async () => {
    env = await startApp();
    const client = await (await fetch(`${env.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).json() as any;
    const noPkce = await fetch(`${env.base}/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s`, { redirect: 'manual' });
    expect(noPkce.status).toBe(302);
    expect(new URL(noPkce.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
    const wrongUri = await fetch(`${env.base}/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('http://localhost:1/x')}&code_challenge=x&code_challenge_method=S256`, { redirect: 'manual' });
    expect(wrongUri.status).toBe(400);
  });
  it('shows a region page when several regions are enabled', async () => {
    env = await startApp({ EXACT_ENABLED_REGIONS: 'nl,be' });
    const f = await loginFlowUntilAuthorize();
    expect(f.status).toBe(200);
    expect(await f.text()).toContain('Belgium');
  });
  async function loginFlowUntilAuthorize() {
    const client = await (await fetch(`${env.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).json() as any;
    return fetch(`${env.base}/authorize?` + new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' }), { redirect: 'manual' });
  }
});

describe('Exact broker + token endpoint', () => {
  it('completes the full flow and calls whoami', async () => {
    env = await startApp(); env.fake.withLogin();
    const { exactUrl, back, tokens } = await getTokens(env);
    expect(exactUrl.origin + exactUrl.pathname).toBe('https://start.exactonline.nl/api/oauth2/auth');
    expect(exactUrl.searchParams.get('redirect_uri')).toBe('https://mcp.test/exact/callback');
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('claude-state');
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(3600);
    const { status, body } = await mcpCall(env, tokens.access_token, 'tools/call', { name: 'whoami', arguments: {} });
    expect(status).toBe(200);
    expect(body.result.content[0].text).toContain('Test User');
  });

  it('stores exact tokens encrypted and ours hashed', async () => {
    env = await startApp(); env.fake.withLogin();
    const { tokens } = await getTokens(env);
    const row = env.store.db.prepare('SELECT access_enc, refresh_enc FROM users').get() as any;
    expect(row.access_enc).not.toMatch(/^at-/);
    const t = env.store.db.prepare('SELECT access_hash FROM tokens').get() as any;
    expect(t.access_hash).not.toBe(tokens.access_token);
  });

  it('rejects wrong PKCE verifier and reused codes', async () => {
    env = await startApp(); env.fake.withLogin();
    const f = await loginFlow(env);
    const bad = await tokenReq(env, { grant_type: 'authorization_code', code: f.code!, redirect_uri: REDIRECT, client_id: f.client.client_id, code_verifier: 'wrong' });
    expect(((await bad.json()) as any).error).toBe('invalid_grant');
    // code is single use even after a failed attempt
    const again = await tokenReq(env, { grant_type: 'authorization_code', code: f.code!, redirect_uri: REDIRECT, client_id: f.client.client_id, code_verifier: f.verifier });
    expect(((await again.json()) as any).error).toBe('invalid_grant');
  });

  it('rejects an already-used code on replay', async () => {
    env = await startApp(); env.fake.withLogin();
    const f = await loginFlow(env);
    const args = { grant_type: 'authorization_code', code: f.code!, redirect_uri: REDIRECT, client_id: f.client.client_id, code_verifier: f.verifier };
    expect((await tokenReq(env, args)).status).toBe(200);
    expect((await tokenReq(env, args)).status).toBe(400);
  });

  it('rejects expired codes', async () => {
    let t = 1_000_000;
    env = await startApp({}, () => t); env.fake.withLogin();
    const f = await loginFlow(env);
    t += 6 * 60 * 1000;
    const res = await tokenReq(env, { grant_type: 'authorization_code', code: f.code!, redirect_uri: REDIRECT, client_id: f.client.client_id, code_verifier: f.verifier });
    expect(((await res.json()) as any).error).toBe('invalid_grant');
  });

  it('rotates refresh tokens and rejects replay with invalid_grant', async () => {
    env = await startApp(); env.fake.withLogin();
    const f = await getTokens(env);
    const r1 = await tokenReq(env, { grant_type: 'refresh_token', refresh_token: f.tokens.refresh_token, client_id: f.client.client_id });
    expect(r1.status).toBe(200);
    const n = (await r1.json()) as any;
    expect(n.refresh_token).not.toBe(f.tokens.refresh_token);
    const replay = await tokenReq(env, { grant_type: 'refresh_token', refresh_token: f.tokens.refresh_token, client_id: f.client.client_id });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as any).error).toBe('invalid_grant');
    expect((await mcpCall(env, n.access_token, 'tools/list')).status).toBe(200);
  });

  it('returns invalid_grant on refresh once Exact access is gone', async () => {
    env = await startApp(); env.fake.withLogin();
    const f = await getTokens(env);
    env.store.markDisconnected(1);
    const r = await tokenReq(env, { grant_type: 'refresh_token', refresh_token: f.tokens.refresh_token, client_id: f.client.client_id });
    expect(((await r.json()) as any).error).toBe('invalid_grant');
  });

  it('enforces the allowlist', async () => {
    env = await startApp({ ALLOWED_EXACT_USER_IDS: 'someone-else' }); env.fake.withLogin();
    const f = await loginFlow(env);
    expect(f.cb.status).toBe(403);
    expect(env.store.db.prepare('SELECT COUNT(*) c FROM users').get()).toEqual({ c: 0 });
  });

  it('rejects a tampered state', async () => {
    env = await startApp(); env.fake.withLogin();
    const r = await fetch(`${env.base}/exact/callback?code=x&state=forged.abc`, { redirect: 'manual' });
    expect(r.status).toBe(400);
  });
});
