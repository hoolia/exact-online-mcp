/** Client-side guards that keep the app key below the Exact Online limits. */

export interface LimitSettings {
  /** calls per minute per division (Exact allows 60) */
  perMinute: number;
  /** calls per day per division (Exact allows 5,000) */
  perDay: number;
  /** client errors (400/401/403/404) per endpoint in breakerWindowMs that open the breaker (Exact blocks at 10 per hour) */
  breakerErrors: number;
  breakerWindowMs: number;
}

export const DEFAULT_LIMITS: LimitSettings = { perMinute: 50, perDay: 4500, breakerErrors: 8, breakerWindowMs: 60 * 60 * 1000 };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(readonly capacity: number, private periodMs: number, now: number) {
    this.tokens = capacity;
    this.last = now;
  }

  private refill(now: number) {
    if (now > this.last) {
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) * this.capacity) / this.periodMs);
      this.last = now;
    }
  }

  /** ms until one token is available; 0 when one is available now */
  waitMs(now: number): number {
    this.refill(now);
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) * this.periodMs) / this.capacity);
  }

  take(now: number) {
    this.refill(now);
    this.tokens -= 1;
  }

  /** lower the local count to what Exact reports as remaining */
  observe(remaining: number, now: number) {
    this.refill(now);
    if (Number.isFinite(remaining) && remaining >= 0 && remaining < this.tokens) this.tokens = remaining;
  }

  get available() { return this.tokens; }
}

export type Acquire = { ok: true } | { ok: false; scope: 'minute' | 'day'; waitMs: number };

/** Two token buckets per division: per minute and per day. */
export class RateLimiter {
  private buckets = new Map<string, { minute: TokenBucket; day: TokenBucket }>();

  constructor(private s: Pick<LimitSettings, 'perMinute' | 'perDay'>) {}

  private get(division: string, now: number) {
    let b = this.buckets.get(division);
    if (!b) {
      b = { minute: new TokenBucket(this.s.perMinute, MINUTE, now), day: new TokenBucket(this.s.perDay, DAY, now) };
      this.buckets.set(division, b);
    }
    return b;
  }

  acquire(division: string, now: number): Acquire {
    const b = this.get(division, now);
    const day = b.day.waitMs(now);
    if (day > 0) return { ok: false, scope: 'day', waitMs: day };
    const minute = b.minute.waitMs(now);
    if (minute > 0) return { ok: false, scope: 'minute', waitMs: minute };
    b.minute.take(now);
    b.day.take(now);
    return { ok: true };
  }

  observe(division: string, now: number, remaining: { minute?: number; day?: number }) {
    const b = this.get(division, now);
    if (remaining.minute !== undefined) b.minute.observe(remaining.minute, now);
    if (remaining.day !== undefined) b.day.observe(remaining.day, now);
  }
}

export const CLIENT_ERROR_STATUSES = new Set([400, 401, 403, 404]);

/** Opens per endpoint after breakerErrors client errors inside the rolling window. */
export class CircuitBreaker {
  private errors = new Map<string, number[]>();

  constructor(private s: Pick<LimitSettings, 'breakerErrors' | 'breakerWindowMs'>) {}

  private recent(endpoint: string, now: number) {
    const list = (this.errors.get(endpoint) ?? []).filter((t) => now - t < this.s.breakerWindowMs);
    this.errors.set(endpoint, list);
    return list;
  }

  record(endpoint: string, status: number, now: number) {
    if (!CLIENT_ERROR_STATUSES.has(status)) return;
    this.recent(endpoint, now).push(now);
  }

  /** epoch ms at which the endpoint accepts calls again; null when closed */
  openUntil(endpoint: string, now: number): number | null {
    const list = this.recent(endpoint, now);
    if (list.length < this.s.breakerErrors) return null;
    return list[list.length - this.s.breakerErrors]! + this.s.breakerWindowMs;
  }

  count(endpoint: string, now: number) { return this.recent(endpoint, now).length; }
}

/** "purchaseentry/PurchaseEntries" for any URL of that resource, without division, key or query. */
export function endpointOf(url: string): { division: string; endpoint: string } {
  const u = new URL(url);
  if (u.pathname.startsWith('/docs/')) {
    return { division: u.searchParams.get('_Division_') ?? 'current', endpoint: `${u.pathname.slice(1)}?Topic=${u.searchParams.get('Topic') ?? ''}` };
  }
  const path = u.pathname.replace(/^\/api\/v1\//, '');
  const m = /^(\d+)\/(.*)$/.exec(path);
  const division = m ? m[1]! : 'current';
  const rest = (m ? m[2]! : path).replace(/\(.*?\)/g, '');
  return { division, endpoint: rest };
}
