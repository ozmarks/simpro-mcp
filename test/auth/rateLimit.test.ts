import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../../src/auth/rateLimit.js";

test("allows up to the burst, then throttles", () => {
  const rl = new RateLimiter(1, 3);
  const t0 = 1_000_000;
  assert.equal(rl.take("a", t0), true);
  assert.equal(rl.take("a", t0), true);
  assert.equal(rl.take("a", t0), true);
  assert.equal(rl.take("a", t0), false); // burst exhausted
});

test("refills over time at ratePerSec", () => {
  const rl = new RateLimiter(2, 2);
  const t0 = 1_000_000;
  assert.equal(rl.take("a", t0), true);
  assert.equal(rl.take("a", t0), true);
  assert.equal(rl.take("a", t0), false);
  // 1s later -> 2 tokens refilled (capped at burst).
  assert.equal(rl.take("a", t0 + 1000), true);
  assert.equal(rl.take("a", t0 + 1000), true);
  assert.equal(rl.take("a", t0 + 1000), false);
});

test("buckets are independent per key", () => {
  const rl = new RateLimiter(1, 1);
  const t0 = 1_000_000;
  assert.equal(rl.take("a", t0), true);
  assert.equal(rl.take("a", t0), false);
  assert.equal(rl.take("b", t0), true); // separate bucket
});

test("refill is capped at burst (no unbounded accrual)", () => {
  const rl = new RateLimiter(1, 2);
  const t0 = 1_000_000;
  // Idle for a long time, then a key appears: starts at full burst, not more.
  assert.equal(rl.take("a", t0), true);
  assert.equal(rl.take("a", t0 + 100_000), true);
  assert.equal(rl.take("a", t0 + 100_000), true);
  assert.equal(rl.take("a", t0 + 100_000), false);
});

test("LRU eviction at maxKeys targets the idle key, not the recently-used one", () => {
  const rl = new RateLimiter(1, 1, 2);
  const t0 = 1_000_000;
  rl.take("active", t0); // exhaust active's single token
  rl.take("idle", t0); // buckets at cap: [active, idle]
  assert.equal(rl.take("active", t0), false); // touch active -> most-recent, still throttled
  rl.take("new", t0); // cap hit -> evicts LRU ("idle"), not "active"
  assert.equal(rl.take("active", t0), false); // active survived -> bucket intact, still throttled
  assert.equal(rl.take("idle", t0), true); // idle was evicted -> fresh bucket
});
