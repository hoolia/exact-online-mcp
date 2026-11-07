import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { Store } from './store.js';
import { createMcpServer, setErrorLogger } from './mcp.js';
import { mountOAuth } from './oauth/routes.js';
import { ExactService } from './exact/client.js';
import { TokenManager, type FetchFn } from './exact/tokens.js';
import { ExactError, RECONNECT_MESSAGE } from './exact/errors.js';
import { buildTools } from './tools/index.js';
import type { ToolContext } from './tools/types.js';

export interface AppDeps { cfg: Config; store: Store; log: Logger; fetchImpl?: FetchFn; sleep?: (ms: number) => Promise<void> }

export function createApp({ cfg, store, log, fetchImpl = fetch, sleep }: AppDeps) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const tokens = new TokenManager(cfg, store, log, fetchImpl);
  const exact = new ExactService(tokens, log, fetchImpl, sleep);
  const tools = buildTools(cfg);
  setErrorLogger((err) => log.error({ err: String(err) }, 'tool failed'));

  app.get('/healthz', (_req, res) => { res.json({ ok: true }); });

  mountOAuth(app, { cfg, store, log, fetchImpl });

  const unauthorized = (res: Response) =>
    res.status(401)
      .set('WWW-Authenticate', `Bearer resource_metadata="${cfg.publicBaseUrl}/.well-known/oauth-protected-resource"`)
      .json({ error: 'unauthorized' });

  function requireBearer(req: Request, res: Response, next: NextFunction) {
    const m = req.headers.authorization?.match(/^Bearer (.+)$/i);
    const row = m ? store.resolveAccess(m[1]!) : null;
    if (!row) return unauthorized(res);
    (req as any).auth = {
      token: 'redacted', clientId: row.clientId, scopes: [], expiresAt: Math.floor(row.accessExpiresAt / 1000),
      extra: { userId: row.userId },
    };
    next();
  }

  async function contextFor(authInfo: any): Promise<ToolContext> {
    const user = store.getUser(Number(authInfo?.extra?.userId));
    if (!user || user.disconnected) throw new ExactError('not_connected', RECONNECT_MESSAGE);
    return {
      exact: exact.forUser(user), user, config: cfg,
      audit: (e) => store.audit({ userId: user.id, division: e.division, tool: e.tool, payloadHash: e.payloadHash, exactId: e.exactId }),
    };
  }

  app.post('/mcp', requireBearer, express.json({ limit: Math.ceil(cfg.maxAttachmentBytes * 1.4) + 1024 * 1024 }), async (req, res) => {
    const server = createMcpServer(tools, contextFor);
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

