import { SimproError, type TokenProvider } from "../simproClient.js";

// refresh_token is optional: the client_credentials grant does not return one.
export interface SimproTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  refresh_token?: string;
}

export async function fetchSimproToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  body: Record<string, string>,
): Promise<SimproTokenResponse> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, client_id: clientId, client_secret: clientSecret, state: "" }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new SimproError(`Simpro token endpoint: ${res.status}`, res.status, text);
  }
  return (await res.json()) as SimproTokenResponse;
}

export class ClientCredentialsProvider implements TokenProvider {
  private static readonly SKEW_MS = 60_000;
  private static readonly DEFAULT_TTL_MS = 3_600_000; // fallback if Simpro omits/garbles expires_in

  private cachedToken?: string;
  private expiresAt = 0;
  private inFlight?: Promise<string>;

  constructor(
    private readonly tokenUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  async getToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.expiresAt - ClientCredentialsProvider.SKEW_MS) {
      return this.cachedToken;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  invalidate(): void {
    this.cachedToken = undefined;
    this.expiresAt = 0;
  }

  private async refresh(): Promise<string> {
    const t = await fetchSimproToken(this.tokenUrl, this.clientId, this.clientSecret, {
      grant_type: "client_credentials",
    });
    const ttlMs =
      Number.isFinite(t.expires_in) && t.expires_in > 0
        ? t.expires_in * 1000
        : ClientCredentialsProvider.DEFAULT_TTL_MS;
    this.cachedToken = t.access_token;
    this.expiresAt = Date.now() + ttlMs;
    return t.access_token;
  }
}
