import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

export type TokenEndpointAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export interface DcrClient {
  clientId: string;
  clientSecret?: string; // confidential clients only (auth method !== "none")
  redirectUris: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  clientName?: string;
  issuedAt: number;
}

export interface DcrRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  token_endpoint_auth_method: TokenEndpointAuthMethod;
  grant_types: string[];
  response_types: string[];
  client_name?: string;
}

export class DcrError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const SUPPORTED_AUTH_METHODS: TokenEndpointAuthMethod[] = ["none", "client_secret_post", "client_secret_basic"];

// /register is open and unauthenticated; cap caps the file an attacker can grow. Evicts oldest at the cap.
const MAX_CLIENTS = 5_000;

function validRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  // WHATWG keeps brackets on IPv6 literals, so the loopback host reads as "[::1]".
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]")) return true;
  return false;
}

export class DcrStore {
  private readonly clients = new Map<string, DcrClient>();

  constructor(private readonly file: string) {
    if (existsSync(file)) this.load();
  }

  private load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (e) {
      throw new Error(`DCR store ${this.file} is unreadable/corrupt: ${(e as Error).message}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`DCR store ${this.file} must be a JSON array.`);
    for (const c of parsed as DcrClient[]) {
      if (c && typeof c.clientId === "string") this.clients.set(c.clientId, c);
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.clients.values()], null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get(clientId: string): DcrClient | undefined {
    return this.clients.get(clientId);
  }

  register(body: Record<string, unknown>): DcrRegistrationResponse {
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string")) {
      throw new DcrError("invalid_redirect_uri", "redirect_uris must be a non-empty array of strings");
    }
    if (!(uris as string[]).every(validRedirectUri)) {
      throw new DcrError("invalid_redirect_uri", "each redirect_uri must be https or http loopback");
    }

    const method = (body.token_endpoint_auth_method as TokenEndpointAuthMethod) ?? "client_secret_post";
    if (!SUPPORTED_AUTH_METHODS.includes(method)) {
      throw new DcrError("invalid_client_metadata", `unsupported token_endpoint_auth_method: ${method}`);
    }

    const clientName = typeof body.client_name === "string" ? body.client_name : undefined;
    const issuedAt = Math.floor(Date.now() / 1000);
    const client: DcrClient = {
      clientId: randomBytes(16).toString("base64url"),
      ...(method === "none" ? {} : { clientSecret: randomBytes(32).toString("base64url") }),
      redirectUris: uris as string[],
      tokenEndpointAuthMethod: method,
      clientName,
      issuedAt,
    };
    while (this.clients.size >= MAX_CLIENTS) {
      const oldest = this.clients.keys().next().value;
      if (oldest === undefined) break;
      this.clients.delete(oldest);
    }
    this.clients.set(client.clientId, client);
    this.persist();

    return {
      client_id: client.clientId,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
      client_id_issued_at: issuedAt,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(clientName ? { client_name: clientName } : {}),
    };
  }
}
