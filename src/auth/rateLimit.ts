// In-process per-key token bucket. The broker's /register and /authorize are
// unauthenticated; without a throttle an attacker can flood them to (a) drive
// DcrStore's whole-file rewrite on every registration and (b) FIFO-evict
// legitimate DCR clients / pending flows once the caps are hit. This bounds
// that spam without needing an external rate-limiting gateway.
//
// Single-instance only (state is in-memory) — which matches the broker's
// existing single-instance design (flowState/dcrStore are in-process too).
// Keyed by source IP, which is unspoofable over TCP; behind a reverse proxy
// every request shares the proxy's IP, so the bucket then acts as a global cap
// on the endpoint — still the right defense for the disk-I/O / eviction risk.
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** True if the request is allowed; false if it should be throttled (429). */
  take(key: string, now = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (b) {
      // Move to the end so the LRU eviction below targets idle keys, not active ones.
      this.buckets.delete(key);
    } else {
      // Bound memory: an attacker can't evict their own bucket (one source IP =
      // one key), so eviction only reclaims idle keys under broad distributed load.
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      b = { tokens: this.burst, last: now };
    }

    const elapsed = (now - b.last) / 1000;
    if (elapsed > 0) {
      b.tokens = Math.min(this.burst, b.tokens + elapsed * this.ratePerSec);
      b.last = now;
    }

    const allowed = b.tokens >= 1;
    if (allowed) b.tokens -= 1;
    this.buckets.set(key, b);
    return allowed;
  }
}
