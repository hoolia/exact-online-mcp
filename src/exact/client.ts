import type { Logger } from '../logger.js';
import type { UserRecord } from '../store.js';
import { apiBase } from './regions.js';
import { ExactError } from './errors.js';
import { convertDates } from './dates.js';
import type { FetchFn, TokenManager } from './tokens.js';

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
}

export class ExactService {
  private divCache = new Map<number, { at: number; list: any[] }>();
  constructor(
    private tokens: TokenManager, private log: Logger,
    private fetchImpl: FetchFn = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private now: () => number = Date.now,
  ) {}

  forUser(user: UserRecord): ExactApi { return new ExactClient(this, user); }

  /** @internal */
  _divisions(userId: number) { const c = this.divCache.get(userId); return c && this.now() - c.at < DIVISION_CACHE_MS ? c.list : null; }
  _setDivisions(userId: number, list: any[]) { this.divCache.set(userId, { at: this.now(), list }); }
  get _tokens() { return this.tokens; }
  get _log() { return this.log; }
  get _fetch() { return this.fetchImpl; }
  get _sleep() { return this.sleep; }
}

class ExactClient implements ExactApi {
  constructor(private svc: ExactService, readonly user: UserRecord) {}

  private async request(url: string, init: { method?: string; body?: unknown } = {}, attempt = 0, rejected?: string): Promise<any> {
    const token = await this.svc._tokens.getAccessToken(this.user.id, rejected);
    let res: Response;
    try {
      res = await this.svc._fetch(url, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`, accept: 'application/json',
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (err) {
      this.svc._log.warn({ err: String(err) }, 'exact request network error');
      throw new ExactError('api', 'Could not reach Exact Online. Please try again shortly.');
    }

    this.svc._log.debug({
      dailyRemaining: res.headers.get('x-ratelimit-remaining'), minutelyRemaining: res.headers.get('x-ratelimit-minutely-remaining'),
    }, 'exact rate limit');

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
}
