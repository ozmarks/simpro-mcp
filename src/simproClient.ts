import type { Config } from "./config.js";

export class SimproError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "SimproError";
  }
}

export interface TokenProvider {
  getToken(): Promise<string>;
  invalidate(): void;
}

class RateLimiter {
  private tokens: number;
  private lastRefill = 0;
  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (this.lastRefill === 0) this.lastRefill = now;
      const elapsed = (now - this.lastRefill) / 1000;
      if (elapsed > 0) {
        this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
        this.lastRefill = now;
      }
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.ceil((deficit / this.ratePerSec) * 1000);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

const sharedLimiter = new RateLimiter(8, 8);

export class SimproClient {
  private readonly limiter = sharedLimiter;
  private static readonly MAX_429_RETRIES = 4;

  constructor(
    private readonly cfg: Config,
    private readonly requestBearer?: string,
    private readonly allowApiKeyFallback = false,
    private readonly tokenProvider?: TokenProvider,
  ) {}

  // Precedence: explicit per-call bearer → constructor bearer → OAuth provider → legacy api key.
  private async ensureToken(bearer?: string): Promise<string> {
    const explicit = bearer ?? this.requestBearer;
    if (explicit) return explicit;
    if (this.tokenProvider) return this.tokenProvider.getToken();
    if (this.allowApiKeyFallback && this.cfg.apiKey) return this.cfg.apiKey;
    throw new SimproError(
      this.allowApiKeyFallback
        ? "No Simpro credential available: set SIMPRO_CLIENT_ID/SIMPRO_CLIENT_SECRET (OAuth) or SIMPRO_API_KEY (stdio transport)."
        : "Unauthorized: this request carried no Authorization: Bearer token.",
      this.allowApiKeyFallback ? undefined : 401,
    );
  }

  private url(path: string, query?: Record<string, unknown>): string {
    const clean = path.replace(/^\/+/, "");
    const u = new URL(
      `${this.cfg.baseUrl}/api/v1.0/companies/${this.cfg.companyId}/${clean}`,
    );
    // Pin to the company prefix so "../" segments can't escape the company scope.
    const allowed = new URL(
      `${this.cfg.baseUrl}/api/v1.0/companies/${this.cfg.companyId}/`,
    );
    if (u.origin !== allowed.origin || !u.pathname.startsWith(allowed.pathname)) {
      throw new SimproError(
        `Invalid path "${path}": resolves outside the company API scope (${allowed.pathname}).`,
        400,
      );
    }
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === "") continue;
        u.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
      }
    }
    return u.toString();
  }

  private async requestRaw(
    method: string,
    path: string,
    opts: {
      query?: Record<string, unknown>;
      body?: unknown;
      bearer?: string;
      mergeMode?: boolean;
    } = {},
  ): Promise<{ body: unknown; headers: Headers }> {
    // Resolve the token before the limiter so an OAuth fetch doesn't hold a bucket token.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.ensureToken(opts.bearer)}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (opts.mergeMode) headers["Post-Mode"] = "merge";
    const url = this.url(path, opts.query);

    let attempt = 0;
    let tokenRetried = false;
    for (;;) {
      await this.limiter.acquire();

      const res = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });

      // 401 with an OAuth provider: invalidate, re-fetch once, retry.
      if (res.status === 401 && this.tokenProvider && !tokenRetried) {
        tokenRetried = true;
        this.tokenProvider.invalidate();
        headers.Authorization = `Bearer ${await this.ensureToken(opts.bearer)}`;
        continue;
      }

      // 429: respect Retry-After if Simpro ever sends it, else backoff with jitter.
      if (res.status === 429 && attempt < SimproClient.MAX_429_RETRIES) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(4000, 250 * 2 ** attempt) + Math.floor(Math.random() * 200);
        attempt++;
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      const text = await res.text();
      let parsed: unknown = undefined;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (!res.ok) {
        throw new SimproError(
          `Simpro ${method} ${path} failed: ${res.status} ${res.statusText}`,
          res.status,
          parsed,
        );
      }
      return { body: parsed, headers: res.headers };
    }
  }

  async request(
    method: string,
    path: string,
    opts: {
      query?: Record<string, unknown>;
      body?: unknown;
      bearer?: string;
      mergeMode?: boolean;
    } = {},
  ): Promise<unknown> {
    const { body } = await this.requestRaw(method, path, opts);
    return body;
  }

  get(path: string, query?: Record<string, unknown>, bearer?: string) {
    return this.request("GET", path, { query, bearer });
  }
  post(path: string, body: unknown, opts: { mergeMode?: boolean; bearer?: string } = {}) {
    return this.request("POST", path, { body, mergeMode: opts.mergeMode, bearer: opts.bearer });
  }
  put(path: string, body: unknown, bearer?: string) {
    return this.request("PUT", path, { body, bearer });
  }
  patch(path: string, body: unknown, bearer?: string) {
    return this.request("PATCH", path, { body, bearer });
  }
  delete(path: string, bearer?: string) {
    return this.request("DELETE", path, { bearer });
  }

  // One page plus Simpro's paging headers (Result-Pages / Result-Total), so a tool can offer the next `page`.
  async getList(
    path: string,
    query: Record<string, unknown> = {},
    bearer?: string,
  ): Promise<{ rows: unknown[]; pagination: { page: number; pageSize?: number; totalPages: number; totalRows: number } }> {
    const { body, headers } = await this.requestRaw("GET", path, { query, bearer });
    const rows = Array.isArray(body) ? body : [];
    const page = Number(query.page) || 1;
    const pageSize = query.pageSize === undefined ? undefined : Number(query.pageSize);
    return {
      rows,
      pagination: {
        page,
        pageSize,
        totalPages: Number(headers.get("Result-Pages")) || 1,
        totalRows: Number(headers.get("Result-Total")) || rows.length,
      },
    };
  }

  // Every page concatenated, bounded by maxPages against huge collections.
  async getAllPages(
    path: string,
    query: Record<string, unknown> = {},
    opts: { pageSize?: number; maxPages?: number; bearer?: string } = {},
  ): Promise<unknown[]> {
    const pageSize = opts.pageSize ?? 250;
    const maxPages = opts.maxPages ?? 20;
    const first = await this.requestRaw("GET", path, {
      query: { ...query, pageSize, page: 1 },
      bearer: opts.bearer,
    });
    const rows: unknown[] = Array.isArray(first.body) ? [...first.body] : [];
    const totalPages = Number(first.headers.get("Result-Pages")) || 1;
    const pages = Math.min(totalPages, maxPages);
    for (let p = 2; p <= pages; p++) {
      const next = await this.request("GET", path, {
        query: { ...query, pageSize, page: p },
        bearer: opts.bearer,
      });
      if (Array.isArray(next)) rows.push(...next);
    }
    return rows;
  }
}
