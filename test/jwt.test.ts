import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { loadConfig } from '../src/config.js';
import { baseEnv, callTool, getTokens, parseResult, startApp, type TestEnv } from './helpers.js';

const ISS = 'https://sso.example.org/realms/test';
const AUD = 'exact-mcp';
const EXACT_USER = 'a1b2c3d4-0000-0000-0000-000000000001';
const JWT_ENV = { JWT_ISSUER: ISS, JWT_AUDIENCE: AUD, JWT_EXACT_USER_ID: EXACT_USER, JWT_ALLOWED_CLIENTS: 'agent,cron' };

let priv: CryptoKey;
let other: CryptoKey;
let getKey: JWTVerifyGetKey;
beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  priv = kp.privateKey;
  other = (await generateKeyPair('RS256')).privateKey;
  getKey = createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256' }] });
});

const mint = (claims: Record<string, unknown> = {}, o: { key?: CryptoKey; iss?: string; aud?: string; exp?: string } = {}) =>
  new SignJWT({ azp: 'agent', preferred_username: 'service-account-agent', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(o.iss ?? ISS).setAudience(o.aud ?? AUD).setSubject('sa-123')
    .setIssuedAt().setExpirationTime(o.exp ?? '5m').sign(o.key ?? priv);

let env: TestEnv;
afterEach(() => env?.close());

async function connected() {
  env = await startApp(JWT_ENV, undefined, { jwksGetKey: getKey });
  env.fake.withLogin({ userId: EXACT_USER });
  await getTokens(env);
}

const rawList = (token: string) => fetch(`${env.base}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});

describe('JWT config', () => {
  it('derives the Keycloak JWKS URL and requires audience and Exact user', () => {
    const c = loadConfig(baseEnv(JWT_ENV));
    expect(c.jwt).toMatchObject({ issuer: ISS, audience: AUD, jwksUrl: `${ISS}/protocol/openid-connect/certs`, allowedClients: ['agent', 'cron'] });
    expect(() => loadConfig(baseEnv({ JWT_ISSUER: ISS }))).toThrow(/JWT_AUDIENCE[\s\S]*JWT_EXACT_USER_ID/);
    expect(loadConfig(baseEnv()).jwt).toBeNull();
  });
});

describe('workload callers', () => {
  it('a valid access token calls tools through the configured Exact connection', async () => {
    await connected();
    const r = parseResult((await callTool(env, await mint(), 'whoami')).body);
    expect(r.isError).toBe(false);
  });
  it.each([
    ['wrong audience', () => mint({}, { aud: 'other' })],
    ['wrong issuer', () => mint({}, { iss: 'https://evil.example.org' })],
    ['foreign key', () => mint({}, { key: other })],
    ['expired', () => mint({}, { exp: '-5m' })],
    ['client not allowed', () => mint({ azp: 'intruder' })],
  ])('rejects a token with %s', async (_n, make) => {
    await connected();
    expect((await rawList(await make())).status).toBe(401);
  });
  it('rejects a JWT when no issuer is configured', async () => {
    env = await startApp();
    expect((await rawList(await mint())).status).toBe(401);
  });
  it('says the Exact user must connect first', async () => {
    env = await startApp(JWT_ENV, undefined, { jwksGetKey: getKey });
    const r = parseResult((await callTool(env, await mint(), 'whoami')).body);
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('must connect it once');
  });
  it('broker tokens keep working next to JWTs', async () => {
    env = await startApp(JWT_ENV, undefined, { jwksGetKey: getKey });
    env.fake.withLogin({ userId: EXACT_USER });
    const { tokens } = await getTokens(env);
    expect(parseResult((await callTool(env, tokens.access_token, 'whoami')).body).isError).toBe(false);
  });
});
