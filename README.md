# Exact Online connector for Claude (self-hosted remote MCP server)

A remote [MCP](https://modelcontextprotocol.io) server that lets people in your organisation connect Claude
(claude.ai, Claude Desktop, mobile) to **their own** Exact Online administrations. Every user signs in with their own
Exact account, so Claude only sees what that user can already see. The server is read-only unless write tools are
enabled (`ENABLE_WRITE_TOOLS`, off by default). Workloads (agents, scheduled jobs) can call it with an OIDC access token
instead of a broker login.

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
* **Workload callers:** with `JWT_ISSUER` set, a bearer token that is a JWT is verified against the issuer's JWKS (signature,
  `iss`, `aud`, `exp`, optionally `azp`) and runs on the Exact connection of `JWT_EXACT_USER_ID`, which a person connects
  once through the broker. Broker tokens keep working next to it.
* **Exact limits:** a token bucket per division (default 50 calls/minute, 4,500/day) waits up to 10 s or refuses before
  Exact does, and follows the remaining counts in Exact's rate limit headers. A circuit breaker per endpoint stops calls
  after 8 responses with status 400, 401, 403 or 404 in a rolling hour, because Exact blocks the app key at 10.
* **Bookkeeping write tools** (draft entries, attach documents, process, match sets) need Postgres (`DATABASE_URL`) for
  the idempotency ledger and the audit log; without it they are not registered. See TOOLS.md.
* Source layout: `src/oauth/` (auth server + broker), `src/auth/` (JWT validation), `src/exact/` (regions, token manager,
  API client, limits), `src/tools/` (MCP tools), `src/policy/` (validators, description template, approval tiers and
  tokens), `src/db/` and `migrations/` (Postgres ledger and audit log).

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
| `ENABLE_WRITE_TOOLS` | `true` registers every write tool the configuration supports (see TOOLS.md); the log names the ones left out and why. |
| `WRITE_TOOLS` | Comma-separated write tool names to register instead of all of them, e.g. `draft_purchase_entry,attach_document`; an unknown name, or a name the configuration does not support, stops the server at startup. |
| `MAX_ATTACHMENT_MB` | Largest file `attach_document` and the draft tools accept (default 20). |
| `EXACT_RATE_PER_MINUTE` / `EXACT_RATE_PER_DAY` | Calls per division the server allows itself (default 50 and 4,500; Exact allows 60 and 5,000). |
| `EXACT_BREAKER_ERRORS` | Client errors (400/401/403/404) per endpoint per hour that pause the endpoint (default 8, max 9). |
| `JWT_ISSUER` | OIDC issuer URL (a Keycloak realm URL) of workload access tokens; empty: only broker logins. |
| `JWT_AUDIENCE` | Required `aud` of workload tokens; required with `JWT_ISSUER`. |
| `JWT_JWKS_URL` | JWKS URL; default `<JWT_ISSUER>/protocol/openid-connect/certs` (Keycloak). |
| `JWT_ALLOWED_CLIENTS` | Comma-separated `azp` values allowed to call; empty: any client of the issuer with the audience. |
| `JWT_EXACT_USER_ID` | Exact `UserID` GUID whose broker connection workload calls use; required with `JWT_ISSUER`. |
| `DATABASE_URL` | `postgres://` or `postgresql://` URL of the ledger and audit database (the `uri` key of a CloudNativePG `<cluster>-app` Secret fits); migrations in `migrations/` run at startup. Empty: the bookkeeping write tools stay disabled. |
| `APPROVAL_SIGNING_KEY` | HMAC key (32+ characters) of approval tokens; empty: `process_entry` and `create_matchset` stay disabled. |
| `DESCRIPTION_TEMPLATE` | Entry description template with `{supplier}`, `{period}`, `{ref}`, `{short}` (default `{supplier}\|{period}\|{ref}\|{short}`). |
| `DESCRIPTION_MAX_LENGTH` | Longest rendered description (default 60). |
| `DUPLICATE_WINDOW_DAYS` | Days around the invoice date in which the same supplier and gross amount count as a duplicate (default 7). |
| `TIER_AUTO_MAX_EUR` | Auto tier: gross below this (default 250). |
| `TIER_AUTO_MIN_SUPPLIER_ENTRIES` | Auto tier: earlier ledger entries of the supplier (default 3). |
| `TIER_AUTO_HOLD_HOURS` | Auto tier: hours before `process_entry` releases the entry (default 24). |
| `TIER_TWO_STEP_ABOVE_EUR` | Two-step tier: gross or total debit above this (default 5000). |
| `TIER_BALANCE_ACCOUNT_ALLOWLIST` | Balance sheet G/L account codes that do not force two-step (default none). |
| `TIER_PAYROLL_JOURNALS` | Journal codes that always need two-step (default none). |
| `ENABLE_MATCHSETS` | `true` registers `create_matchset` (XML MatchSets upload; default false). |
| `EXACT_PROCESS_MODE` | `record` (default): `process_entry` records the release, a person processes the entry in Exact. `api`: it also sets Status 50 on purchase entries. |
| `APPROVAL_ANSWER_APPROVE` / `APPROVAL_ANSWER_REJECT` | Case-insensitive regular expressions an approver's answer must match, and must not match (defaults in `src/policy/approval.ts`). |
| `AUDIT_MODEL_HEADER` | Request header whose value the audit log stores as model version (default `x-model-version`). |

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
`SESSION_SIGNING_KEY`, `APPROVAL_SIGNING_KEY`, the password in `DATABASE_URL`) from a Secret. A login logs the Exact `UserID`
(`exact login`), which `ALLOWED_EXACT_USER_IDS` and `JWT_EXACT_USER_ID` take. The image carries `migrations/`; the database user
needs `CREATE` on its schema for the first start.

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
* **Audit log:** without `DATABASE_URL`, write tool calls are recorded in the SQLite `audit_log` table (user, division, tool,
  SHA-256 of payload, Exact id, time). With it, every tool call is recorded in the Postgres `audit_log` table: time, caller kind,
  id, name and client, Exact user, division, tool, SHA-256 of the arguments, outcome (`ok`, `refused`, `error`), HTTP status of
  the last Exact response, Exact id, model version header. Arguments and tokens are never stored. The server never deletes audit
  rows; keep them for the statutory retention period (7 years in the Netherlands) and grant the application role no `DELETE`
  on `audit_log` once migrated.
* **Approval tokens:** `npm run approval-token -- --entry <draftId> --tier approve|two-step --approver <id> [--channel <ch>] [--answer <text>] [--hours 24]`
  with `APPROVAL_SIGNING_KEY` in the environment prints a token for `process_entry` or `create_matchset`; a two-step token
  needs `--channel`. An approval service
  that holds the key issues them by the format and test vector in TOOLS.md (*Approval token format*).
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
* The REST API documents no call that processes an entry: `GeneralJournalEntries` has no PUT, and whether `PUT PurchaseEntries`
  accepts `Status: 50` is unverified, so `EXACT_PROCESS_MODE=api` stays off until tested in a demo administration.
* Whether entries posted through the API stay open (Status 20) depends on the journal settings; the draft tools report a
  warning when Exact answers with another status.
* `create_matchset` follows the XML format of `XMLUpload.aspx?Topic=MatchSets` and stays behind `ENABLE_MATCHSETS` until a
  synthetic test pair has been matched and unmatched (by hand in Exact) in a real administration.
* P&L is the current financial year/period (what Exact's ProfitLossOverview exposes); use `get_revenue_by_period` for other years' revenue.
* Sales orders require Exact's Wholesale & Distribution package; the user needs the matching Exact rights for any write.
* Access tokens last 1 h, refresh tokens 60 d (rotating). SQLite, the in-memory rate limiter and the circuit breaker mean a
  single instance; do not run replicas.
* The Docker image has not been built in the environment this was written in (no Docker daemon); `npm run build` and a start
  smoke test were run instead.
