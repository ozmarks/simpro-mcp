# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP (Model Context Protocol) server that exposes Simpro operations via its REST API to MCP clients. It runs over **stdio** (local) or **streamable HTTP**.

## Commands

```bash
npm run build      # tsc → dist/, then copy data/ → dist/data/ (run before start)
npm run dev        # tsc --watch
npm start          # node dist/index.js (must build first)
npm run login      # node dist/login.js — run the stdio authorization_code browser flow, cache the refresh token, exit
npm run copy-data  # re-run just the data copy step
npm test           # tsc -p tsconfig.test.json → dist-test/, then node --test
```

There is a **test suite** (`npm test`: compiles via `tsconfig.test.json` to
`dist-test/`, then runs `node --test` over `dist-test/test/**/*.test.js`). It covers the deterministic units. No network mocking, so the HTTP client, token provider, and broker routes are not unit-tested. Beyond the unit tests, "verifying" a change still means building and exercising tools against a live Simpro instance. 

### Running / debugging locally

1. Copy `.env.example` → `.env` and fill in `SIMPRO_BASE_URL`, `SIMPRO_COMPANY_ID`, and `SIMPRO_CLIENT_ID` + `SIMPRO_CLIENT_SECRET` (a Simpro **client-credentials** OAuth app. `SIMPRO_API_KEY` still works when no client credentials are set, but prefer OAuth. `SIMPRO_TRANSPORT=stdio` to set stdio output
2. `npm run build && npm start` — defaults to stdio.
**`SIMPRO_API_KEY` must be unset on HTTP paths** — the server refuses to
   start otherwise (it's a stdio-only credential).

## Architecture

`src/index.ts` selects one of three transports by `SIMPRO_TRANSPORT`: `stdio`
(default), `proxy`, or `broker`. All three end at `buildServer()` →
`registerTools(server, client, cfg)`; the tool layer is identical and auth is the
only thing that flows through differently (the `requestBearer` wiring in
`simproClient.ts`). The non-obvious parts:

- **stdio** keeps one long-lived client. `SIMPRO_AUTH_MODE`, when unset, is
  *inferred*: `client_credentials` if both id+secret are present, else `api_key`.
  In `authorization_code` mode the callback is a **localhost URI**
  (`http://localhost:<port>/callback`; only the port is configurable, via
  `SIMPRO_AUTH_REDIRECT_PORT`, default 8237 — host and `/callback` path are
  hardcoded) that **must be registered on the Simpro app**.
  Unlike the broker, the stdio flow **does** send `redirect_uri` on both
  `/authorize` and the token exchange. Auth happens **eagerly at startup** when no
  refresh token is cached.
- **HTTP passthrough** (`runHttp`): the per-request rebuild of server + client is
  for **auth isolation** (each request carries its own bearer), **not** scaling —
  the server is single-instance by design. Consequently the rate limiter is a
  process-wide singleton (see below), not a client field. No bearer → rejected;
  the api key is never a fallback here.
- **broker** (`runBrokerHttp`, `src/auth/`): OAuth 2.0 broker in front of Simpro
  for the Claude connector. The key design choices:
  - **Stateless sealed-envelope tokens** (`seal.ts`, AES-256-GCM, `TOKEN_SEAL_KEY`):
    the broker issues its own tokens with the Simpro tokens encrypted inside, so
    there is **no token store**.
  - **Single-instance only — do not load-balance.** Flow correlation lives in an
    in-process `Map` (`flowState.ts`).
  - PKCE is enforced **locally** (Simpro does none).
  - **Three coexisting client-identity schemes**, resolved at `/authorize` in
    order: static client → DCR → CIMD. DCR client_ids are random opaque strings
    specifically so they're unambiguous against URL-shaped CIMD ids and static ids
    (static ids are forbidden from being URLs).
  - **CIMD SSRF guard**: resolves the host once, classifies the resolved *bytes*
    (canonicalizing IPv4-mapped IPv6 — a string-prefix check is defeated by
    `::ffff:` literals), then **pins the undici fetch to that address** so a DNS
    rebind can't swing to a private IP between check and connect.
  - The redirect to Simpro **must carry `client_id`** (Simpro 400s "invalid client"
    without it) and is **identical across all three schemes** — the downstream
    client's identity never reaches Simpro, which holds one fixed registration.

### Tool surface design (read this before adding a tool)

The surface is **hybrid**: a small set of intent/workflow tools **plus a generic
escape hatch** (`find_operation` → `simpro_api_get`/`simpro_api_post`/`simpro_api_put`/`simpro_api_delete`) that reaches
all ~1,300 Simpro endpoints. A new endpoint does **not** need a dedicated tool — it's
already reachable via the escape hatch. A tool earns a dedicated slot only if it is:

- **multi-call orchestration** (e.g. `get_breakdown`, `duplicate_work`, `customer_overview`),
- a **consolidation** of several endpoints (e.g. line-item tools across 7 types,
  `find_customers` hiding the company/individual split), or
- a **high-traffic guarded entry point** (e.g. `find_work`, `create_work`).

Thin single-endpoint update/delete verbs intentionally live in the escape hatch.

### Key files

| File | Role |
|------|------|
| `src/index.ts` | Transport selection (stdio vs stateless HTTP), per-request logging tee. |
| `src/config.ts` | Dependency-free `.env` loader + `loadConfig()`. Precedence: existing env → `$SIMPRO_ENV_FILE` → repo-root `.env`. |
| `src/simproClient.ts` | HTTP client: URL building, rate limiter, 429 retry, pagination, async token resolution (bearer / OAuth provider / api-key) + 401 refresh-retry. |
| `src/auth/simproToken.ts` | The shared Simpro token contract (`fetchSimproToken`) + the stdio `ClientCredentialsProvider`. Used by the broker and stdio. |
| `src/auth/authCodeProvider.ts` | stdio `authorization_code` provider: refresh-token cache (`.simpro-tokens.json`) + lazy re-auth via the browser flow. |
| `src/auth/authCodeFlow.ts` | One-time browser login over a fixed-port localhost callback; returns the Simpro refresh token. |
| `src/login.ts` | `npm run login` entry — runs the `authorization_code` browser flow and caches the token without starting the server. |
| `src/tools.ts` | All MCP tool registrations + helpers (~990 lines; the bulk of the logic). |
| `src/lineItems.ts` | The 7 cost-center item types: URL segment, required anchor field, supported verbs. |
| `src/catalog.ts` | Loads `simpro-api-index.json`, keyword-scores endpoints for `find_operation`. |
| `src/format.ts` | Output shaping: HTML rich-text → compact text/markdown, recursive cleaning. |
| `data/simpro-api-index.json` | Prebuilt index of ~1,300 endpoints (method/path/summary/tags/params). Ships with the build. |
| `scripts/copy-data.mjs` | Copies `data/` → `dist/data/` so `dist/` is self-contained in prod. |
| `tsconfig.test.json` | Test build: compiles `src/` + `test/` to `dist-test/` for `node --test`. |

## Hard-won Simpro API constraints for Claude (don't re-learn these)

These are non-obvious and were verified live; the code comments hold the full detail. You can't read the Simpro API documentation because they are mean and block access. 

- **`search` is a match scheme, not free text.** Simpro's `search` query param only
  accepts `all` (AND) / `any` (OR). Passing keywords → `422`. Free-text matching is
  done with **wildcard column filters** (`%kw%`). `buildSearchQuery()` in `tools.ts`
  encapsulates this — use it; don't pass keywords to `search`.
- **Trailing-slash routing is load-bearing.** Item routes ending in `/{id}` must have
  **no** trailing slash; collection routes must **have** one. The wrong slash → opaque
  `404 Invalid route`. `normalizePath()` keys off whether the last segment is numeric.
- **Bulk routes use `/multiple/`.** POSTing an *array* to a bare collection makes Simpro
  read index 0 as a column name (`422 /0: Invalid column`). For many items, append
  `/multiple/` (see `bulk_upsert_items`). `Post-Mode: merge` header increments matching
  Qty; it's documented but not in Swagger.
- **Writes often return 204 No Content** → `data` is `undefined`. `ok()` serializes that
  to `{success:true}` so a successful write doesn't look like a JSON error.
- **Rate limit is 10 req/s per integration**, shared across all users on the Cowork
  OAuth client. The token-bucket limiter runs at ~8/s with burst and is a
  **process-wide singleton** (`sharedLimiter` in `simproClient.ts`), NOT a
  `SimproClient` field — so the fresh per-request clients the HTTP transports build
  all draw from one bucket and concurrent requests throttle together. (As an
  instance field it was effectively defeated: each request started with a full
  bucket.) This is correct because the server is single-instance; load-balancing
  across processes would need a cross-instance limiter (Redis), but the upstream
  10/s ceiling makes scaling out pointless. Simpro sends no `Retry-After`/rate-limit
  headers, so 429 uses our own exponential backoff with jitter (capped under
  Cowork's 30s/call budget).
- **`oneOff` sell price**: write `SellPriceExDiscount` (number) or
  `EstimatedCost`+`Markup`; never POST `SellPrice: { ExTax }` (that's the read shape →
  422). See `ITEM_TYPES.oneOff.createHint`.

## Conventions

- **`ok()` / `fail()`** in `tools.ts` wrap every tool result. `fail()` surfaces Simpro's
  structured `{path, message, value}` errors legibly — keep using them.
- **Never log to stdout** — stdio transport owns it. All diagnostics go to `console.error`.