import type { RefreshTokenClaims } from "./seal.js";

// Simpro rotates refresh tokens on use: each refresh_token grant burns the presented
// token and returns a new one. The broker's refresh token is a stateless sealed
// envelope, so a client that drops our refresh response keeps an envelope carrying the
// now-burned upstream token — and its next refresh 400s "invalid_grant". This buffer
// holds the *current* upstream refresh token per grant family so a one-step-stale
// envelope can still be netted. It is process-lifetime and single-instance (like
// flowState); a restart only loses refreshes that were in-flight-and-unconfirmed at
// that instant, costing those grants one re-auth.

export interface FamilyEntry {
  gen: number;
  simproRefreshToken: string;
  expiresAt: number;
}

export type RefreshDecision =
  | { kind: "use"; token: string; newGen: number; recovered: boolean }
  | { kind: "reject"; reason: string };

// Pure decision table — no network, no store mutation. Given the family's current
// buffered entry (if any) and the presented envelope's claims, decide which upstream
// refresh token to spend and what generation the resulting pair should carry.
export function decideRefreshToken(
  entry: FamilyEntry | undefined,
  claims: Pick<RefreshTokenClaims, "gen" | "simproRefreshToken">,
): RefreshDecision {
  const G = claims.gen;
  if (!entry) {
    // First refresh of the family: the envelope's own token is the only one that exists.
    return { kind: "use", token: claims.simproRefreshToken, newGen: G + 1, recovered: false };
  }
  const S = entry.gen;
  if (G >= S) {
    // Client has caught up to (or past) what we buffered; its envelope token is live.
    return { kind: "use", token: claims.simproRefreshToken, newGen: G + 1, recovered: false };
  }
  if (G === S - 1) {
    // Client dropped the gen-S response and retried with the prior envelope. Its token
    // is burned, but we still hold gen-S — spend that instead.
    return { kind: "use", token: entry.simproRefreshToken, newGen: S + 1, recovered: true };
  }
  // Jumped back more than one generation — outside the one-deep net by design.
  return { kind: "reject", reason: `stale replay (gen ${G} < buffered ${S} - 1)` };
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class RefreshFamilyStore {
  private readonly m = new Map<string, FamilyEntry>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {
    const t = setInterval(() => this.sweep(), this.ttlMs);
    t.unref();
  }

  // The single write site. Overwriting the family's entry is both "retire the now-
  // confirmed token" and "stash the freshly-minted one" — so the buffer stays depth-1
  // and the stash-new/drop-old step is atomic by construction.
  record(family: string, gen: number, simproRefreshToken: string): void {
    this.m.set(family, { gen, simproRefreshToken, expiresAt: Date.now() + this.ttlMs });
  }

  get(family: string): FamilyEntry | undefined {
    const e = this.m.get(family);
    if (!e) return undefined;
    if (e.expiresAt < Date.now()) {
      this.m.delete(family);
      return undefined;
    }
    return e;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.m) if (e.expiresAt < now) this.m.delete(k);
  }
}
