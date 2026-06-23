import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function loadDotEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");
  for (const file of [process.env.SIMPRO_ENV_FILE, join(repoRoot, ".env")]) {
    if (!file || !existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}

loadDotEnv();

export interface Config {
  baseUrl: string;
  companyId: string;
  apiKey: string;
  clientId?: string;
  clientSecret?: string;
  tokenUrl: string;
  authUrl: string;
  authMode: "api_key" | "client_credentials" | "authorization_code";
  authRedirectPort: number;
  tokenCacheFile: string;
  defaultPageSize: number;
  maxResultBytes: number;
  version: string;
  versionCheckUrl: string;
  versionCheckEnabled: boolean;
  broker?: BrokerConfig;
}

export interface StaticClient {
  clientSecret: string;
  redirectUris: string[];
}

export interface BrokerConfig {
  publicUrl: string;
  resourceUrl: string;
  simproClientId: string;
  simproClientSecret: string;
  simproAuthUrl: string;
  simproTokenUrl: string;
  sealKey: Buffer;
  staticClients: Map<string, StaticClient>;
  dcrStoreFile: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function decodeSealKey(raw: string): Buffer {
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    // Buffer.from(_,"base64") is lenient; require canonical 32-byte base64 so a passphrase can't masquerade as a key.
    if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
      throw new Error("TOKEN_SEAL_KEY must be 64 hex chars or canonical 32-byte base64 (use `openssl rand -hex 32`).");
    }
    key = Buffer.from(raw, "base64");
  }
  if (key.length !== 32) {
    throw new Error("TOKEN_SEAL_KEY must decode to 32 bytes (64 hex chars or base64).");
  }
  // Reject an all-zero key — an obvious unset/placeholder value.
  if (key.every((b) => b === 0)) {
    throw new Error("TOKEN_SEAL_KEY is all-zero; generate one with `openssl rand -hex 32`.");
  }
  return key;
}

function resolveStateDir(): string {
  if (existsSync("/data")) return "/data";
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

// Single source of truth for the running version: package.json. dist/ sits one level under the
// package root, so ../package.json resolves in both src (tsc-watch) and dist (prod) layouts.
function readPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const DEFAULT_VERSION_CHECK_URL =
  "https://raw.githubusercontent.com/ozmarks/simpro-mcp/main/version.json";

function resolveSealKey(): string {
  const fromEnv = process.env.TOKEN_SEAL_KEY;
  if (fromEnv) return fromEnv;

  const file = join(resolveStateDir(), ".token-seal-key");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();

  const generated = randomBytes(32).toString("hex");
  writeFileSync(file, generated + "\n", { encoding: "utf8", mode: 0o600 });
  console.error(`[config] generated TOKEN_SEAL_KEY and saved to ${file} (mode 0600)`);
  return generated;
}

function resolveDcrStoreFile(): string {
  return join(resolveStateDir(), ".dcr-clients.json");
}

function resolveTokenCacheFile(): string {
  return join(resolveStateDir(), ".simpro-tokens.json");
}

function parseAuthMode(): Config["authMode"] {
  const raw = (process.env.SIMPRO_AUTH_MODE ?? "").trim().toLowerCase();
  if (raw === "authorization_code" || raw === "client_credentials" || raw === "api_key") {
    return raw;
  }
  if (process.env.SIMPRO_CLIENT_ID && process.env.SIMPRO_CLIENT_SECRET) return "client_credentials";
  return "api_key";
}

function loadStaticClients(): Map<string, StaticClient> {
  const raw = process.env.STATIC_CLIENTS;
  const out = new Map<string, StaticClient>();
  if (!raw || !raw.trim()) return out;

  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    throw new Error("STATIC_CLIENTS is not valid JSON.");
  }
  if (!Array.isArray(arr)) throw new Error("STATIC_CLIENTS must be a JSON array.");

  for (const entry of arr) {
    const e = entry as Record<string, unknown>;
    const id = e.client_id;
    const secret = e.client_secret;
    const uris = e.redirect_uris;
    if (typeof id !== "string" || !id) throw new Error("STATIC_CLIENTS entry missing client_id.");
    if (typeof secret !== "string" || !secret) throw new Error(`STATIC_CLIENTS[${id}] missing client_secret.`);
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string" && u)) {
      throw new Error(`STATIC_CLIENTS[${id}] redirect_uris must be a non-empty array of strings.`);
    }
    // A URL client_id would collide with the CIMD path; forbid it.
    if (/^https?:\/\//i.test(id)) throw new Error(`STATIC_CLIENTS[${id}] client_id must not be a URL (reserved for CIMD).`);
    if (out.has(id)) throw new Error(`STATIC_CLIENTS has a duplicate client_id ${id}.`);
    out.set(id, { clientSecret: secret, redirectUris: uris as string[] });
  }
  return out;
}

function loadBrokerConfig(baseUrl: string): BrokerConfig | undefined {
  const publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, "");
  if (!publicUrl) return undefined;
  const mcpPath = (process.env.MCP_PATH ?? "/mcp").replace(/\/+$/, "");
  const resourceUrl = `${publicUrl}${mcpPath.startsWith("/") ? mcpPath : `/${mcpPath}`}`;
  return {
    publicUrl,
    resourceUrl,
    simproClientId: required("SIMPRO_CLIENT_ID"),
    simproClientSecret: required("SIMPRO_CLIENT_SECRET"),
    simproAuthUrl: process.env.SIMPRO_AUTH_URL ?? `${baseUrl}/oauth2/login`,
    simproTokenUrl: process.env.SIMPRO_TOKEN_URL ?? `${baseUrl}/oauth2/token`,
    sealKey: decodeSealKey(resolveSealKey()),
    staticClients: loadStaticClients(),
    dcrStoreFile: resolveDcrStoreFile(),
  };
}

export function loadConfig(): Config {
  const baseUrl = required("SIMPRO_BASE_URL").replace(/\/+$/, "");
  return {
    baseUrl,
    companyId: process.env.SIMPRO_COMPANY_ID ?? "0",
    apiKey: process.env.SIMPRO_API_KEY ?? "",
    clientId: process.env.SIMPRO_CLIENT_ID || undefined,
    clientSecret: process.env.SIMPRO_CLIENT_SECRET || undefined,
    tokenUrl: process.env.SIMPRO_TOKEN_URL ?? `${baseUrl}/oauth2/token`,
    authUrl: process.env.SIMPRO_AUTH_URL ?? `${baseUrl}/oauth2/login`,
    authMode: parseAuthMode(),
    authRedirectPort: intEnv("SIMPRO_AUTH_REDIRECT_PORT", 8237),
    tokenCacheFile: resolveTokenCacheFile(),
    defaultPageSize: intEnv("SIMPRO_DEFAULT_PAGE_SIZE", 50),
    maxResultBytes: intEnv("SIMPRO_MAX_RESULT_BYTES", 100_000),
    version: readPackageVersion(),
    versionCheckUrl: process.env.SIMPRO_VERSION_CHECK_URL || DEFAULT_VERSION_CHECK_URL,
    versionCheckEnabled: (process.env.SIMPRO_VERSION_CHECK ?? "").trim().toLowerCase() !== "off",
    broker: loadBrokerConfig(baseUrl),
  };
}
