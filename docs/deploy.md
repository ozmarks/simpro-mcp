# Running the server in broker or proxy mode

The README covers setup and every setting. This page covers what you need to know to keep
a hosted instance running.

## The image

`ghcr.io/ozmarks/simpro-mcp` is built from the `Dockerfile` and published on every release
tag, tagged with the version (e.g. `0.4.0`), the short commit SHA, and `latest`. It:

- runs as the non-root `node` user
- contains only production dependencies and the compiled `dist/`
- defaults to `SIMPRO_TRANSPORT=broker` and `PORT=3000`
- has a built-in health check against `/healthz`
- creates `/data`, owned by `node`, for broker state

To build it yourself: `docker build -t simpro-mcp .`

## Broker state

The broker writes two files to its state directory:

| File | Contents | If it's lost |
|------|----------|--------------|
| `.token-seal-key` | The generated seal key, if `TOKEN_SEAL_KEY` isn't set | Every issued token stops working and everyone has to sign in again. |
| `.dcr-clients.json` | Clients registered through `POST /register` | Those clients have to register again. Claude uses CIMD and isn't affected. |

The state directory is `/data` if it exists, otherwise the package root (which, under npx,
is inside npx's cache). There's no setting for the path. In a container, mount a volume on
`/data`, as the bundled `docker-compose.yml` does.

If you set `TOKEN_SEAL_KEY` yourself, the key file isn't used, but you still need the volume
for registered clients.

## Proxy mode container

```yaml
services:
  simpro-mcp:
    image: ghcr.io/ozmarks/simpro-mcp:latest
    restart: unless-stopped
    environment:
      SIMPRO_TRANSPORT: proxy
      SIMPRO_BASE_URL: https://yourbuild.simprosuite.com
      SIMPRO_COMPANY_ID: "0"
    networks:
      - gateway

networks:
  gateway:
    external: true
```

No port is published. The gateway joins the same network and reaches the server at
`http://simpro-mcp:3000/mcp`. The proxy endpoint accepts POST only.

## One instance only

Don't run more than one replica of either mode. The rate limiter for Simpro's limit of 10
requests per second is shared within one process, and the broker keeps sign-in state in
memory. Running more than one instance would need both moved to shared storage such as
Redis, and with Simpro's rate limit there's nothing to gain from scaling out.

## Checking it works

```bash
curl -s http://127.0.0.1:3000/healthz
# ok

# broker: the OAuth metadata should be served
curl -s http://127.0.0.1:3000/.well-known/oauth-protected-resource

# proxy: lists the tools without calling Simpro
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Logs

Everything goes to stderr. On startup the server logs `binding …` and then `listening on …`,
or `failed to start …` if it can't bind. Each request gets one line:
`<remote address> <method> <url> <status> <ms>`. Behind a proxy or gateway, the remote
address is the proxy's, not the end user's.
