# Exact Online connector for Claude (self-hosted remote MCP server)

A remote [MCP](https://modelcontextprotocol.io) server that lets people in your organisation connect Claude
(claude.ai, Claude Desktop, mobile) to **their own** Exact Online administrations. Every user signs in with their own
Exact account, so Claude only sees what that user can already see. **Version 1 is read-only**; three write tools exist
behind `ENABLE_WRITE_TOOLS` (off by default).

## Architecture

Exact Online has no OAuth Dynamic Client Registration, which MCP clients expect. So this server is **its own OAuth 2.1
authorization server towards Claude** and brokers the Exact login behind it.

```
 Claude (Anthropic cloud)                 office server (Docker)                          Exact Online
 ───────────────────────                  ─────────────────────────────────               ────────────
                          HTTPS (Cloudflare Tunnel)
 POST /register  ─────────────────────▶  stores client + redirect URIs
 GET  /authorize ─────────────────────▶  pending auth (PKCE S256, state) ─ region page ─▶  /api/oauth2/auth
                                          GET /exact/callback  ◀───────────────────────  code
                                          exchange code, GET current/Me, store ENCRYPTED
                                          Exact tokens, issue our one-time code
 ◀──── redirect to claude.ai callback (code, state)
 POST /token (code+verifier) ─────────▶  our opaque access (1 h) + rotating refresh (60 d) tokens
                                          (only SHA-256 hashes stored)
 POST /mcp  Bearer <our token> ───────▶  token → user → Exact client ──(per-user refresh lock)──▶  /api/v1/{division}/...
                                          SQLite on a Docker volume
```

* **Transport:** MCP Streamable HTTP on `POST /mcp` (stateless, JSON responses). `GET`/`DELETE` return 405.
* **Exact tokens** are encrypted at rest (AES-256-GCM, key `TOKEN_ENCRYPTION_KEY`). Exact refresh tokens rotate: refreshes
  are serialized per user and the new refresh token is written to the DB **before** the new access token is used.
* If Exact rejects a refresh, the user is marked disconnected: tools answer *"Your Exact Online connection has expired.
  Please reconnect the connector in Claude's settings."* and `/token` returns `invalid_grant` so Claude prompts a reconnect.
* Source layout: `src/oauth/` (auth server + broker), `src/exact/` (regions, token manager, API client), `src/tools/` (MCP tools).

## 1. Exact Online App Center setup (manual)

1. Log in to the App Center for your region (e.g. <https://apps.exactonline.com>) → **Manage apps** → register a new app.
2. Set the redirect URI to exactly your `EXACT_REDIRECT_URI`, e.g. `https://mcp.example.nl/exact/callback` (HTTPS).
3. Copy the **Client ID** and **Client Secret** into `.env`.
4. Apps used only within your own Exact licence can usually stay private. Offering the connector to **other companies'**
   administrations may require Exact's partner/app review; check the current App Center terms before doing so.

The app registration is per Exact region/App Center. If you enable several regions (`EXACT_ENABLED_REGIONS`) the same
Client ID/Secret must be valid for each region's `start.exactonline.<tld>`; otherwise run one instance per region.

## 2. Configure

```bash
cp .env.example .env
openssl rand -base64 32   # → TOKEN_ENCRYPTION_KEY
openssl rand -base64 48   # → SESSION_SIGNING_KEY
```

Fill in `PUBLIC_BASE_URL`, the Exact client id/secret, `EXACT_REDIRECT_URI`, and `TUNNEL_TOKEN`. Config is validated at
startup; the server refuses to start with a clear message if anything is missing. Notable options:

| Variable | Meaning |
|---|---|
| `EXACT_DEFAULT_REGION` / `EXACT_ENABLED_REGIONS` | Regions (`nl be de uk fr es us`). With one enabled region users skip the region page. |
| `ALLOWED_EXACT_USER_IDS` | Optional comma-separated Exact `UserID` GUIDs; empty = anyone who can log in to Exact. Rejected attempts are logged with the user id. |
| `EXTRA_REDIRECT_URIS` | Extra allowed OAuth redirect URIs. Built in: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, `http://localhost:*`, `http://127.0.0.1:*`. |
| `ENABLE_WRITE_TOOLS` | `true` registers every write tool (see TOOLS.md). |
| `WRITE_TOOLS` | Comma-separated write tool names to register instead of all of them, e.g. `draft_purchase_entry,attach_document`; an unknown name stops the server at startup. |
| `MAX_ATTACHMENT_MB` | Largest file `attach_document` accepts (default 20). |

## 3. Deploy (Cloudflare Tunnel)

No inbound firewall ports are opened; TLS terminates at Cloudflare. The app container publishes no ports.

1. In Cloudflare Zero Trust → **Networks → Tunnels**, create a tunnel and copy its token into `TUNNEL_TOKEN`.
2. Add a **public hostname** `mcp.example.nl` → service `http://app:8080`.
   Only these paths need to be public: `/mcp`, `/.well-known/*`, `/register`, `/authorize`, `/token`, `/exact/start`,
   `/exact/callback`, `/healthz` (the app serves nothing else). To enforce that at the edge, add a Cloudflare WAF custom rule
   that blocks every other path.
3. `docker compose up -d --build`
4. Check: `curl https://mcp.example.nl/healthz` → `{"ok":true}`.

`docker-compose.yml` runs `app`, `cloudflared` and `backup` with `restart: unless-stopped`, a named volume for `/data`,
and a healthcheck on `/healthz`.

**Optional hardening (not enabled):** restrict inbound `/mcp` and `/token` to Anthropic's published outbound IP ranges
(Cloudflare WAF IP rule). `/authorize` and `/exact/callback` are hit by the user's browser and must stay open.

**Rate limiting:** `/authorize`, `/token`, `/register`, `/exact/*` are limited to 60 requests/minute per IP (the app trusts one proxy hop).

## 3b. Deploy on Kubernetes / OpenShift

The image `ghcr.io/hoolia/exact-online-mcp:<version>` (built from `Containerfile` by `.github/workflows/image.yaml`) runs as any
non-root UID in group 0 and writes only `DB_PATH` (default `/data/connector.db`): mount a ReadWriteOnce volume on `/data` and run
one replica with the `Recreate` strategy. Publish `/` of the Service on an HTTPS Route or Ingress on the host of `PUBLIC_BASE_URL`;
the server trusts one proxy hop for the client address. Give the secrets (`EXACT_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`,
`SESSION_SIGNING_KEY`) from a Secret. A login logs the Exact `UserID` (`exact login`), which `ALLOWED_EXACT_USER_IDS` takes.

## 4. Connecting in Claude

**Individual user** (Pro/Max): *Settings → Connectors → Add custom connector* → URL `https://mcp.example.nl/mcp` → complete the
Exact Online login. Then ask e.g. *"Which customers have overdue invoices over 30 days?"*

**Team / Enterprise:** an Owner/admin adds the connector once under *Organization settings → Connectors → Add custom
connector* (same URL). Members then see it in their connector list and each clicks **Connect** to sign in with their own
Exact account. Reconnect from the same place if Exact access expires or is revoked.

## 5. Operations

* **Logs:** `docker compose logs -f app` (JSON, tokens/secrets redacted). `LOG_LEVEL=debug` also logs remaining Exact rate-limit quota.
* **Backup:** the `backup` service writes a consistent copy of the DB to `./backups/connector-YYYY-MM-DD.db` nightly (14 days kept).
  Copy `./backups` off the server. The DB holds *encrypted* Exact tokens: a restore is useless without `TOKEN_ENCRYPTION_KEY`,
  so **back up the key separately** (password manager), never in the same place as the DB.
* **Key rotation:** `TOKEN_ENCRYPTION_KEY` cannot be rotated in place. Stop the stack, set the new key, wipe sessions
  (`sqlite3 /data/connector.db "DELETE FROM users; DELETE FROM tokens; DELETE FROM auth_codes;"`), start; everyone reconnects once.
  Rotating `SESSION_SIGNING_KEY` only invalidates in-flight logins.
* **Revoking a user:** delete their row from `users` and `tokens`, or add an allowlist and reconnect. Revoking the app in Exact makes
  tools return the reconnect message at the next call.
* **Audit log:** write tool calls are recorded in the `audit_log` table (user, division, tool, SHA-256 of payload, Exact id, time).
* **Updates:** `git pull && docker compose up -d --build`.

## 6. Development

```bash
npm install
npm test        # vitest; Exact is mocked, no network
npm run lint    # tsc --noEmit
npm run dev     # needs a .env with DB_PATH=./data/connector.db
npx @modelcontextprotocol/inspector   # connect to http://localhost:8080/mcp
```

## 7. Known limits / to verify against a live administration

* Endpoint paths and field names were checked against the official Exact REST reference, but **nothing here has run against a real
  Exact administration yet**. Run the acceptance checks in the build spec (§10) with an Exact test administration. Fields most worth
  checking first: `RevenueListByYear` (the docs do not say how the year is selected; we send `?year=` and also filter on `Year`),
  `SalesInvoiceLines` and `GLAccounts` select lists (a wrong field name returns a 400 whose message is shown to Claude).
* Exact returns ~60 rows per page and allows 60 requests/minute and a daily quota per app/division. Tools cap pages and rows
  (receivables/payables: ~1200 items; transactions: 200). When capped, the output says `truncated`.
* Rate limits: waits up to 10 s and retries (max 2); longer waits return "rate limit reached, try again in N seconds".
* P&L is the current financial year/period (what Exact's ProfitLossOverview exposes); use `get_revenue_by_period` for other years' revenue.
* Sales orders require Exact's Wholesale & Distribution package; the user needs the matching Exact rights for any write.
* Access tokens last 1 h, refresh tokens 60 d (rotating). SQLite means a single instance; do not run replicas.
* The Docker image has not been built in the environment this was written in (no Docker daemon); `npm run build` and a start
  smoke test were run instead.
