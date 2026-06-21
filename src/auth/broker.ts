import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import type { BrokerConfig } from "../config.js";
import { FlowStore } from "./flowState.js";
import { resolveClient } from "./cimd.js";
import { DcrStore, DcrError } from "./dcrStore.js";
import {
  sealAccess,
  sealRefresh,
  unsealAccess,
  unsealRefresh,
  type AccessTokenClaims,
} from "./seal.js";
import { fetchSimproToken, type SimproTokenResponse } from "./simproToken.js";
import { RateLimiter } from "./rateLimit.js";

function log(line: string): void {
  console.error(`  broker ${line}`);
}

// Per-IP throttles on the unauthenticated endpoints. Generous for real clients
// (registration is once-per-client; /authorize is once-per-login) but enough to
// stop a flood from churning the DCR store / evicting live clients.
function rateLimit(limiter: RateLimiter, name: string) {
  return (req: Request, res: Response, next: () => void): void => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    if (limiter.take(key)) {
      next();
      return;
    }
    log(`${name} rate-limited ${key}`);
    res.setHeader("Retry-After", "1");
    res.status(429).json({ error: "temporarily_unavailable", error_description: "Too many requests; slow down." });
  };
}

async function simproToken(
  cfg: BrokerConfig,
  body: Record<string, string>,
): Promise<SimproTokenResponse> {
  try {
    return await fetchSimproToken(cfg.simproTokenUrl, cfg.simproClientId, cfg.simproClientSecret, body);
  } catch (e) {
    log(`simpro token <-- ${(e as Error).message}`);
    throw e;
  }
}

function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function parseBasicAuth(header: unknown): { clientId: string; clientSecret: string } | undefined {
  if (typeof header !== "string" || !header.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return undefined;
  try {
    // decodeURIComponent throws on malformed %-escapes; treat that as "no usable
    // credentials" rather than letting it bubble to a 500.
    return {
      clientId: decodeURIComponent(decoded.slice(0, i)),
      clientSecret: decodeURIComponent(decoded.slice(i + 1)),
    };
  } catch {
    return undefined;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Timing-safe even when the client is unknown, so response time doesn't leak client_id existence.
function verifyClientSecret(cfg: BrokerConfig, dcr: DcrStore, clientId: string, presented: unknown): boolean {
  const expected = cfg.staticClients.get(clientId)?.clientSecret ?? dcr.get(clientId)?.clientSecret;
  const candidate = typeof presented === "string" ? presented : "";
  if (expected === undefined) {
    safeEqual(candidate, candidate);
    return false;
  }
  return safeEqual(candidate, expected);
}

export interface BrokerVerifyResult {
  simproAccessToken: string;
  expiresAt: number;
}

export function unsealForRequest(cfg: BrokerConfig, token: string): BrokerVerifyResult {
  const claims = unsealAccess(cfg.sealKey, token);
  if (claims.aud !== cfg.resourceUrl) throw new Error("bad audience");
  if (claims.exp < Math.floor(Date.now() / 1000)) throw new Error("expired");
  return { simproAccessToken: claims.simproAccessToken, expiresAt: claims.exp };
}

// Caps replay window for a leaked refresh token — the envelope is stateless (no revocation list).
const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;

function sealPair(cfg: BrokerConfig, t: SimproTokenResponse, clientId?: string) {
  const now = Math.floor(Date.now() / 1000);
  const claims: AccessTokenClaims = { aud: cfg.resourceUrl, exp: now + t.expires_in, simproAccessToken: t.access_token };
  return {
    access_token: sealAccess(cfg.sealKey, claims),
    token_type: "Bearer",
    expires_in: t.expires_in,
    refresh_token: sealRefresh(cfg.sealKey, {
      aud: cfg.resourceUrl,
      exp: now + REFRESH_TTL_SEC,
      simproRefreshToken: t.refresh_token ?? "",
      ...(clientId ? { clientId } : {}),
    }),
  };
}

export function brokerRouter(cfg: BrokerConfig): express.Router {
  const r = express.Router();
  const flows = new FlowStore();
  const dcr = new DcrStore(cfg.dcrStoreFile);
  const u = (p: string) => `${cfg.publicUrl}${p}`;

  // /register persists (whole-file rewrite) and evicts at its cap, so it gets the
  // tighter bucket; /authorize is cheaper but also unauthenticated and evicting.
  const registerLimit = rateLimit(new RateLimiter(1, 10), "/register");
  const authorizeLimit = rateLimit(new RateLimiter(5, 20), "/authorize");

  // Two /.well-known placements: RFC 8414 inserts it mid-path, Claude appends it after. Match both via trailing wildcard.
  const protectedResource = (_req: Request, res: Response) => {
    res.json({ resource: cfg.resourceUrl, authorization_servers: [cfg.publicUrl] });
  };
  r.get("/.well-known/oauth-protected-resource", protectedResource);
  r.get("/.well-known/oauth-protected-resource/*splat", protectedResource);

  const authServerMetadata = () => {
    const authMethods = ["none", "client_secret_post", "client_secret_basic"];
    return {
      issuer: cfg.publicUrl,
      authorization_endpoint: u("/authorize"),
      token_endpoint: u("/token"),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: authMethods,
      client_id_metadata_document_supported: true,
      registration_endpoint: u("/register"),
    };
  };

  const serveAuthServerMetadata = (_req: Request, res: Response) => {
    res.json(authServerMetadata());
  };
  r.get("/.well-known/oauth-authorization-server", serveAuthServerMetadata);
  r.get("/.well-known/oauth-authorization-server/*splat", serveAuthServerMetadata);
  r.get("/.well-known/openid-configuration", serveAuthServerMetadata);
  r.get("/.well-known/openid-configuration/*splat", serveAuthServerMetadata);

  // Own JSON parser: brokerRouter mounts before the app-level express.json().
  r.post("/register", registerLimit, express.json(), (req: Request, res: Response) => {
    try {
      const reg = dcr.register((req.body ?? {}) as Record<string, unknown>);
      log(`/register -> client_id=${reg.client_id} method=${reg.token_endpoint_auth_method} uris=${reg.redirect_uris.length}`);
      return res.status(201).json(reg);
    } catch (e) {
      if (e instanceof DcrError) {
        log(`/register rejected: ${e.code} ${e.message}`);
        return res.status(400).json({ error: e.code, error_description: e.message });
      }
      log(`/register server_error: ${(e as Error).message}`);
      return res.status(500).json({ error: "server_error" });
    }
  });

  r.get("/authorize", authorizeLimit, async (req: Request, res: Response) => {
    const { client_id, code_challenge, code_challenge_method, redirect_uri, state } = req.query as Record<string, string>;
    log(`/authorize client_id=${client_id} redirect_uri=${redirect_uri}`);
    if (code_challenge_method !== "S256" || !code_challenge) return res.status(400).json({ error: "invalid_request", error_description: "S256 PKCE required" });
    if (!client_id || !redirect_uri) return res.status(400).json({ error: "invalid_request", error_description: "client_id and redirect_uri required" });

    const staticClient = cfg.staticClients.get(client_id);
    const dcrClient = staticClient ? undefined : dcr.get(client_id);
    let confidential: boolean;
    if (staticClient) {
      confidential = true;
      if (!staticClient.redirectUris.includes(redirect_uri)) {
        log("/authorize static client redirect_uri not registered");
        return res.status(400).json({ error: "invalid_request", error_description: "redirect_uri not registered for this client" });
      }
    } else if (dcrClient) {
      confidential = dcrClient.tokenEndpointAuthMethod !== "none";
      if (!dcrClient.redirectUris.includes(redirect_uri)) {
        log("/authorize DCR client redirect_uri not registered");
        return res.status(400).json({ error: "invalid_request", error_description: "redirect_uri not registered for this client" });
      }
    } else {
      confidential = false;
      try {
        await resolveClient(client_id, redirect_uri);
      } catch (e) {
        log(`/authorize CIMD rejected: ${(e as Error).message}`);
        return res.status(400).json({ error: "unauthorized_client", error_description: (e as Error).message });
      }
    }

    const handle = flows.startFlow({ clientId: client_id, codeChallenge: code_challenge, claudeState: state, claudeRedirectUri: redirect_uri, confidential });
    const target = new URL(cfg.simproAuthUrl);
    target.searchParams.set("client_id", cfg.simproClientId);
    target.searchParams.set("response_type", "code");
    target.searchParams.set("state", handle);
    log(`/authorize -> Simpro ${target.toString()}`);
    res.redirect(target.toString());
  });

  r.get("/callback", (req: Request, res: Response) => {
    const { code, state, error } = req.query as Record<string, string>;
    log(`/callback code=${code ? "present" : "absent"} state=${state ? "present" : "absent"} error=${error ?? "none"}`);
    const flow = state ? flows.takeFlow(state) : undefined;
    if (!flow) { log("/callback unknown/expired flow"); return res.status(400).send("unknown or expired authorization flow"); }
    if (error || !code) {
      const back = new URL(flow.claudeRedirectUri);
      back.searchParams.set("error", error || "access_denied");
      if (flow.claudeState) back.searchParams.set("state", flow.claudeState);
      return res.redirect(back.toString());
    }
    const brokerCode = flows.issueCode({ clientId: flow.clientId, simproCode: code, codeChallenge: flow.codeChallenge, claudeRedirectUri: flow.claudeRedirectUri, confidential: flow.confidential });
    const back = new URL(flow.claudeRedirectUri);
    back.searchParams.set("code", brokerCode);
    if (flow.claudeState) back.searchParams.set("state", flow.claudeState);
    log(`/callback -> Claude ${flow.claudeRedirectUri} (broker code issued)`);
    res.redirect(back.toString());
  });

  r.post("/token", express.urlencoded({ extended: true }), async (req: Request, res: Response) => {
    const grant = req.body.grant_type as string;
    const basic = parseBasicAuth(req.headers.authorization);
    const presentedClientId = basic?.clientId ?? (req.body.client_id as string | undefined);
    const presentedSecret = basic?.clientSecret ?? req.body.client_secret;
    log(`/token grant=${grant}`);
    try {
      if (grant === "authorization_code") {
        const pending = flows.takeCode(req.body.code as string);
        if (!pending) { log("/token invalid_grant (unknown/expired code)"); return res.status(400).json({ error: "invalid_grant" }); }
        if (presentedClientId !== pending.clientId) { log("/token unauthorized_client (id mismatch)"); return res.status(400).json({ error: "unauthorized_client" }); }
        const redirectUri = req.body.redirect_uri as string | undefined;
        if (!redirectUri || !safeEqual(redirectUri, pending.claudeRedirectUri)) {
          log("/token invalid_grant (redirect_uri mismatch)");
          return res.status(400).json({ error: "invalid_grant" });
        }
        const verifier = req.body.code_verifier as string | undefined;
        if (!verifier || !safeEqual(pkceS256(verifier), pending.codeChallenge)) {
          log("/token invalid_grant (PKCE)");
          return res.status(400).json({ error: "invalid_grant" });
        }
        if (pending.confidential && !verifyClientSecret(cfg, dcr, pending.clientId, presentedSecret)) {
          log("/token invalid_client (bad/missing secret)");
          return res.status(401).json({ error: "invalid_client" });
        }
        const simpro = await simproToken(cfg, { grant_type: "authorization_code", code: pending.simproCode });
        log("/token authorization_code -> sealed pair issued");
        return res.json(sealPair(cfg, simpro, pending.confidential ? pending.clientId : undefined));
      }

      if (grant === "refresh_token") {
        let inner;
        try {
          inner = unsealRefresh(cfg.sealKey, req.body.refresh_token as string);
        } catch {
          log("/token refresh invalid_grant (unseal failed)");
          return res.status(400).json({ error: "invalid_grant" });
        }
        if (inner.aud !== cfg.resourceUrl || inner.exp < Math.floor(Date.now() / 1000)) {
          log("/token refresh invalid_grant (bad aud/exp)");
          return res.status(400).json({ error: "invalid_grant" });
        }
        if (inner.clientId && !verifyClientSecret(cfg, dcr, inner.clientId, presentedSecret)) {
          log("/token refresh invalid_client (bad/missing secret)");
          return res.status(401).json({ error: "invalid_client" });
        }
        const simpro = await simproToken(cfg, { grant_type: "refresh_token", refresh_token: inner.simproRefreshToken });
        log("/token refresh -> rotated sealed pair issued");
        return res.json(sealPair(cfg, simpro, inner.clientId));
      }

      return res.status(400).json({ error: "unsupported_grant_type" });
    } catch (e) {
      log(`/token server_error: ${(e as Error).message}`);
      return res.status(502).json({ error: "server_error" });
    }
  });

  return r;
}
