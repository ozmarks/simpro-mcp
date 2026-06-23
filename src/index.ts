import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { loadConfig, type Config, type BrokerConfig } from "./config.js";
import { SimproClient } from "./simproClient.js";
import { registerTools, formatUpdateNotice } from "./tools.js";
import { VersionChecker } from "./versionCheck.js";
import { brokerRouter, unsealForRequest } from "./auth/broker.js";
import { ClientCredentialsProvider } from "./auth/simproToken.js";
import { AuthCodeProvider } from "./auth/authCodeProvider.js";
import type { TokenProvider } from "./simproClient.js";

function log(msg: string): void {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

const REDACTED_QUERY_PARAMS = new Set(["code", "token", "access_token", "refresh_token", "client_secret"]);

function redactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl, "http://localhost");
    let touched = false;
    for (const key of u.searchParams.keys()) {
      if (REDACTED_QUERY_PARAMS.has(key.toLowerCase())) {
        u.searchParams.set(key, "REDACTED");
        touched = true;
      }
    }
    if (!touched) return rawUrl;
    return `${u.pathname}${u.search}`;
  } catch {
    return rawUrl;
  }
}

function accessLog(req: IncomingMessage, res: ServerResponse, startedAt: number): void {
  const ms = Date.now() - startedAt;
  const remote = req.socket.remoteAddress ?? "-";
  log(`${remote} ${req.method ?? "-"} ${redactUrl(req.url ?? "-")} ${res.statusCode} ${ms}ms`);
}

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// DNS-rebinding protection engages only when an allow-list is configured.
function transportOptions(extraHosts: string[] = [], extraOrigins: string[] = []) {
  const allowedHosts = [...new Set([...extraHosts, ...envList("MCP_ALLOWED_HOSTS")])];
  const allowedOrigins = [...new Set([...extraOrigins, ...envList("MCP_ALLOWED_ORIGINS")])];
  const enableDnsRebindingProtection = allowedHosts.length > 0 || allowedOrigins.length > 0;
  return {
    sessionIdGenerator: undefined as undefined,
    enableJsonResponse: true,
    ...(enableDnsRebindingProtection
      ? { enableDnsRebindingProtection, allowedHosts, allowedOrigins }
      : {}),
  };
}

function buildServer(client: SimproClient, cfg: Config, versionChecker?: VersionChecker): McpServer {
  const server = new McpServer({ name: "simpro-mcp-server", version: cfg.version });
  registerTools(server, client, cfg, versionChecker);
  return server;
}

// Start the periodic version check (opt-out via SIMPRO_VERSION_CHECK=off). Returns the checker so
// stdio can surface its result on a tool result; HTTP/broker only log, so they ignore the return.
function startVersionCheck(cfg: Config, surface: "result" | "log"): VersionChecker | undefined {
  if (!cfg.versionCheckEnabled) return undefined;
  const checker = new VersionChecker(cfg.version, cfg.versionCheckUrl);
  let logged = false;
  checker.start(
    surface === "log"
      ? (u) => {
          if (logged) return; // log once per process, not every interval
          logged = true;
          log(`update available — ${formatUpdateNotice(u)}`);
        }
      : undefined,
  );
  return checker;
}

function bearerFrom(req: IncomingMessage): string | undefined {
  const auth = req.headers["authorization"];
  if (!auth) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(auth) ? auth[0] : auth);
  return m ? m[1].trim() : undefined;
}

class BodyTooLargeError extends Error {}

const MAX_REQUEST_BYTES = 1024 * 1024;

async function readBody(req: IncomingMessage, maxBytes = MAX_REQUEST_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > maxBytes) throw new BodyTooLargeError();
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function runStdio(cfg: Config): Promise<void> {
  const provider = buildStdioProvider(cfg);

  if (provider instanceof AuthCodeProvider && !provider.hasCachedAuth()) {
    log("no cached Simpro session — starting authorization_code login.");
    await provider.ensureInteractiveAuth();
  }

  const client = new SimproClient(cfg, undefined, true, provider);
  const versionChecker = startVersionCheck(cfg, "result");
  const server = buildServer(client, cfg, versionChecker);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const authLabel =
    provider instanceof AuthCodeProvider
      ? "oauth authorization_code"
      : provider
        ? "oauth client_credentials"
        : cfg.apiKey
          ? "api key"
          : "none";
  log(`simpro-mcp-server started on stdio (auth: ${authLabel})`);
}

function buildStdioProvider(cfg: Config): TokenProvider | undefined {
  if (cfg.authMode === "api_key") return undefined;
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      `SIMPRO_AUTH_MODE=${cfg.authMode} needs BOTH SIMPRO_CLIENT_ID and SIMPRO_CLIENT_SECRET ` +
        "(or set SIMPRO_AUTH_MODE=api_key to use SIMPRO_API_KEY).",
    );
  }
  if (cfg.apiKey) {
    log(`SIMPRO_CLIENT_ID/SECRET set — using OAuth ${cfg.authMode}; SIMPRO_API_KEY is ignored.`);
  }
  return cfg.authMode === "authorization_code"
    ? new AuthCodeProvider(cfg)
    : new ClientCredentialsProvider(cfg.tokenUrl, cfg.clientId, cfg.clientSecret);
}

async function runHttp(cfg: Config): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  const path = process.env.MCP_PATH ?? "/mcp";

  log(`simpro-mcp-server starting (proxy) — binding ${host}:${port}, mcp path ${path}`);
  startVersionCheck(cfg, "log");

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const startedAt = Date.now();
    res.on("finish", () => accessLog(req, res, startedAt));
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
        return;
      }

      if (url.pathname !== path) {
        res.writeHead(404, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "not found" }));
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" })
          .end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "This stateless server only accepts POST." },
            id: null,
          }));
        return;
      }

      const bearer = bearerFrom(req);
      const client = new SimproClient(cfg, bearer, false);
      const server = buildServer(client, cfg);
      const transport = new StreamableHTTPServerTransport(transportOptions());

      res.on("close", () => {
        transport.close();
        server.close();
      });

      let body: unknown;
      try {
        body = await readBody(req);
      } catch (e) {
        if (e instanceof BodyTooLargeError) {
          res.writeHead(413, { "Content-Type": "application/json" })
            .end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: `Request body exceeds ${MAX_REQUEST_BYTES} bytes.` },
              id: null,
            }));
          return;
        }
        throw e;
      }

      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("HTTP request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" })
          .end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }));
      }
    }
  });

  httpServer.on("error", (err) => {
    log(`simpro-mcp-server failed to start (proxy): ${(err as Error).message}`);
    process.exit(1);
  });

  httpServer.listen(port, host, () => {
    const addr = httpServer.address();
    const bound = typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : `${host}:${port}`;
    log(`simpro-mcp-server started (proxy) — listening on http://${bound}${path} (stateless)`);
  });
}

async function runBrokerHttp(cfg: Config, broker: BrokerConfig): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  const path = process.env.MCP_PATH ?? "/mcp";
  const resourceMetadataUrl = `${broker.publicUrl}/.well-known/oauth-protected-resource`;
  const publicHost = new URL(broker.publicUrl).host;
  const brokerHosts = [...new Set([publicHost, publicHost.split(":")[0], `${publicHost.split(":")[0]}:${port}`])];

  log(`simpro-mcp-server starting (broker) — binding ${host}:${port}, mcp path ${path}, public url ${broker.publicUrl}, resource ${broker.resourceUrl}`);
  startVersionCheck(cfg, "log");

  const app = express();
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on("finish", () => accessLog(req, res, startedAt));
    next();
  });
  app.get("/healthz", (_req, res) => { res.type("text").send("ok"); });
  app.use(brokerRouter(broker));

  app.use(express.json());

  const verifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const { simproAccessToken, expiresAt } = unsealForRequest(broker, token);
      return {
        token,
        clientId: broker.publicUrl,
        scopes: [],
        expiresAt,
        resource: new URL(broker.resourceUrl),
        extra: { simproAccessToken },
      };
    },
  };

  app.post(path, requireBearerAuth({ verifier, resourceMetadataUrl }), async (req: Request, res: Response) => {
    const simproToken = (req.auth?.extra?.simproAccessToken as string) ?? undefined;
    const client = new SimproClient(cfg, simproToken, false);
    const server = buildServer(client, cfg);
    const transport = new StreamableHTTPServerTransport(transportOptions(brokerHosts));
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const httpServer = app.listen(port, host, () => {
    const addr = httpServer.address();
    const bound = typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : `${host}:${port}`;
    log(`simpro-mcp-server started (broker) — listening on http://${bound}${path}`);
  });
  httpServer.on("error", (err) => {
    log(`simpro-mcp-server failed to start (broker): ${(err as Error).message}`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  const transport = (process.env.SIMPRO_TRANSPORT ?? "stdio").toLowerCase();
  switch (transport) {
    case "stdio":
      await runStdio(cfg);
      return;
    case "proxy":
      if (cfg.apiKey) throw new Error(httpKeyGuard);
      await runHttp(cfg);
      return;
    case "broker":
      if (cfg.apiKey) throw new Error(httpKeyGuard);
      if (!cfg.broker) throw new Error(brokerConfigGuard);
      await runBrokerHttp(cfg, cfg.broker);
      return;
    default:
      throw new Error(`Unknown SIMPRO_TRANSPORT "${transport}" (expected stdio|proxy|broker).`);
  }
}

const brokerConfigGuard =
  "SIMPRO_TRANSPORT=broker requires PUBLIC_URL (plus SIMPRO_CLIENT_ID, " +
  "SIMPRO_CLIENT_SECRET, SIMPRO_AUTH_URL, SIMPRO_TOKEN_URL, TOKEN_SEAL_KEY).";

const httpKeyGuard =
  "Refusing to start: SIMPRO_API_KEY is set but the transport is HTTP. " +
  "HTTP requires per-request Authorization: Bearer tokens and must not " +
  "hold a static key. Unset SIMPRO_API_KEY for HTTP, or use stdio.";

main().catch((err) => {
  log(`simpro-mcp-server failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
