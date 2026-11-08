import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { Store } from './store.js';
import { createMcpServer, setErrorLogger, type CallHook } from './mcp.js';
import { createHash } from 'node:crypto';
import type { PgStore } from './db/ledger.js';
import { mountOAuth } from './oauth/routes.js';
import { ExactService } from './exact/client.js';
import { TokenManager, type FetchFn } from './exact/tokens.js';
import { ExactError, RECONNECT_MESSAGE } from './exact/errors.js';
import { buildTools } from './tools/index.js';
import type { ToolContext } from './tools/types.js';
import { JwtVerifier, looksLikeJwt, type CallerIdentity } from './auth/jwt.js';
import type { JWTVerifyGetKey } from 'jose';

export interface AppDeps { cfg: Config; store: Store; log: Logger; fetchImpl?: FetchFn; sleep?: (ms: number) => Promise<void>; now?: () => number; jwksGetKey?: JWTVerifyGetKey; ledger?: PgStore | null }

export function createApp({ cfg, store, log, fetchImpl = fetch, sleep, now = Date.now, jwksGetKey, ledger = null }: AppDeps) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const tokens = new TokenManager(cfg, store, log, fetchImpl);
  const exact = new ExactService(tokens, log, fetchImpl, sleep, now, cfg.limits);
  const tools = buildTools(cfg, { hasLedger: !!ledger, warn: (msg) => log.warn(msg) });
  const jwt = cfg.jwt ? new JwtVerifier(cfg.jwt, jwksGetKey) : null;
  setErrorLogger((err) => log.error({ err: String(err) }, 'tool failed'));

  app.get('/healthz', (_req, res) => { res.json({ ok: true }); });

  mountOAuth(app, { cfg, store, log, fetchImpl });

  const unauthorized = (res: Response) =>
    res.status(401)
      .set('WWW-Authenticate', `Bearer resource_metadata="${cfg.publicBaseUrl}/.well-known/oauth-protected-resource"`)
      .json({ error: 'unauthorized' });

  async function requireBearer(req: Request, res: Response, next: NextFunction) {
    const m = req.headers.authorization?.match(/^Bearer (.+)$/i);
    if (!m) return unauthorized(res);
    const bearer = m[1]!;
    if (jwt && cfg.jwt && looksLikeJwt(bearer)) {
      const caller = await jwt.verify(bearer);
      if (!caller) {
        log.warn({ path: req.path }, 'workload token rejected');
        return unauthorized(res);
      }
      const user = store.getUserByExactId(cfg.jwt.exactUserId);
      (req as any).auth = { token: 'redacted', clientId: caller.clientId ?? 'workload', scopes: [], extra: { userId: user?.id ?? 0, caller, modelVersion: modelVersion(req) } };
      return next();
    }
    const row = store.resolveAccess(bearer);
    if (!row) return unauthorized(res);
    (req as any).auth = {
      token: 'redacted', clientId: row.clientId, scopes: [], expiresAt: Math.floor(row.accessExpiresAt / 1000),
      extra: { userId: row.userId, modelVersion: modelVersion(req) },
    };
    next();
  }

  const modelVersion = (req: Request) => req.get(cfg.auditModelHeader)?.slice(0, 120) ?? null;
  // per call: division and Exact id the tool reported through ctx.audit
  const callState = new WeakMap<ToolContext, { division: number | null; exactId: string | null }>();

  async function contextFor(authInfo: any): Promise<ToolContext> {
    const user = store.getUser(Number(authInfo?.extra?.userId));
    const workload: CallerIdentity | undefined = authInfo?.extra?.caller;
    if (workload && !user) throw new ExactError('not_connected', 'The Exact Online user that workload calls act as has not connected this server yet; a person with that Exact login must connect it once.');
    if (!user || user.disconnected) throw new ExactError('not_connected', RECONNECT_MESSAGE);
    const caller: CallerIdentity = workload ?? { kind: 'human', id: `exact:${user.exactUserId.toLowerCase()}`, name: user.name, clientId: authInfo?.clientId ?? null };
    const state = { division: null as number | null, exactId: null as string | null };
    const ctx: ToolContext = {
      exact: exact.forUser(user), user, config: cfg, caller, ledger, now,
      audit: (e) => {
        state.division = e.division;
        state.exactId = e.exactId ?? state.exactId;
        store.audit({ userId: user.id, division: e.division, tool: e.tool, payloadHash: e.payloadHash, exactId: e.exactId });
      },
    };
    callState.set(ctx, state);
    return ctx;
  }

  /** One audit row per tool call in Postgres: who, which tool, SHA-256 of the arguments, what Exact answered. */
  const auditCall: CallHook | undefined = ledger ? async ({ authInfo, tool, args, ctx, outcome }) => {
    const a: any = authInfo;
    const state = ctx ? callState.get(ctx) : undefined;
    const caller: CallerIdentity | undefined = ctx?.caller ?? a?.extra?.caller;
    const argDivision = typeof (args as any)?.division === 'number' ? (args as any).division : null;
    await ledger.audit({
      ts: new Date(now()), callerKind: caller?.kind ?? 'human', callerId: caller?.id ?? `user:${a?.extra?.userId ?? 'unknown'}`, callerName: caller?.name ?? null,
      clientId: caller?.clientId ?? a?.clientId ?? null, exactUserId: ctx?.user.exactUserId ?? null,
      division: state?.division ?? argDivision ?? ctx?.user.currentDivision ?? null, tool,
      argsSha256: createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex'), outcome,
      exactStatus: ctx?.exact.lastStatus ?? null, exactId: state?.exactId ?? null, modelVersion: a?.extra?.modelVersion ?? null,
    });
  } : undefined;

  app.post('/mcp', requireBearer, express.json({ limit: Math.ceil(cfg.maxAttachmentBytes * 1.4) + 1024 * 1024 }), async (req, res) => {
    const server = createMcpServer(tools, contextFor, auditCall);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req as any, res, req.body);
    } catch (err) {
      log.error({ err: String(err) }, 'mcp request failed');
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });

  const notAllowed = (_req: Request, res: Response) =>
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null });
  app.get('/mcp', requireBearer, notAllowed);
  app.delete('/mcp', requireBearer, notAllowed);

  return app;
}

