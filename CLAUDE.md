# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP (Model Context Protocol) server that exposes Simpro (field-service / trade
business software) operations — quotes, jobs, customers, catalog, line items, and
cross-collection aggregations — to MCP clients. It runs over **stdio** (local) or
**streamable HTTP** (remote/Cowork). Pure TypeScript, no framework; runtime deps are
`@modelcontextprotocol/sdk`, `zod`, `express` (broker), and `undici` (the SSRF guard
pins the CIMD fetch to a validated IP). Add a dependency when it's the better tool —
there's no zero-dep rule.

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
`dist-test/`, then runs `node --test` over `dist-test/test/**/*.test.js`). It covers
the pure, deterministic units: `catalog.search` (`find_operation` ranking),
`format` (HTML cleaning + the lean pass), `lineItems` (item-type map + path
building), `writeReceipt` (`extractResourceId` header parsing + the `writeReceipt`/
`footgunHint` shaping), `versionCheck` (`compareVersions` + the
fire-and-forget `VersionChecker` against a stubbed fetch + `appendUpdateNotice` latch), and
`auth/{seal,dcrStore,flowState}` (crypto round-trips, DCR
registration, flow-store TTL semantics) — no network mocking, so the HTTP client,
token provider, and broker routes are not unit-tested. No linter or formatter is
configured. Beyond the unit tests, "verifying" a change still means building and
exercising tools against a live Simpro instance.

### Running / debugging locally

1. Copy `.env.example` → `.env` and fill in `SIMPRO_BASE_URL`, `SIMPRO_COMPANY_ID`,
   and `SIMPRO_CLIENT_ID` + `SIMPRO_CLIENT_SECRET` (a Simpro **client-credentials**
   OAuth app — static API keys are deprecated). `SIMPRO_API_KEY` still works as a
   legacy fallback when no client credentials are set, but prefer OAuth.
2. `npm run build && npm start` — defaults to stdio.
3. For HTTP: set `SIMPRO_TRANSPORT=proxy` (and `PORT`; `HOST` defaults to
   `0.0.0.0`). Health check at `/healthz`; MCP mounted at `MCP_PATH` (default
   `/mcp`). **`SIMPRO_API_KEY` must be unset on HTTP** — the server refuses to
   start otherwise (it's a stdio-only credential).

Both HTTP transports log to **stderr**: bind target on startup, a `failed to
start` line on a bind error, and a timestamped access line per request
(`<remoteAddr> <method> <url> <status> <ms>`). `log()`/`accessLog()` in `index.ts`.

Other tuning knobs (read in `config.ts`, both have defaults): `SIMPRO_DEFAULT_PAGE_SIZE`
(default 50, Simpro max 250) and `SIMPRO_MAX_RESULT_BYTES` (default 100 000 — hard
ceiling on a single serialized tool result).

### Version check (`versionCheck.ts`)

A background check flags when a newer release is published. The running version is
single-sourced from `package.json` (`readPackageVersion()` in `config.ts`; `dist/` sits
one level under the package root, and the Dockerfile copies `package.json` into the image,
so `../package.json` resolves in both layouts). `VersionChecker` fetches a small hosted
`version.json` (default `raw.githubusercontent.com/ozmarks/simpro-mcp/main/version.json`,
override with `SIMPRO_VERSION_CHECK_URL`) — at startup and every 6h on an **unref'd** timer
(never keeps the process alive) — and `compareVersions` (dotted-numeric, suffixes ignored)
decides if it's newer. The fetch is time- and size-capped and **fire-and-forget**: any
failure is swallowed and never touches a tool call. On by default; `SIMPRO_VERSION_CHECK=off`
disables it. **Surface differs by transport:** stdio (one long-lived server) appends a notice
as an extra content block on the **first** tool result, then latches off (`appendUpdateNotice`
+ the `updateNoticeSent` flag in `registerTools`); the HTTP transports rebuild per request and
hold no session, so they **log** the notice to stderr once instead and pass no checker to
`registerTools`. `version.json` lives at the repo root and is served by GitHub raw — bump its
`version` (and `package.json`) on release.

### Deployment (containerized — Portainer / Context Forge)

The `Dockerfile` is a two-stage build: stage 1 runs `npm ci` + `npm run build`; stage 2
ships **prod deps only** + the self-contained `dist/` (which already includes
`dist/data/`), runs as the non-root `node` user, and selects the **proxy transport** via
`ENV SIMPRO_TRANSPORT=proxy` (+ `ENV PORT=3000`). The healthcheck hits `/healthz` with an
inline `node -e` (no curl/wget in the alpine base).

`docker-compose.yml` is a standalone Portainer stack. The intended topology (decided
2026-06): **one stack per MCP server**, plus a separate **Context Forge** / MCP-gateway
stack, meeting on a shared external `mcp-gateway` network (`docker network create
mcp-gateway` once on the host). Context Forge owns the Cowork OAuth flow and forwards
the per-request `Authorization: Bearer` — so on the HTTP path this server is stateless,
runs no OAuth, holds no session, and **must not** have `SIMPRO_API_KEY` set (the HTTP
transport refuses to start if it is; auth is the per-request bearer, with no fallback).
The container is not published on the host by default; the gateway reaches it in-network
at `http://simpro-mcp:3000/mcp`. TLS terminates upstream, not here.

## Architecture

`src/index.ts` is the entry point and the only place transport differs. Three
modes, selected by `SIMPRO_TRANSPORT`: `stdio` (default), `proxy`, or `broker`.

- **stdio** (`runStdio`): one long-lived `SimproClient`. Auth is chosen by
  `SIMPRO_AUTH_MODE` (`config.ts:parseAuthMode`; when unset, inferred —
  `client_credentials` if both id+secret are present, else `api_key`):
  - `authorization_code` — interactive `AuthCodeProvider` (`auth/authCodeProvider.ts`):
    a one-time browser login over a **fixed-port localhost callback**
    (`auth/authCodeFlow.ts`, default `http://localhost:8237/callback`; the `/callback`
    path is fixed, only `SIMPRO_AUTH_REDIRECT_PORT` / `SIMPRO_AUTH_URL` configure it).
    That URI must be
    **registered on the Simpro app**; unlike the broker, the stdio flow **does**
    send `redirect_uri` on both `/authorize` and the token exchange. Simpro returns
    a refresh token, cached to `.simpro-tokens.json` (0600, in `resolveStateDir()`)
    so users don't re-authorise each restart; `getToken()` refreshes via
    `grant_type=refresh_token` and re-runs the browser flow if the refresh token is
    gone/rejected. The server authorises **eagerly at startup** when nothing is
    cached; `npm run login` (`src/login.ts`) does the same without starting the server.
  - `client_credentials` — `ClientCredentialsProvider` (machine OAuth, no per-user
    context).
  - `api_key` — the legacy `SIMPRO_API_KEY` (`allowApiKeyFallback: true`).

  Both OAuth providers cache the access token in memory with a 60s expiry skew,
  coalesce concurrent first-callers onto one fetch, and on a 401 invalidate +
  re-fetch once; their token fetches bypass the shared rate limiter (different
  endpoint). A non-`api_key` mode without both id+secret is a startup error. No
  per-request bearer exists.
- **HTTP passthrough** (`runHttp`): no MCP session state between requests — every
  `POST /mcp` builds a *fresh* `McpServer` + transport + `SimproClient`
  (`allowApiKeyFallback: false`), the client carrying *that request's*
  `Authorization: Bearer` token (the Cowork / Copilot vault attaches it). The
  per-request rebuild is for **auth isolation** (each request's token stays its
  own), **not** horizontal scaling — this server is **single-instance by design**
  (see below) and the one genuinely shared piece, the rate limiter, is a
  process-wide singleton so concurrent requests throttle together. No bearer →
  rejected; the api key is never a fallback here. Only `POST` is accepted
  (GET/DELETE → 405).
- **broker** (`runBrokerHttp`, `src/auth/`): an OAuth 2.0 broker in front of
  Simpro for the Claude connector, on **Express**. Serves the unauthenticated
  metadata + `/authorize` + `/callback` + `/token` routes and a bearer-guarded
  `/mcp`. Token model is an **encrypted envelope** (`seal.ts`,
  AES-256-GCM, `TOKEN_SEAL_KEY`): the broker issues its own tokens to Claude with
  the Simpro tokens sealed inside. `requireBearerAuth`'s verifier
  unseals the access token, checks aud/exp, and exposes the Simpro access token via
  `AuthInfo.extra`, which then drives the same passthrough `SimproClient`. The
  access path is stateless; the **refresh path is not**, because **Simpro rotates
  refresh tokens on use** (each `refresh_token` grant burns the presented token and
  returns a new one). A purely-stateless envelope can't survive that — a client that
  drops our refresh response keeps an envelope carrying the now-burned upstream token
  and its next refresh 400s `invalid_grant`. So a **short-TTL in-memory grace buffer**
  (`refreshFamilies.ts`, `SIMPRO_REFRESH_GRACE_TTL_MS`, default 10 min) holds the
  *current* upstream refresh token per grant **family** (a random id minted at
  `authorization_code`, sealed into every refresh envelope alongside a monotonic
  `gen`). On refresh, `decideRefreshToken` compares the envelope's `gen` to the
  buffered one: caught-up → use the envelope's token; one-step-stale (dropped response)
  → net it via the buffered token; >1 generation stale → `invalid_grant`. Pre-upgrade
  envelopes (no `family`) reject once → one re-auth. The buffer is depth-1 (one write
  site, `record`, which is retire-confirmed + stash-new atomically) and
  **single-instance, in-memory** — a restart only costs the in-flight-and-unconfirmed
  refreshes one re-auth. Concurrent double-fires retry-on-conflict once rather than
  fail. Flow correlation is a short-TTL in-process `Map` (`flowState.ts`) —
  **single-instance only; do not load-balance** (the grace buffer reinforces this). Client identity has **three
  coexisting schemes**, resolved at `/authorize` in order: a configured **static
  client** (`STATIC_CLIENTS`, confidential, `client_secret_post`), a runtime
  **DCR** client (`dcrStore.ts`, RFC 7591, open `/register`, persisted to
  `<state-dir>/.dcr-clients.json` — confidential iff it registered a secret), then **CIMD**
  (`cimd.ts`, always public). The AS metadata advertises
  `client_id_metadata_document_supported`, `registration_endpoint`, and
  `token_endpoint_auth_methods_supported: ["none", "client_secret_post",
  "client_secret_basic"]` (`none` + at least one confidential method required or
  Claude falls back to DCR-only; `/token` reads the secret from the
  `Authorization: Basic` header or the body, so both confidential methods work).
  For CIMD, `/authorize`
  dereferences Claude's client_id URL, validates it self-referential + the
  redirect_uri registered and same-origin, behind an SSRF guard. The guard
  resolves the host once, classifies the resolved BYTES (canonicalizing
  IPv4-mapped IPv6 — a string-prefix check is what `::ffff:` mapped literals
  defeat) against private/loopback/link-local ranges, then PINS the undici fetch
  to that address so a DNS rebind can't swing to a private IP between check and
  connect; the fetch is timed and size-capped. DCR-minted client_ids are random
  opaque strings — unambiguous against both URL-shaped CIMD ids and static ids
  (static ids are forbidden from being URLs). The redirect to Simpro must carry
  `client_id` + `response_type=code` + our flow handle in `state` (Simpro 400s
  "invalid client" without `client_id`) and is **identical across all three
  schemes** — the broker holds one fixed Simpro registration; the downstream
  client's identity never reaches Simpro.

All three call `buildServer()` → `registerTools(server, client, cfg)`. The tool layer is
identical across modes; auth is the only thing that flows through differently (see
the `requestBearer` wiring in `simproClient.ts`).

### Tool surface design (read this before adding a tool)

The surface is **hybrid**: a small set of intent/workflow tools **plus a generic
escape hatch** (`find_operation` → `describe_operation` → `simpro_api_get`/`simpro_api_post`/`simpro_api_put`/`simpro_api_delete`)
that reaches all ~1,300 Simpro endpoints. A new endpoint does **not** need a dedicated
tool — it's already reachable via the escape hatch. A tool earns a dedicated slot only
if it is:

- **multi-call orchestration** (e.g. `get_breakdown`, `duplicate_work`, `customer_overview`),
- a **consolidation** of several endpoints (e.g. line-item tools across 7 types —
  `add_line_item`/`update_line_item`/`list_line_items` route by type and guard the
  capability gaps, e.g. assets have no PATCH; `find_customers` hiding the company/
  individual split; `find_materials` searching catalogs **and** prebuilds in one call so
  the agent learns whether a product name is a material vs an assembly — neither the name
  nor any field declares it, so it's resolved by which collection answers), or
- a **high-traffic guarded entry point** (e.g. `find_work`, `create_work`).

Thin single-endpoint update/delete verbs intentionally live in the escape hatch.

**Schema discovery on the escape hatch.** The index carries the request-body schema
(writes) and the resource's column list (GET) per endpoint, so the agent knows what to
send/select without guessing — the original index dropped this. It's surfaced in two
tiers so search stays lean: `find_operation` attaches a **compact preview to its top 3
results only** (writes: required fields + type/enum hints; GET: column names), and
`describe_operation(method, path)` returns the **full** schema for any one endpoint
(every body field incl. optional, or the full column set) — the on-demand path for a
lower-ranked pick or when optional fields are needed. `find_operation`'s default limit
is **10**. GET columns are derived from the resource's GET-by-id response (the list
response only advertises the 1–2 default return columns), so they describe the record
shape, not a guaranteed-filterable set (Simpro doesn't mark filterability). The matcher
(`getEndpoint` in `catalog.ts`) keys templated index paths against concrete agent paths
by collapsing `{placeholder}` and numeric id segments to `*`.

### Key files

| File | Role |
|------|------|
| `src/index.ts` | Transport selection (stdio vs stateless HTTP), per-request logging tee. |
| `src/config.ts` | Dependency-free `.env` loader + `loadConfig()`. Precedence: existing env → `$SIMPRO_ENV_FILE` → repo-root `.env`. |
| `src/simproClient.ts` | HTTP client: URL building, rate limiter, 429 retry, pagination, async token resolution (bearer / OAuth provider / api-key) + 401 refresh-retry. |
| `src/auth/simproToken.ts` | The shared Simpro token contract (`fetchSimproToken`) + the stdio `ClientCredentialsProvider`. Used by the broker and stdio. |
| `src/auth/refreshFamilies.ts` | Broker rotation grace buffer: in-memory `{family → current Simpro refresh token}` + the pure `decideRefreshToken` table. Survives Simpro's refresh-token rotation across dropped responses. |
| `src/auth/authCodeProvider.ts` | stdio `authorization_code` provider: refresh-token cache (`.simpro-tokens.json`) + lazy re-auth via the browser flow. |
| `src/auth/authCodeFlow.ts` | One-time browser login over a fixed-port localhost callback; returns the Simpro refresh token. |
| `src/login.ts` | `npm run login` entry — runs the `authorization_code` browser flow and caches the token without starting the server. |
| `src/tools.ts` | All MCP tool registrations + helpers (~990 lines; the bulk of the logic). |
| `src/lineItems.ts` | The 7 cost-center item types: URL segment, required anchor field, supported verbs. |
| `src/catalog.ts` | Loads `simpro-api-index.json`, keyword-scores endpoints for `find_operation`, and resolves one endpoint's schema by method+path (`getEndpoint`) for `describe_operation`. |
| `src/format.ts` | Output shaping: HTML rich-text → compact text/markdown, recursive cleaning. |
| `src/versionCheck.ts` | Background "newer release available?" check: fetch hosted `version.json`, `compareVersions`, cache + unref'd timer. Fire-and-forget. |
| `version.json` | The hosted version manifest (`{version, url, notice}`), served by GitHub raw; bump on release. |
| `data/simpro-api-index.json` | Prebuilt index of ~1,300 endpoints (method/path/summary/tags/params **+ body schema for writes, column list for GETs**). Committed; ships with the build. |
| `scripts/build-index.mjs` | Regenerates the index from the full Swagger spec (in `docs-personal/`, ~24MB, **not** checked in). Run manually via `npm run build-index [spec-path]` after a spec refresh — `npm run build` does **not** run it. |
| `scripts/copy-data.mjs` | Copies `data/` → `dist/data/` so `dist/` is self-contained in prod. |
| `tsconfig.test.json` | Test build: compiles `src/` + `test/` to `dist-test/` for `node --test`. |

## Hard-won Simpro API constraints (don't re-learn these)

These are non-obvious and were verified live; the code comments hold the full detail.

- **`search` is a match scheme, not free text.** Simpro's `search` query param only
  accepts `all` (AND) / `any` (OR). Passing keywords → `422 "Search scheme must be one of
  [\"all\",\"any\"]"` (live-verified). Free-text matching is done with **wildcard column
  filters** (`%kw%`). `buildSearchQuery()` in `tools.ts` encapsulates this — use it; don't
  pass keywords to `search`. The dedicated finders (`find_work`/`find_customers`)
  expose a `keywords` param backed by it. The **generic escape hatch**
  (`simpro_api_get`) also takes `keywords` + an explicit `keywordColumns` — the passthrough
  can't know a resource's "name" column (Name vs CompanyName vs GivenName/FamilyName vs
  PartNo…), so the agent must name it; `keywords` without `keywordColumns` fails fast.
- **`searchText` is the real free-text search on `catalogs/` and `prebuilds/`** (and is
  easily confused with the `search` match scheme above — they're different params). It's a
  **token-aware wildcard** over name + part number, so it beats `buildSearchQuery`'s `%kw%`
  substring (which needs the words contiguous — e.g. `searchText=centre line` matches
  "Single Solid Centre Line", `%centre line%` does not). It is **not in the Swagger spec**
  (so not in our index), but live-verified 2026-06-23: it filters, a junk term returns
  `[]` (not silently the whole list), and it composes with `Archived=false`. `find_materials`
  uses it. When several records share a name, **`Group` (with its `ParentGroup`) is the
  field that distinguishes them** — it's an org-specific grouping (product category, brand,
  rate book — varies per Simpro setup), so surface the options rather than guessing.
- **Trailing-slash routing is load-bearing.** Item routes ending in `/{id}` must have
  **no** trailing slash; collection routes must **have** one. The wrong slash → opaque
  `404 Invalid route`. `normalizePath()` keys off whether the last segment is numeric.
- **Bulk routes use `/multiple/`.** POSTing an *array* to a bare collection makes Simpro
  read index 0 as a column name (`422 /0: Invalid column`). For many items, append
  `/multiple/` (see `bulk_upsert_items`). `Post-Mode: merge` header increments matching
  Qty; it's documented but not in Swagger.
- **Writes often return 204 No Content** → `data` is `undefined`. `ok()` serializes that
  to `{success:true}` so a successful write doesn't look like a JSON error. The created/
  updated id is in the response **headers**, not the body: Simpro sends a `Location`
  (`.../catalogs/123`) and/or `Resource-ID` header. `requestWithReceipt` +
  `extractResourceId` (`simproClient.ts`) surface it, and `okWrite`/`writeReceipt`
  (`tools.ts`) merge it into the result as `resourceId` — so a write that returns 204
  still yields `{success:true, resourceId}`. This is a **receipt, not idempotency**: the
  server keeps no dedup map (stateless HTTP, no Simpro idempotency key), so a lost-socket
  retry that already wrote will write again — the id just lets the agent confirm-by-id
  instead of GET-and-diff. (Live-verified: PATCH 204 → `{resourceId}`; POST 201 echoes
  body + `resourceId`.)
- **Customers are split** into companies vs individuals (different routes/columns).
  `get_customer`/`getCustomerAny` try companies, fall back to individuals on 404.
- **Jobs and quotes are structurally identical** ("work"); `entity: 'job'|'quote'`
  selects `jobs/` vs `quotes/`. Both **require** Customer + Site + Type on create.
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
- **Refresh tokens are single-use and rotate** (live-verified). Every Simpro
  `refresh_token` grant returns a **new** refresh token and immediately invalidates the
  one presented — replaying a spent token → `400 invalid_grant "Invalid refresh token"`.
  This bites the broker, whose refresh token is a stateless sealed envelope: a client
  that drops our refresh response keeps an envelope holding the now-burned upstream token,
  so its next refresh dies and the agent sees the session vanish. The **grace buffer**
  (`auth/refreshFamilies.ts`, see the broker section above) is what makes this survivable
  — don't remove it, and don't assume the envelope alone can carry refresh state.
- **`oneOff` sell price**: write `SellPriceExDiscount` (number) or
  `EstimatedCost`+`Markup`; never POST `SellPrice: { ExTax }` (that's the read shape).
  Live, this 422s with path `/SellPrice/ExTax`, message *"This API Column does not allow
  POST requests."* — opaque, so `footgunHint()` in `tools.ts` matches the `SellPrice` path
  and appends the fix to the error. (Per the project decision: clearer errors only, no
  silent translation / strip-lists.) See `ITEM_TYPES.oneOff.createHint`.
- **Catalog `UOM` is often null** — Simpro's own catalog data, not a bug here (live: many
  items return `UOM: null`; it's an object `{ID, Name}` when set). `find_materials` returns
  `uom` on catalog matches and, when any are null, adds a `note` listing those ids so the
  agent knows the unit is unspecified upstream rather than assuming "Each". We do **not**
  invent a unit — surface the gap only.

## Conventions

- **ESM + Node16 module resolution**: import paths use `.js` extensions even for `.ts`
  sources (e.g. `import { x } from "./config.js"`). TypeScript `strict` is on.
- **`ok()` / `fail()`** in `tools.ts` wrap every tool result. `fail()` surfaces Simpro's
  structured `{path, message, value}` errors legibly — keep using them.
- **Line endings are LF** (`.gitattributes` normalizes), even on Windows. JSON files are
  marked `eol=lf`; `package-lock.json` is `-diff`.
- **Never log to stdout** — stdio transport owns it. All diagnostics go to `console.error`.
- The `dist/` and `node_modules/` dirs and `.env*` (except `.env.example`) are gitignored.
- **Keep everything generic to Simpro — never industry-specific.** This server targets *any*
  Simpro business, not the deploying org's trade. When generating tools, examples, comments,
  or test data, frame them around generic Simpro concepts (jobs, quotes, customers, sites,
  catalog, line items), never around a particular industry's terminology, workflows, or part types.
