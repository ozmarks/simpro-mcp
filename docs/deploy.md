# Deploying the Simpro MCP server

The server selects one of three transports via `SIMPRO_TRANSPORT`. Pick the one
that matches how clients reach it, then deploy accordingly.

| Transport | `SIMPRO_TRANSPORT` | Auth | Who connects |
|-----------|--------------------|------|--------------|
| **stdio** | `stdio` (default) | Static `SIMPRO_API_KEY` | A local MCP client launching the process directly. |
| **HTTP passthrough** | `proxy` | Per-request `Authorization: Bearer` | An upstream gateway that already owns OAuth and forwards the Simpro token. |
| **OAuth broker** | `broker` | The broker mints its own tokens (sealed envelope) | The Claude connector, talking OAuth 2.0 to this server directly. |

`stdio` is for local use and is documented in the README. This doc covers the
two containerized HTTP modes.

---

## Mode A — HTTP passthrough (`proxy`)

Use this when an upstream gateway terminates OAuth and forwards the Simpro
token on every request.

```
   Upstream gateway              ← owns the OAuth flow, mints/refreshes the
        │                          Simpro token, forwards it per request as
        │  POST /mcp                Authorization: Bearer <token>
        │  Authorization: Bearer
        ▼
   simpro-mcp  (this container)   ← STATELESS. Reads the Bearer off the request,
        │                          calls Simpro with it. No OAuth, no sessions,
        ▼                          no static key needed on this path.
   Simpro API
```

The server holds no session state between requests — each `POST /mcp` builds a
fresh client carrying that request's Bearer, for **auth isolation**, not
scaling. It is **single-instance by design** (the rate limiter is a per-process
singleton; see Notes). `SIMPRO_API_KEY` must be unset — the server refuses to
start on an HTTP transport if it is set.

### Environment variables

| Variable | Required | Notes |
|----------|----------|-------|
| `SIMPRO_TRANSPORT` | **yes** | `proxy`. |
| `SIMPRO_BASE_URL` | **yes** | e.g. `https://yourbuild.simprosuite.com`. No trailing slash, no `/api`. |
| `SIMPRO_COMPANY_ID` | no | Defaults to `0`. |
| `PORT` | no | Defaults to `3000`. |
| `HOST` | no | Interface to bind. Defaults to `0.0.0.0` (all interfaces). Set to `127.0.0.1` to accept only same-host connections. |
| `MCP_PATH` | no | Defaults to `/mcp`. |
| `SIMPRO_DEFAULT_PAGE_SIZE` | no | Defaults to `50` (Simpro max 250). |
| `SIMPRO_MAX_RESULT_BYTES` | no | Defaults to `100000` (~25k tokens). |
| `SIMPRO_API_KEY` | — | **Must be unset.** The server refuses to start on HTTP if set. |

---

## Mode B — OAuth broker (`broker`)

Use this when the Claude connector talks OAuth 2.0 to this server directly,
with no separate gateway. The server runs the full broker: it advertises the
authorization-server metadata, drives the Simpro login, and issues its own
tokens to Claude with the Simpro tokens sealed inside (AES-256-GCM, no token
store).

```
   Claude connector              ← OAuth 2.0 (CIMD client identity, PKCE)
        │  /authorize → /callback → /token
        │  POST /mcp
        │  Authorization: Bearer <broker token>
        ▼
   simpro-mcp  (this container)   ← unseals the broker token, drives the same
        │                          passthrough path with the inner Simpro token.
        ▼
   Simpro API
```

Broker flow correlation is an in-process map, so this mode is also
**single-instance only — do not load-balance it.**

### Environment variables

Everything from Mode A (`PORT`, `HOST`, `MCP_PATH`, page-size tuning — except
`SIMPRO_TRANSPORT: broker`), plus:

| Variable | Required | Notes |
|----------|----------|-------|
| `PUBLIC_URL` | **yes** | The broker's externally reachable HTTPS origin, e.g. `https://mcp.example.com`. Issuer, resource, and token audience all derive from it. |
| `SIMPRO_CLIENT_ID` | **yes** | The Simpro OAuth client id. |
| `SIMPRO_CLIENT_SECRET` | **yes** | The Simpro OAuth client secret. |
| `TOKEN_SEAL_KEY` | see Notes | 64 hex chars or canonical 32-byte base64 (`openssl rand -hex 32`). Seals the stateless tokens. If unset, an auto-generated key is persisted under the state dir (see below). |
| `SIMPRO_AUTH_URL` | no | Defaults to `SIMPRO_BASE_URL/oauth2/login`. |
| `SIMPRO_TOKEN_URL` | no | Defaults to `SIMPRO_BASE_URL/oauth2/token`. |

#### Broker state must survive restarts

The broker persists two pieces of state under a **state dir**: the seal key and
the open-DCR client registrations. The state dir is `/data` when that directory
exists (the container image creates it, owned by the non-root `node` user),
otherwise the build root for local checkouts. There is **no env knob** for the
path — to relocate it, map a volume onto `/data`.

The seal key encrypts every issued token. If it changes, all outstanding tokens
are invalidated and every client must re-authenticate. Key precedence:

1. `TOKEN_SEAL_KEY` (env) — wins.
2. `<state-dir>/.token-seal-key`, if it exists.
3. Otherwise the server **generates one and writes it there** (mode `0600`).

DCR clients land in `<state-dir>/.dcr-clients.json`. In a container, both only
persist across restarts if the state dir is durable. The bundled
`docker-compose.yml` mounts a named volume at `/data` for exactly this. To manage
the seal key yourself, set `TOKEN_SEAL_KEY`; the volume is still needed for DCR
clients if you use open registration.

---

## Containerized deployment

The same image serves both HTTP modes; the transport is chosen by env var. The
`Dockerfile` is a two-stage build (stage 1 runs `npm ci` + `npm run build`;
stage 2 ships prod deps only + the self-contained `dist/`), runs as the
non-root `node` user, and defaults to `SIMPRO_TRANSPORT=broker` and `PORT=3000`
(override with `SIMPRO_TRANSPORT=proxy` for the passthrough mode).

`docker-compose.yml` is a standalone stack: it builds the image, runs the
healthcheck against `/healthz`, and mounts the `broker-state` volume at `/data`
for broker state (seal key + DCR clients). Deploy it on any container platform (compose, a Git-backed stack, etc.).
Provide the env vars for your chosen mode through the platform — **do not commit
a populated `.env`.**

### Build locally vs. pull a published image

The bundled `docker-compose.yml` carries **both** `build: .` and
`image: ghcr.io/ozmarks/simpro-mcp:latest`. As shipped it **builds the image
locally and tags the result** with that name — it does not pull the published
image. To pull the published image instead of building, **remove the `build: .`
line** so only `image:` remains:

```yaml
services:
  simpro-mcp:
    image: ghcr.io/ozmarks/simpro-mcp:latest   # build: . removed → pulls this published image
```

### Reaching the container

No host port is published by default; uncomment the `ports:` block in
`docker-compose.yml` only for local testing. In production the upstream
(gateway or the Claude connector via your reverse proxy) reaches it on the
container network at `http://simpro-mcp:3000/mcp`. TLS terminates upstream —
this process speaks plain HTTP on `PORT`.

---

## Health & smoke test

The container has a built-in healthcheck against `/healthz`. To verify manually
(with a host port published):

```bash
# liveness — both modes
curl -s http://HOST:3000/healthz                      # -> ok

# MCP protocol on the proxy transport (no Simpro call, just lists the tools)
curl -s -X POST http://HOST:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# GET is rejected on the proxy transport (stateless, POST-only)
curl -s -o /dev/null -w "%{http_code}\n" http://HOST:3000/mcp   # -> 405
```

On the **proxy** transport a request that actually reaches Simpro needs a valid
`Authorization: Bearer <token>` — that's what the upstream gateway supplies. On
the **broker** transport, hit the metadata route to confirm the OAuth surface is
live:

```bash
curl -s http://HOST:3000/.well-known/oauth-protected-resource
```

---

## Notes

- **TLS terminates upstream** (gateway / reverse proxy). This process speaks
  plain HTTP on `PORT`.
- **Single-instance by design.** Both HTTP modes keep one genuinely shared piece
  of state — the rate limiter (`sharedLimiter` in `src/simproClient.ts`) — as a
  process-wide singleton so concurrent requests throttle together against
  Simpro's 10 req/s per-integration ceiling. The broker additionally keeps
  in-process flow-correlation state. **Do not load-balance across replicas**;
  the upstream 10/s ceiling makes scaling out pointless anyway. A multi-instance
  deployment would need a shared (e.g. Redis) limiter and flow store.
- Runs as the non-root `node` user; only production deps ship in the runtime
  image.
- **Logging goes to stderr** (never stdout — the stdio transport owns stdout).
  Each HTTP mode logs its bind target on startup (`binding …` then `listening on
  …`), a `failed to start …` line on a bind error, and one timestamped access
  line per request: `<remoteAddr> <method> <url> <status> <ms>`. Behind a gateway
  the remote address is the gateway's in-network IP, not the end client.
