import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import type { Config } from "../config.js";
import { SimproError, type TokenProvider } from "../simproClient.js";
import { fetchSimproToken } from "./simproToken.js";
import { runLocalhostAuthFlow } from "./authCodeFlow.js";

function log(line: string): void {
  console.error(`  oauth ${line}`);
}

interface TokenCache {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
}

export class AuthCodeProvider implements TokenProvider {
  private static readonly SKEW_MS = 60_000;
  private static readonly DEFAULT_TTL_MS = 3_600_000;

  private cache?: TokenCache;
  private inFlight?: Promise<string>;

  constructor(private readonly cfg: Config) {
    this.cache = this.loadCache();
  }

  hasCachedAuth(): boolean {
    return !!this.cache?.refreshToken;
  }

  async getToken(): Promise<string> {
    const c = this.cache;
    if (c?.accessToken && c.expiresAt && Date.now() < c.expiresAt - AuthCodeProvider.SKEW_MS) {
      return c.accessToken;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.acquire();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  invalidate(): void {
    if (this.cache) this.cache = { ...this.cache, accessToken: undefined, expiresAt: undefined };
  }

  async ensureInteractiveAuth(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    this.inFlight = this.interactiveAuth();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async acquire(): Promise<string> {
    if (this.cache?.refreshToken) {
      try {
        return await this.refresh(this.cache.refreshToken);
      } catch (e) {
        const status = e instanceof SimproError ? e.status : undefined;
        if (status === 400 || status === 401) {
          log(`refresh token rejected (${status}); re-authorising interactively.`);
          return this.interactiveAuth();
        }
        throw e;
      }
    }
    return this.interactiveAuth();
  }

  private async refresh(refreshToken: string): Promise<string> {
    const t = await fetchSimproToken(this.cfg.tokenUrl, this.cfg.clientId!, this.cfg.clientSecret!, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    return this.store(t.access_token, t.expires_in, t.refresh_token ?? refreshToken);
  }

  private async interactiveAuth(): Promise<string> {
    const t = await runLocalhostAuthFlow(this.cfg);
    if (!t.refresh_token) {
      throw new Error(
        "Simpro returned no refresh_token for the authorization_code grant — cannot persist a durable session.",
      );
    }
    log(`authorised; refresh token cached to ${this.cfg.tokenCacheFile}`);
    return this.store(t.access_token, t.expires_in, t.refresh_token);
  }

  private store(accessToken: string, expiresIn: number, refreshToken: string): string {
    const ttlMs =
      Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : AuthCodeProvider.DEFAULT_TTL_MS;
    this.cache = { refreshToken, accessToken, expiresAt: Date.now() + ttlMs };
    this.persist(this.cache);
    return accessToken;
  }

  private loadCache(): TokenCache | undefined {
    if (!existsSync(this.cfg.tokenCacheFile)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.cfg.tokenCacheFile, "utf8")) as TokenCache;
      if (parsed && typeof parsed.refreshToken === "string" && parsed.refreshToken) return parsed;
    } catch (e) {
      log(`ignoring unreadable token cache ${this.cfg.tokenCacheFile}: ${(e as Error).message}`);
    }
    return undefined;
  }

  private persist(cache: TokenCache): void {
    const tmp = `${this.cfg.tokenCacheFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.cfg.tokenCacheFile);
  }
}
