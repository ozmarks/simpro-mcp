# Simpro MCP server

![Node 24+](https://img.shields.io/badge/node-%3E%3D24-3c873a)
![MCP](https://img.shields.io/badge/protocol-MCP-blue)
![Transports: stdio · broker · proxy](https://img.shields.io/badge/transports-stdio%20%C2%B7%20broker%20%C2%B7%20proxy-555)

An MCP server for Simpro. It gives an AI agent a set of tools for quotes, jobs, customers,
catalogue items, scheduling and billing, plus generic GET/POST/PUT/DELETE tools that reach
the rest of the Simpro API (about 1,500 endpoints).

This is an unofficial, third-party project. It is not affiliated with, endorsed by, or
supported by Simpro.

> [!WARNING]
> The server can create, update and delete records, not just read them. An agent using it
> can change or delete quotes, jobs, customers and catalogue items in your live Simpro
> account, in bulk, with no undo. Don't give it to an agent you don't trust, and don't let
> it run unattended against production.
>
> The software is provided as is, without warranty of any kind. You use it at your own risk.

We built this as an internal tool and run it behind our own MCP gateway (proxy mode). The
`.mcpb` bundle and broker mode were added for other users and we don't run them ourselves.

## Contents

- [Choosing a setup](#choosing-a-setup)
- [Claude Desktop extension](#claude-desktop-extension)
- [Local MCP client with npx](#local-mcp-client-with-npx)
- [Hosted: OAuth broker](#hosted-oauth-broker)
- [Hosted: proxy behind a gateway](#hosted-proxy-behind-a-gateway)
- [Configuration reference](#configuration-reference)
- [How the broker handles sign-in](#how-the-broker-handles-sign-in)
- [Development](#development)
- [License](#license)

## Choosing a setup

| You want to | Use | Needs |
|-------------|-----|-------|
| Use Simpro from Claude Desktop on your own machine | [Claude Desktop extension](#claude-desktop-extension) | Claude Desktop |
| Use it from Claude Code or another local MCP client | [npx](#local-mcp-client-with-npx) | Node.js 24+ |
| Offer a connector your team signs in to individually | [OAuth broker](#hosted-oauth-broker) | Docker (or Node.js 24+), a public HTTPS address |
| Run it behind an MCP gateway that already handles sign-in | [Proxy](#hosted-proxy-behind-a-gateway) | Your gateway, Docker or Node.js 24+ |

Every setup needs a Simpro build you can reach and an OAuth app created in it, under
**Setup → Integrations → API**. The local setups (Desktop extension and npx) can use a
legacy API key instead of an OAuth app. You'll need:

| Value | Where it comes from |
|-------|---------------------|
| Build URL | The address you log in to, e.g. `https://yourbuild.simprosuite.com`. No path, no trailing slash. |
| Company ID | `0` unless your build has more than one company. |
| Client ID and secret | The OAuth app. Treat the secret like a password. |
| Redirect URI | Set on the OAuth app. Each setup below says what it should be. |
| API key | Only if you're using a legacy key instead of an OAuth app. Local setups only. |

## Claude Desktop extension

1. Create the Simpro OAuth app as an Authorization Code application, with the redirect URI
   `http://localhost:8237/callback`. If port 8237 is taken on your machine, use another
   port here and enter the same port in step 4.
2. Download `simpro-mcp-server.mcpb` from the
   [latest release](https://github.com/ozmarks/simpro-mcp/releases).
3. In Claude Desktop, go to **Settings → Extensions → Advanced settings → Install
   extension** and choose the file.
4. Fill in the build URL, company ID, client ID and client secret. Leave the authentication
   mode on `authorization_code`.

The first time a tool runs, a browser tab opens at the Simpro login page. Log in, approve
access, and close the tab. The extension caches a refresh token, so you won't be asked
again unless the token is revoked or expires.

The install screen also offers two other authentication modes:

- `client_credentials` signs in as the OAuth app itself, with no browser step. Use it
  for unattended automation. Simpro's audit trail won't show which person made a change.
- `api_key` uses a legacy Simpro API key. Paste the key into the **Simpro API Key** field
  and leave the client ID and secret empty. Simpro has deprecated static keys, so use this
  only if you can't create an OAuth app.

Claude Desktop stores the client secret, refresh token and any API key. Anyone who has them
can act in your Simpro build. If one leaks, revoke the OAuth app or key in Simpro and create
a new one.

## Local MCP client with npx

The server is published to npm as
[`@ozmarks-group/simpro-mcp-server`](https://www.npmjs.com/package/@ozmarks-group/simpro-mcp-server).
Clients that launch MCP servers as a local command can run it with `npx`. Register
`http://localhost:8237/callback` as the redirect URI on the Simpro OAuth app.

Claude Code:

```bash
claude mcp add simpro \
  --env SIMPRO_BASE_URL=https://yourbuild.simprosuite.com \
  --env SIMPRO_COMPANY_ID=0 \
  --env SIMPRO_AUTH_MODE=authorization_code \
  --env SIMPRO_CLIENT_ID=your-client-id \
  --env SIMPRO_CLIENT_SECRET=your-client-secret \
  -- npx -y @ozmarks-group/simpro-mcp-server
```

Claude Desktop (`claude_desktop_config.json`, under **Settings → Developer → Edit
Config**), or any client using the same format:

```json
{
  "mcpServers": {
    "simpro": {
      "command": "npx",
      "args": ["-y", "@ozmarks-group/simpro-mcp-server"],
      "env": {
        "SIMPRO_BASE_URL": "https://yourbuild.simprosuite.com",
        "SIMPRO_COMPANY_ID": "0",
        "SIMPRO_AUTH_MODE": "authorization_code",
        "SIMPRO_CLIENT_ID": "your-client-id",
        "SIMPRO_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

To use an API key instead, replace the auth mode, client ID and client secret with
`SIMPRO_API_KEY`:

```json
"env": {
  "SIMPRO_BASE_URL": "https://yourbuild.simprosuite.com",
  "SIMPRO_COMPANY_ID": "0",
  "SIMPRO_API_KEY": "your-api-key"
}
```

If you leave out `SIMPRO_AUTH_MODE`, it is worked out from what you set: `client_credentials`
when both client ID and secret are present, otherwise `api_key`.

## Hosted: OAuth broker

In broker mode the server is an OAuth 2.1 authorisation server in front of Simpro. You add
it to Claude (or another MCP client) as a remote connector. Each person clicks connect, logs
in on the normal Simpro login page, and the agent then acts as them. The server stores no
logins. Each person's Simpro tokens are encrypted, using `TOKEN_SEAL_KEY`, inside the token
their MCP client holds.

It needs:

- A public HTTPS address, e.g. `https://simpro.example.com`, on a reverse proxy that
  terminates TLS and forwards to the container. The container speaks plain HTTP.
- A Simpro OAuth app with the redirect URI set to that address plus `/callback`, e.g.
  `https://simpro.example.com/callback`.
- A single instance without any load-balancing. Sign-in state is held in memory.

### With Docker

The image is published to GHCR as `ghcr.io/ozmarks/simpro-mcp`. The repository's
[`docker-compose.yml`](docker-compose.yml) runs it in broker mode. Put it in a directory
with a `.env` file next to it:

```ini
SIMPRO_BASE_URL=https://yourbuild.simprosuite.com
SIMPRO_COMPANY_ID=0
PUBLIC_URL=https://simpro.example.com
SIMPRO_CLIENT_ID=your-client-id
SIMPRO_CLIENT_SECRET=your-client-secret
TOKEN_SEAL_KEY=output-of-openssl-rand-hex-32
```

```bash
docker compose up -d
curl http://127.0.0.1:3000/healthz   # ok
```

To change any other setting from the
[configuration reference](#configuration-reference), add it under `environment:` in the
compose file.

The compose file publishes port 3000 on `127.0.0.1` only, for a reverse proxy on the same
host. If your proxy runs in another container, put both on a shared Docker network and
remove the `ports:` entry.

On platforms like Portainer, deploy the compose file as a stack and set the same variables
in the stack's environment settings.

### With npx

```bash
SIMPRO_TRANSPORT=broker \
SIMPRO_BASE_URL=https://yourbuild.simprosuite.com \
PUBLIC_URL=https://simpro.example.com \
SIMPRO_CLIENT_ID=your-client-id \
SIMPRO_CLIENT_SECRET=your-client-secret \
TOKEN_SEAL_KEY=output-of-openssl-rand-hex-32 \
npx -y @ozmarks-group/simpro-mcp-server
```

Always set `TOKEN_SEAL_KEY` when running this way. Without it the server generates a key
and saves it inside npx's package cache, and everyone is signed out whenever that cache is
cleared or the version changes.

### Connecting a client

Add a custom connector in your client with the URL `https://simpro.example.com/mcp`. The
client is sent to Simpro to log in. There's nothing else to configure.

Any request to `/mcp` without a valid broker token, including listing the tools, gets
`401 Unauthorized`. The `WWW-Authenticate` header points the client at the OAuth metadata,
which is how it knows to start the sign-in.

See [`docs/deploy.md`](docs/deploy.md) for the state the broker keeps, health checks and
logging.

## Hosted: proxy behind a gateway

In proxy mode the server does no authentication. Each request must carry a Simpro access
token in its `Authorization: Bearer` header, and the server forwards it to Simpro unchanged.
It doesn't check the token. Simpro decides whether it's valid.

Requests without a token are not rejected. `initialize` and `tools/list` succeed, so
anyone who can reach the server can see the tool names and their arguments. A tool call
returns a tool error, "Unauthorized: this request carried no Authorization: Bearer token.",
without contacting Simpro.

Use this only behind an MCP gateway or reverse proxy that signs users in to Simpro and
attaches their token. Never expose it to the internet directly: anyone who can reach it can
send requests to Simpro with whatever token they have.

Gateways that launch MCP servers as a command can run it with npx:

```bash
SIMPRO_TRANSPORT=proxy \
SIMPRO_BASE_URL=https://yourbuild.simprosuite.com \
npx -y @ozmarks-group/simpro-mcp-server
```

To run it as a container, see the
[proxy mode example](docs/deploy.md#proxy-mode-container) in `docs/deploy.md`.

If your gateway runs its own OAuth flow against Simpro, the authorisation endpoint is
`<build URL>/oauth2/login` (not `/authorize`), the token endpoint is
`<build URL>/oauth2/token`, and the only scope Simpro accepts is `openid`.

## Configuration reference

All settings are environment variables. When running from a source checkout, they can also
go in a `.env` file at the repository root (see [`.env.example`](.env.example)), or in any
file named by `SIMPRO_ENV_FILE`. Variables already set in the environment take precedence.

### All modes

| Variable | Default | |
|----------|---------|---|
| `SIMPRO_BASE_URL` | (required) | Simpro build address. No path, no trailing slash. |
| `SIMPRO_COMPANY_ID` | `0` | |
| `SIMPRO_TRANSPORT` | `stdio` | `stdio`, `broker` or `proxy`. The Docker image defaults to `broker`. |
| `SIMPRO_DEFAULT_PAGE_SIZE` | `50` | Rows per page when a tool call doesn't specify one. Max 250. |
| `SIMPRO_MAX_RESULT_BYTES` | `100000` | Results larger than this are withheld and the agent is told to narrow the request. |
| `SIMPRO_MAX_UPLOAD_BYTES` | `52428800` | Largest attachment the upload tools accept (50 MB). |
| `SIMPRO_UPLOAD_MEMORY_BYTES` | `209715200` | Memory all in-progress uploads may use together (200 MB). |
| `SIMPRO_VERSION_CHECK` | on | Set to `off` to stop the server checking GitHub for newer releases. |

### stdio

| Variable | Default | |
|----------|---------|---|
| `SIMPRO_AUTH_MODE` | inferred | `authorization_code`, `client_credentials` or `api_key`. |
| `SIMPRO_CLIENT_ID`, `SIMPRO_CLIENT_SECRET` | | Needed for `authorization_code` and `client_credentials`. |
| `SIMPRO_AUTH_REDIRECT_PORT` | `8237` | Port for the login callback. The redirect URI on the OAuth app must be `http://localhost:<port>/callback`. |
| `SIMPRO_API_KEY` | | Legacy key, for `api_key` mode. stdio only. |

### broker and proxy

| Variable | Default | |
|----------|---------|---|
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | Set to `127.0.0.1` to accept same-host connections only. |
| `MCP_PATH` | `/mcp` | The health check is always at `/healthz`. |
| `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS` | | Comma-separated allow-lists for the `Host` and `Origin` headers on the MCP path. Requests that don't match get 403. Off unless one is set. Broker mode adds `PUBLIC_URL`'s host automatically. |

The server won't start in either HTTP mode if `SIMPRO_API_KEY` is set.

### broker only

| Variable | Default | |
|----------|---------|---|
| `PUBLIC_URL` | (required) | The public HTTPS address of the server. |
| `SIMPRO_CLIENT_ID`, `SIMPRO_CLIENT_SECRET` | (required) | The Simpro OAuth app. |
| `TOKEN_SEAL_KEY` | generated | 32 bytes as hex or base64 (`openssl rand -hex 32`). Encrypts the tokens the broker issues. If it changes, everyone is signed out. If unset, a key is generated and saved in the state directory. |
| `SIMPRO_AUTH_URL` | `<base>/oauth2/login` | Only change it if your build uses a different login URL. |
| `SIMPRO_TOKEN_URL` | `<base>/oauth2/token` | |
| `STATIC_CLIENTS` | | JSON array of pre-registered confidential clients, for connectors that don't use CIMD or dynamic registration. Example in `.env.example`. |
| `SIMPRO_REFRESH_GRACE_TTL_MS` | `600000` | How long the broker holds a rotated Simpro refresh token in memory, so a client that lost a refresh response can retry. |

## How the broker handles sign-in

MCP clients such as Claude only connect to authorisation servers that follow OAuth 2.1.
Simpro's OAuth is 2.0 without PKCE and without the client registration methods those
clients use. The broker acts as the OAuth 2.1 server and passes the actual login through to
Simpro. It adds:

- **PKCE (S256).** The client sends a code challenge to `/authorize` and must prove it at
  `/token`. Simpro doesn't check PKCE, so the broker does.
- **Client registration without a shared secret.** A client can identify itself in two
  ways:
  - CIMD: the client ID is a URL to a metadata document. The broker fetches it on each
    authorisation, checks that it names itself and lists the exact redirect URI in use, and
    guards the fetch against requests to private network addresses.
  - Dynamic client registration (RFC 7591): the client calls `POST /register` to get a
    client ID. Registration is open, so it is rate- and size-limited, the oldest entries
    are dropped at the cap, and registrations are saved to disk.

  Simpro never sees the client's identity. Every login goes to Simpro under the one OAuth
  app the broker is configured with.
- **Exact redirect URI matching.** Prefix matches are rejected.
- **Short-lived tokens bound to this server.** Clients get tokens issued by the broker, with
  an expiry and this server as the audience. The Simpro tokens are encrypted inside them.
  Refresh tokens last at most 30 days.

The broker keeps no token database, with one exception. Simpro invalidates a refresh token
when it's used, so if a client loses the response to a refresh it would otherwise have to
log in again. To cover that, the broker keeps the newest Simpro refresh token for each login
in memory for a few minutes. It is never written to disk and is cleared on the next
successful refresh or on restart.

## Development

```bash
npm install
npm run build        # compile to dist/
npm test             # unit tests
npm start            # run dist/index.js
npm run login        # authorization_code login only: cache the refresh token, then exit
npm run build:mcpb   # build simpro-mcp-server.mcpb
```

Copy `.env.example` to `.env` and fill it in before running: the build URL and company ID,
plus either the OAuth client ID and secret or `SIMPRO_API_KEY`. `npm start` uses stdio unless
`SIMPRO_TRANSPORT` says otherwise.

The unit tests cover the code that doesn't talk to the network: search ranking, output
formatting, line-item paths, and the auth crypto and storage helpers. Nothing mocks Simpro,
so checking a change properly means running it against a real Simpro build. Architecture
notes and Simpro API quirks are in [`CLAUDE.md`](CLAUDE.md).

## License

[Functional Source License, Version 1.1, ALv2 Future License](LICENSE.md) (`FSL-1.1-ALv2`).
You can use, modify and redistribute it for any purpose except a Competing Use: offering
it, or something substantially similar, to others as a commercial product or service. Each
release becomes available under the Apache License 2.0 two years after it is published.
