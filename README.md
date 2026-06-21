# Simpro MCP server

Lets an AI agent work with your Simpro account — look up quotes, jobs, customers, and the
catalogue, read and update line items, and pull together figures that would normally mean
clicking through several screens. You ask in plain English; the agent does the lookups and
changes in Simpro for you.

It reaches every part of the Simpro API, so even if there isn't a purpose-built tool for
something, the agent can still get to it.

> ⚠️ **This tool can write and delete, not just read.** It reaches the full Simpro API,
> including the endpoints that update and delete records. An AI agent driving it can — by
> mistake or by following a bad instruction — modify or destroy quotes, jobs, customers,
> catalogue items, and more in your live Simpro account, in bulk, with no undo. It acts with
> whatever permissions the key or login you give it has. **Don't hand it to an agent you
> don't trust, don't let it run unattended against production, and give it a Simpro
> login/key scoped to only what it actually needs.** If you want read-only safety, create a
> Simpro user with read-only permissions and authenticate as that user.
>
> This software is provided **"as is", without warranty of any kind**, express or implied.
> You run it at your own risk; the authors accept no liability for any loss, damage, or
> changes made to your Simpro data through its use.

There are three ways to run it. Most people want the first one.

---

## 1. Install into Claude Desktop (the easy way)

No command line, no setup files. You install the `.mcpb` bundle from Claude Desktop's
extension settings, fill in a short form, and log in to Simpro once in your browser. After
that the agent stays signed in and you just chat.

### What you need from Simpro

You authenticate with a **Simpro OAuth app**, which signs you in through Simpro's own login
screen — the recommended way. Create one in Simpro under **Setup → Integrations → API → New
API Key** (choose an OAuth / "Authorization Code" application), then note:

| Thing | Where to find it |
|-------|------------------|
| **Build URL** | The web address you log in to, e.g. `https://yourbuild.simprosuite.com`. Just the address — nothing after `.com`. |
| **Company ID** | Almost always `0` if your account has one company. |
| **Client ID** | From the OAuth app you create. |
| **Client secret** | From the same OAuth app. Treat it like a password. |

**One important step:** in your Simpro OAuth app, set the **Redirect URI** to
`http://localhost:8237/callback`. This is where Simpro sends you back after you log in. It
must match exactly. If port `8237` is already in use on your machine, pick another and set
the matching **Auth redirect port** on the install screen — but the registered redirect URI
must use the same port.

### Installing

1. Download the latest **`simpro-mcp-server.mcpb`** file from the
   [Releases page](https://github.com/Ozmarks/simpro-mcp/releases).
2. In Claude Desktop, open **Settings → Extensions**, click **Advanced settings**, then
   **Install extension** (you may first need to enable developer/extension installs there).
   Pick the `simpro-mcp-server.mcpb` file you downloaded. An install screen appears.
3. Fill in:
   - **Build URL** and **Company ID**
   - **Authentication mode** — leave on `authorization_code` (the browser login).
   - **Client ID** and **Client secret** from your Simpro OAuth app.
   - Leave **Auth redirect port** at `8237` unless you registered a different one.
4. Click install.

### Logging in (the OAuth flow)

The first time the agent uses the tool, a browser tab opens at the Simpro login screen. Log
in and approve access. The tab shows **"✓ Authorised"** — close it and return to your chat.

That one login is all you need. The tool caches a refresh token, so it stays signed in
across restarts and you won't be prompted again until that token is revoked or expires. If
that ever happens, it just opens the login tab again.

That's it — start a chat and ask something like *"show me open quotes for Acme"* or
*"what's on job 4521?"*.

> **Page size** is an optional setting on the install screen. Leave it at 50. It just caps
> how many rows come back at once so big lists don't overwhelm a single answer — the agent
> can always ask for more.

### Other ways to authenticate

The **Authentication mode** field on the install screen offers three choices:

| Mode | What it is | When to use |
|------|------------|-------------|
| `authorization_code` | Browser login as **you**. Acts with your Simpro permissions. | **Default — recommended.** |
| `client_credentials` | Machine login with no user. Acts with the OAuth app's full access. | Unattended/automation where there's no person to log in. Also needs Client ID + secret; no browser step. |
| `api_key` | A legacy standalone API key. | Only if you can't create an OAuth app. Paste the key into the **Simpro API Key** field. Static keys are deprecated by Simpro. |

### Keeping your credentials safe

Your client secret, refresh token, and any API key are stored by Claude Desktop and used
only to talk to your own Simpro build. Anyone with them can act in Simpro with the same
access you've granted, so don't share the `.mcpb` install or those values with people who
shouldn't have that access. If a credential is ever exposed, revoke the OAuth app or key in
Simpro and create a new one.

---

## 2. HTTP Proxy Mode (for a shared/hosted setup)

For teams running this on a server behind something that already handles sign-in (for
example a Cowork or Copilot setup). In this mode the server holds **no** Simpro key of its
own — each request brings its own login, attached by whatever signs your users in. The
server just passes it through to Simpro. 

> ⚠️ **Not designed to be internet-facing.** This mode must run **behind a gateway or
> reverse proxy** (an MCP gateway, Context Forge, or something like nginx/Traefik) that
> terminates TLS and authenticates users. It does no auth of its own and is not hardened for
> direct exposure — never publish it straight to the internet. The container intentionally
> isn't published on the host by default; the gateway reaches it on a private network.

To use this mode, set `SIMPRO_TRANSPORT=proxy` (the supplied Docker setup defaults to the
safer **broker mode** below). If you're deploying with Portainer or Context Forge, see
[`docs/deploy.md`](docs/deploy.md) for the stack layout.

You won't set an API key here — in fact the server refuses to start if one is present,
because in this mode the per-user login is the only thing that should be granting access.

**Important — this mode does no checking of its own.** Whatever `Authorization` header
arrives with a request is forwarded straight through to Simpro, untouched. The server does
**not** verify that the credential is valid, unexpired, or that the request came from
someone allowed to make it — Simpro is the only thing that decides whether the credential
works. That's by design: this mode assumes the layer in front of it (the gateway or sign-in
system) has already authenticated the user and attached a trustworthy header. **Only run
this mode behind such a layer.** If you expose it directly, anyone who can reach it can have
their header passed to Simpro as-is.

### Settings

These are set as environment variables (in your `.env` file or by your container platform).

| Setting | Required | What it does |
|---------|----------|--------------|
| `SIMPRO_TRANSPORT` | yes | Set to `proxy` to turn on this mode. |
| `SIMPRO_BASE_URL` | yes | Your Simpro build address, e.g. `https://yourbuild.simprosuite.com`. Nothing after `.com`. |
| `SIMPRO_COMPANY_ID` | no | Your company ID. Defaults to `0`. |
| `PORT` | no | Port the server listens on. Defaults to `3000`. |
| `HOST` | no | Network interface to bind. Defaults to `0.0.0.0` (all interfaces). Set to `127.0.0.1` to accept only same-host connections. |
| `MCP_PATH` | no | Web path the server is reached at. Defaults to `/mcp`. (Health check is always at `/healthz`.) |

Do **not** set `SIMPRO_API_KEY` in this mode — the server will refuse to start.

You can also tune how much data comes back at once:

| Setting | Default | What it does |
|---------|---------|--------------|
| `SIMPRO_DEFAULT_PAGE_SIZE` | `50` | Rows per page for list results when not specified. Max 250. |
| `SIMPRO_MAX_RESULT_BYTES` | `100000` | Largest single answer allowed before it's held back and the agent is asked to narrow the request. ~100,000 suits Claude Code; raise toward `600000` for Claude.ai. |

---

## 3. OAuth Broker Mode (for the AI agent connector)

For connecting Simpro to an AI agent as a proper **connector**, where each person signs in
to Simpro themselves through the normal Simpro login screen — no shared key, no per-person
setup file.

**This is the mode the supplied Docker setup defaults to.** It's the safer default: the
server authenticates users itself instead of trusting a credential handed to it from
upstream. It still belongs behind a reverse proxy that terminates TLS and routes
`PUBLIC_URL` to it — but the container is never the thing deciding to trust an inbound
header.

Simpro's own sign-in is an older OAuth 2.0 design that modern agent connectors won't connect
to directly. This server sits in the middle and **brings it up to the modern OAuth 2.1
standard they require** — adding the security steps Simpro is missing while still handing off
to the real Simpro login. From a user's point of view it's just "click connect, log in to
Simpro." The exact steps it adds are written up in
[How the broker upgrades Simpro's sign-in](#how-the-broker-upgrades-simpros-sign-in) further
down.

The server sits in front of Simpro and runs the sign-in handshake. A user adds the
connector in their agent, gets sent to Simpro to log in, and from then on the agent acts as
that person in Simpro. Their Simpro access is sealed inside the token the agent holds; the
server keeps no database of logins.

This mode needs a public web address and a Simpro OAuth app (created in Simpro under
**Setup → Integrations**). In that OAuth app, set the **Redirect URL** to your public
address followed by `/callback` — for example `https://simpro.yourcompany.com/callback`.

### Settings

Set these as environment variables, on top of `SIMPRO_BASE_URL` (and optionally
`SIMPRO_COMPANY_ID`) from above.

| Setting | Required | What it does |
|---------|----------|--------------|
| `SIMPRO_TRANSPORT` | yes | Set to `broker` to turn on this mode. |
| `PUBLIC_URL` | yes | The public web address people reach the connector at, e.g. `https://simpro.yourcompany.com`. |
| `SIMPRO_CLIENT_ID` | yes | From your Simpro OAuth app. |
| `SIMPRO_CLIENT_SECRET` | yes | From your Simpro OAuth app. Keep it secret. |
| `TOKEN_SEAL_KEY` | recommended | The secret used to seal each person's Simpro access inside their agent token. Generate one with `openssl rand -hex 32`. If you leave it unset the server makes one on first run and saves it to a `.token-seal-key` file — but **that file must survive restarts**, or everyone is signed out. Set it explicitly in production. |
| `SIMPRO_AUTH_URL` | no | Only set if your Simpro login URL is non-standard. Otherwise worked out automatically from `SIMPRO_BASE_URL`. |
| `SIMPRO_TOKEN_URL` | no | Same — only set if non-standard. |

`PORT`, `HOST`, `MCP_PATH`, and the two page-size settings from HTTP Proxy Mode above
apply here too.

---

## Which mode do I want?

| You want to… | Use |
|--------------|-----|
| Use Simpro from Claude Desktop on your own machine | **Install into Claude Desktop** (option 1) |
| Run a shared server where sign-in is handled elsewhere | **HTTP Proxy Mode** (option 2) |
| Offer Simpro as a connector people sign in to individually | **OAuth Broker Mode** (option 3) |

---

## How the broker upgrades Simpro's sign-in

*This section is for the technically curious or anyone reviewing the security of the
connector. You don't need it to use any of the three modes above.*

Modern agent connectors only connect to authorization servers that meet the **OAuth 2.1**
bar. Simpro's OAuth is an older 2.0 implementation — it doesn't do PKCE, doesn't support the
client identity schemes those connectors use, and hands out long-lived tokens. Rather than
ask Simpro to change, the broker stands in front of it as a compliant OAuth 2.1
authorization server in its own right, and quietly relays to Simpro behind the scenes.
Concretely, it adds:

- **PKCE (S256), enforced by us.** The connecting client must send a code challenge on
  `/authorize` and prove it on `/token`; a mismatch is rejected. Simpro itself does no PKCE,
  so the broker is the party actually enforcing it — closing the stolen-authorization-code
  gap that plain 2.0 leaves open.
- **Modern client identity — no shared secret baked into the client.** The connecting client
  tells the broker who it is in one of two standard ways, and the broker accepts whichever a
  given client uses:
  - **CIMD** (client-ID-metadata-document): the client_id is a URL the broker fetches
    and validates per request — it must be self-referential and list the exact redirect
    address being used. Nothing is pre-registered. The fetch runs behind an anti-SSRF guard
    so that URL can't be used to probe the server's internal network.
  - **DCR** (dynamic client registration, RFC 7591): a client can `POST /register` to mint
    its own client_id up front. The broker advertises this endpoint in its metadata.
    Registration is open (no auth), so it's rate-/size-capped and evicts the oldest entries
    at the cap; registered clients are persisted so they survive a restart. A client may
    register as public (no secret) or confidential (the broker issues a secret and then
    requires it at the token step).

  Either way, the downstream client's identity never reaches Simpro: the broker holds one
  fixed Simpro registration and relays under that.
- **Exact redirect matching.** The address the client is sent back to must match the one
  registered, character for character — not just "starts with."
- **Short-lived, audience-bound tokens.** The token the client receives is one the *broker*
  issues, stamped with an expiry and tied to this specific server as its audience. The real
  Simpro tokens are encrypted (sealed) inside it. The broker stores no tokens itself — every
  token is self-contained — and the refresh token it issues has a capped 30-day lifetime so
  a leaked one can't be replayed indefinitely.

The net effect: the agent talks to something that looks like a clean, modern OAuth 2.1
provider, the user still logs in at the genuine Simpro screen, and the weaker parts of
Simpro's flow are shored up in the middle. The whole exchange is correlated in memory only
for the few seconds the handshake takes, which is why this mode must run as a **single
instance** — don't put it behind a load balancer.

---

## Building it yourself

If you're working on the code rather than just using it:

```bash
npm install
npm run build        # compile
npm test             # run the unit tests
npm run build:mcpb   # produce the simpro-mcp-server.mcpb install file
npm start            # run it locally
```

There's a unit-test suite (`npm test`) covering the pure, deterministic pieces — search
ranking, output formatting, line-item paths, and the auth crypto/store helpers. There's no
linter, and nothing mocks the network, so fully checking a change still means building it
and trying it against a real Simpro account. Architecture notes and the Simpro API quirks
worth knowing are in `CLAUDE.md`.
