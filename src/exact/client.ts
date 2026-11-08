import type { Logger } from '../logger.js';
import type { UserRecord } from '../store.js';
import { apiBase, exactHost } from './regions.js';
import { ExactError } from './errors.js';
import { convertDates } from './dates.js';
import type { FetchFn, TokenManager } from './tokens.js';
import { CircuitBreaker, DEFAULT_LIMITS, RateLimiter, endpointOf, type LimitSettings } from './limits.js';

export interface QueryOptions {
  select: string[];
  filter?: string;
  orderby?: string;
  top?: number;
  /** extra raw query params (e.g. function parameters) */
  params?: Record<string, string | number>;
}
export interface ListOptions { division?: number; maxRows?: number; maxPages?: number }
export interface ListResult<T = any> { rows: T[]; truncated: boolean }

const MAX_RETRY_WAIT_MS = 10_000;
const DIVISION_CACHE_MS = 60 * 60 * 1000;

export interface ExactApi {
  readonly user: UserRecord;
  resolveDivision(division?: number): Promise<number>;
  listDivisions(): Promise<{ Code: number; Description: string; Status: number }[]>;
  me(): Promise<any>;
  list<T = any>(resource: string, q: QueryOptions, o?: ListOptions): Promise<ListResult<T>>;
  getOne<T = any>(resource: string, q: Pick<QueryOptions, 'select'>, o?: { division?: number }): Promise<T | null>;
  post<T = any>(resource: string, body: unknown, o?: { division?: number }): Promise<T>;
  put(resource: string, body: unknown, o?: { division?: number }): Promise<void>;
  /** POST an XML document to XMLUpload.aspx for a topic; returns the response XML */
  postXml(topic: string, xml: string, o?: { division?: number }): Promise<string>;
  /** HTTP status of the last Exact response this client received; null before any call */
  readonly lastStatus: number | null;
}

export class ExactService {
  private divCache = new Map<number, { at: number; list: any[] }>();
  readonly limiter: RateLimiter;
  readonly breaker: CircuitBreaker;
  constructor(
    private tokens: TokenManager, private log: Logger,
    private fetchImpl: FetchFn = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private now: () => number = Date.now,
    limits: LimitSettings = DEFAULT_LIMITS,
  ) {
    this.limiter = new RateLimiter(limits);
    this.breaker = new CircuitBreaker(limits);
  }

  forUser(user: UserRecord): ExactApi { return new ExactClient(this, user); }

  /** @internal */
  _divisions(userId: number) { const c = this.divCache.get(userId); return c && this.now() - c.at < DIVISION_CACHE_MS ? c.list : null; }
  _setDivisions(userId: number, list: any[]) { this.divCache.set(userId, { at: this.now(), list }); }
  get _tokens() { return this.tokens; }
  get _log() { return this.log; }
  get _fetch() { return this.fetchImpl; }
  get _sleep() { return this.sleep; }
  get _now() { return this.now; }
}

class ExactClient implements ExactApi {
  lastStatus: number | null = null;
  constructor(private svc: ExactService, readonly user: UserRecord) {}

  /** Waits for the per-division token bucket and refuses calls to an endpoint whose breaker is open. */
  private async guard(url: string) {
    const { division, endpoint } = endpointOf(url);
    const until = this.svc.breaker.openUntil(endpoint, this.svc._now());
    if (until !== null) {
      const min = Math.max(1, Math.ceil((until - this.svc._now()) / 60_000));
      this.svc._log.warn({ endpoint }, 'exact circuit breaker open');
      throw new ExactError('rate_limit', `Calls to ${endpoint} are paused for ${min} minute(s) after repeated errors from Exact Online, to keep the app key from being blocked.`, 503);
    }
    for (;;) {
      const r = this.svc.limiter.acquire(division, this.svc._now());
      if (r.ok) return { division, endpoint };
      if (r.scope === 'day' || r.waitMs > MAX_RETRY_WAIT_MS) {
        throw new ExactError('rate_limit', `The ${r.scope === 'day' ? 'daily' : 'per-minute'} Exact Online call budget for division ${division} is used up, try again in ${Math.max(1, Math.ceil(r.waitMs / 1000))} seconds.`, 429);
      }
      await this.svc._sleep(r.waitMs);
    }
  }

  private async request(url: string, init: { method?: string; body?: unknown; xml?: string } = {}, attempt = 0, rejected?: string): Promise<any> {
    const { division, endpoint } = await this.guard(url);
    const token = await this.svc._tokens.getAccessToken(this.user.id, rejected);
    let res: Response;
    try {
      res = await this.svc._fetch(url, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`, accept: init.xml !== undefined ? 'application/xml' : 'application/json',
          ...(init.xml !== undefined ? { 'content-type': 'application/xml' } : init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: init.xml !== undefined ? init.xml : init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (err) {
      this.svc._log.warn({ err: String(err) }, 'exact request network error');
      throw new ExactError('api', 'Could not reach Exact Online. Please try again shortly.');
    }
    this.lastStatus = res.status;
    this.svc.breaker.record(endpoint, res.status, this.svc._now());

    const minutely = res.headers.get('x-ratelimit-minutely-remaining');
    const daily = res.headers.get('x-ratelimit-remaining');
    this.svc.limiter.observe(division, this.svc._now(), {
      minute: minutely === null ? undefined : Number(minutely), day: daily === null ? undefined : Number(daily),
    });
    this.svc._log.debug({ dailyRemaining: daily, minutelyRemaining: minutely }, 'exact rate limit');

    if (res.status === 401 && attempt === 0 && rejected === undefined) return this.request(url, init, 1, token);
    if (res.status === 401) throw new ExactError('api', 'Exact Online rejected the request as unauthorized.', 401);
    if (res.status === 429) {
      const wait = this.retryAfterMs(res);
      if (attempt < 2 && wait <= MAX_RETRY_WAIT_MS) {
        await this.svc._sleep(wait);
        return this.request(url, init, attempt + 1, rejected);
      }
      throw new ExactError('rate_limit', `Exact Online rate limit reached, try again in ${Math.max(1, Math.ceil(wait / 1000))} seconds.`, 429);
    }
    if (!res.ok) throw await this.apiError(res);
    if (res.status === 204) return null;
    if (init.xml !== undefined) return res.text();
    return res.json();
  }

  private retryAfterMs(res: Response): number {
    const now = this.svc['now']();
    const reset = Number(res.headers.get('x-ratelimit-minutely-reset')) || Number(res.headers.get('x-ratelimit-reset')) || 0;
    // If the daily quota is exhausted the daily reset applies instead.
    const daily = Number(res.headers.get('x-ratelimit-remaining'));
    const dailyReset = Number(res.headers.get('x-ratelimit-reset')) || 0;
    const target = daily === 0 && dailyReset ? dailyReset : reset;
    return target > now ? target - now : 5_000;
  }

  private async apiError(res: Response): Promise<ExactError> {
    let detail = '';
    try {
      const j: any = await res.json();
      detail = j?.error?.message?.value ?? j?.error?.message ?? '';
    } catch { /* ignore */ }
    const msg =
      res.status === 403 ? 'Exact Online denied access to this data (check the user\'s rights and the administration\'s package).'
      : res.status === 404 ? 'Exact Online could not find that resource.'
      : res.status >= 500 ? 'Exact Online had an internal error. Please try again shortly.'
      : `Exact Online rejected the request${detail ? `: ${String(detail).slice(0, 300)}` : ''}.`;
    return new ExactError('api', msg, res.status);
  }

  async me() {
    const j = await this.request(`${apiBase(this.user.region)}/current/Me?$select=UserID,FullName,Email,CurrentDivision,Language`);
    const row = j?.d?.results?.[0] ?? j?.d;
    return convertDates(row);
  }

  async listDivisions() {
    const cached = this.svc._divisions(this.user.id);
    if (cached) return cached;
    const { rows } = await this.listRaw(`${apiBase(this.user.region)}/${this.user.currentDivision}/system/Divisions`, { select: ['Code', 'Description', 'Status', 'Country', 'Currency'] }, { maxRows: 1000, maxPages: 10 });
    this.svc._setDivisions(this.user.id, rows);
    return rows;
  }

  async resolveDivision(division?: number): Promise<number> {
    if (division === undefined) return this.user.currentDivision;
    if (division === this.user.currentDivision) return division;
    const list = await this.listDivisions();
    if (!list.some((d: any) => Number(d.Code) === division)) {
      throw new ExactError('invalid_input', `Division ${division} is not accessible for this user. Use list_divisions to see the available divisions.`);
    }
    return division;
  }

  private buildUrl(base: string, q: QueryOptions, maxRows: number): string {
    const p: string[] = [`$select=${encodeURIComponent(q.select.join(','))}`];
    if (q.filter) p.push(`$filter=${encodeURIComponent(q.filter)}`);
    if (q.orderby) p.push(`$orderby=${encodeURIComponent(q.orderby)}`);
    const top = q.top ?? maxRows;
    if (top <= 60) p.push(`$top=${top}`);
    for (const [k, v] of Object.entries(q.params ?? {})) p.push(`${k}=${encodeURIComponent(String(v))}`);
    return `${base}?${p.join('&')}`;
  }

  private async listRaw(base: string, q: QueryOptions, o: ListOptions): Promise<ListResult> {
    const maxRows = o.maxRows ?? 500;
    const maxPages = o.maxPages ?? 10;
    let url: string | undefined = this.buildUrl(base, q, maxRows);
    const rows: any[] = [];
    let pages = 0;
    let truncated = false;
    while (url) {
      const j = await this.request(url);
      pages++;
      const results = j?.d?.results ?? (j?.d ? [j.d] : []);
      rows.push(...convertDates(results));
      const next: string | undefined = j?.d?.__next;
      if (rows.length >= maxRows) { truncated = !!next || rows.length > maxRows; break; }
      if (next && pages >= maxPages) { truncated = true; break; }
      url = next;
    }
    return { rows: rows.slice(0, maxRows), truncated };
  }

  async list<T = any>(resource: string, q: QueryOptions, o: ListOptions = {}): Promise<ListResult<T>> {
    const division = await this.resolveDivision(o.division);
    return this.listRaw(`${apiBase(this.user.region)}/${division}/${resource}`, q, o);
  }

  async getOne<T = any>(resource: string, q: Pick<QueryOptions, 'select'>, o: { division?: number } = {}): Promise<T | null> {
    const division = await this.resolveDivision(o.division);
    try {
      const j = await this.request(`${apiBase(this.user.region)}/${division}/${resource}?$select=${encodeURIComponent(q.select.join(','))}`);
      const row = j?.d?.results?.[0] ?? j?.d;
      return row ? (convertDates(row) as T) : null;
    } catch (e) {
      if (e instanceof ExactError && e.status === 404) return null;
      throw e;
    }
  }

  async post<T = any>(resource: string, body: unknown, o: { division?: number } = {}): Promise<T> {
    const division = await this.resolveDivision(o.division);
    const j = await this.request(`${apiBase(this.user.region)}/${division}/${resource}`, { method: 'POST', body });
    return convertDates(j?.d) as T;
  }

  async postXml(topic: string, xml: string, o: { division?: number } = {}): Promise<string> {
    const division = await this.resolveDivision(o.division);
    const url = `${exactHost(this.user.region)}/docs/XMLUpload.aspx?Topic=${encodeURIComponent(topic)}&_Division_=${division}`;
    return String(await this.request(url, { method: 'POST', xml }) ?? '');
  }

  async put(resource: string, body: unknown, o: { division?: number } = {}): Promise<void> {
    const division = await this.resolveDivision(o.division);
    await this.request(`${apiBase(this.user.region)}/${division}/${resource}`, { method: 'PUT', body });
  }
}
