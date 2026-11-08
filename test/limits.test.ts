import { afterEach, describe, expect, it } from 'vitest';
import { CircuitBreaker, RateLimiter, TokenBucket, endpointOf } from '../src/exact/limits.js';
import { callTool, getTokens, json, odata, parseResult, startApp, type TestEnv } from './helpers.js';

const ACC = '11111111-1111-1111-1111-111111111111';

describe('TokenBucket', () => {
  it('drains, then refills linearly over the period', () => {
    const b = new TokenBucket(50, 60_000, 0);
    for (let i = 0; i < 50; i++) { expect(b.waitMs(0)).toBe(0); b.take(0); }
    expect(b.waitMs(0)).toBe(1200);
    expect(b.waitMs(1200)).toBe(0);
  });
  it('adopts a lower remaining count reported by Exact', () => {
    const b = new TokenBucket(50, 60_000, 0);
    b.observe(0, 0);
    expect(b.waitMs(0)).toBeGreaterThan(0);
  });
});

describe('RateLimiter', () => {
  it('allows 50 calls per minute per division and keeps divisions apart', () => {
    const l = new RateLimiter({ perMinute: 50, perDay: 4500 });
    for (let i = 0; i < 50; i++) expect(l.acquire('100', 0).ok).toBe(true);
    const r = l.acquire('100', 0);
    expect(r).toMatchObject({ ok: false, scope: 'minute' });
    expect(l.acquire('200', 0).ok).toBe(true);
  });
  it('stops at the daily budget', () => {
    const l = new RateLimiter({ perMinute: 100_000, perDay: 4500 });
    let n = 0;
    while (l.acquire('100', 0).ok) n++;
    expect(n).toBe(4500);
    expect(l.acquire('100', 0)).toMatchObject({ ok: false, scope: 'day' });
  });
});

describe('CircuitBreaker', () => {
  const s = { breakerErrors: 8, breakerWindowMs: 3_600_000 };
  it('opens at the 8th client error in an hour and closes when the oldest ages out', () => {
    const b = new CircuitBreaker(s);
    for (let i = 0; i < 7; i++) b.record('crm/Accounts', 404, i * 1000);
    expect(b.openUntil('crm/Accounts', 7000)).toBeNull();
    b.record('crm/Accounts', 401, 7000);
    expect(b.openUntil('crm/Accounts', 7000)).toBe(3_600_000);
    expect(b.openUntil('crm/Accounts', 3_600_001)).toBeNull();
  });
  it('ignores server errors and successes, and counts per endpoint', () => {
    const b = new CircuitBreaker(s);
    for (let i = 0; i < 20; i++) { b.record('crm/Accounts', 500, 0); b.record('crm/Accounts', 200, 0); }
    for (let i = 0; i < 8; i++) b.record('crm/Contacts', 400, 0);
    expect(b.openUntil('crm/Accounts', 0)).toBeNull();
    expect(b.openUntil('crm/Contacts', 0)).not.toBeNull();
  });
});

describe('endpointOf', () => {
  it('strips division, key and query', () => {
    expect(endpointOf("https://start.exactonline.nl/api/v1/123/crm/Accounts(guid'x')?$select=ID")).toEqual({ division: '123', endpoint: 'crm/Accounts' });
    expect(endpointOf('https://start.exactonline.nl/api/v1/current/Me')).toEqual({ division: 'current', endpoint: 'current/Me' });
    expect(endpointOf('https://start.exactonline.nl/docs/XMLUpload.aspx?Topic=MatchSets&_Division_=123')).toEqual({ division: '123', endpoint: 'docs/XMLUpload.aspx?Topic=MatchSets' });
  });
});

describe('Exact client guards', () => {
  let env: TestEnv;
  afterEach(() => env?.close());

  it('stops calling an endpoint after 8 client errors in an hour', async () => {
    env = await startApp();
    env.fake.withLogin();
    const token = (await getTokens(env)).tokens.access_token as string;
    env.fake.on((url) => (url.pathname.includes('/crm/Accounts(') ? json({ error: { message: { value: 'not found' } } }, 404) : undefined));
    for (let i = 0; i < 8; i++) await callTool(env, token, 'get_account', { account_id: ACC });
    const before = env.fake.calls.length;
    const r = parseResult((await callTool(env, token, 'get_account', { account_id: ACC })).body);
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('paused');
    expect(env.fake.calls.length).toBe(before);
  });

  it('refuses when the per-minute budget is used up and the wait is too long', async () => {
    env = await startApp({ EXACT_RATE_PER_MINUTE: '2' });
    env.fake.withLogin();
    const token = (await getTokens(env)).tokens.access_token as string;
    env.fake.on((url) => (url.pathname.endsWith('/crm/Accounts') ? odata([]) : undefined));
    // login used the division-less budget; two calls fit in division 100
    expect(parseResult((await callTool(env, token, 'search_accounts', { query: 'a' })).body).isError).toBe(false);
    expect(parseResult((await callTool(env, token, 'search_accounts', { query: 'a' })).body).isError).toBe(false);
    const r = parseResult((await callTool(env, token, 'search_accounts', { query: 'a' })).body);
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('per-minute');
  });
});
