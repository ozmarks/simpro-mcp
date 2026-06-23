import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RefreshFamilyStore,
  decideRefreshToken,
  type FamilyEntry,
} from "../../src/auth/refreshFamilies.js";

const claims = (gen: number, token: string) => ({ gen, simproRefreshToken: token });

test("first refresh of a family uses the envelope's own token", () => {
  const d = decideRefreshToken(undefined, claims(0, "R0"));
  assert.deepEqual(d, { kind: "use", token: "R0", newGen: 1, recovered: false });
});

test("caught-up client (gen == buffered) uses its own live token", () => {
  const entry: FamilyEntry = { gen: 2, simproRefreshToken: "R2", expiresAt: Date.now() + 1000 };
  const d = decideRefreshToken(entry, claims(2, "R2"));
  assert.deepEqual(d, { kind: "use", token: "R2", newGen: 3, recovered: false });
});

test("dropped-response retry (gen == buffered-1) is netted via the buffered token", () => {
  // Client refreshed to gen 2 but dropped the response, retries with the gen-1 envelope.
  const entry: FamilyEntry = { gen: 2, simproRefreshToken: "R2", expiresAt: Date.now() + 1000 };
  const d = decideRefreshToken(entry, claims(1, "R1_burned"));
  assert.deepEqual(d, { kind: "use", token: "R2", newGen: 3, recovered: true });
});

test("too-old replay (gen < buffered-1) is rejected", () => {
  const entry: FamilyEntry = { gen: 3, simproRefreshToken: "R3", expiresAt: Date.now() + 1000 };
  const d = decideRefreshToken(entry, claims(1, "R1"));
  assert.equal(d.kind, "reject");
});

test("gen ahead of buffer (shouldn't normally happen) still uses the envelope token", () => {
  const entry: FamilyEntry = { gen: 1, simproRefreshToken: "R1", expiresAt: Date.now() + 1000 };
  const d = decideRefreshToken(entry, claims(2, "R2"));
  assert.deepEqual(d, { kind: "use", token: "R2", newGen: 3, recovered: false });
});

test("store record/get round-trips and stays depth-1 per family", () => {
  const s = new RefreshFamilyStore();
  s.record("fam", 1, "R1");
  assert.equal(s.get("fam")?.simproRefreshToken, "R1");
  s.record("fam", 2, "R2");
  const e = s.get("fam");
  assert.equal(e?.gen, 2);
  assert.equal(e?.simproRefreshToken, "R2");
});

test("expired entries are not returned", () => {
  const s = new RefreshFamilyStore(-1); // every entry is born already expired
  s.record("fam", 1, "R1");
  assert.equal(s.get("fam"), undefined);
});

test("the dropped-response scenario end-to-end against the buffer", () => {
  const s = new RefreshFamilyStore();
  // gen-0 issue
  s.record("fam", 0, "R0");
  // client refreshes with gen-0 envelope: caught up, spends R0, we mint+stash gen-1 R1
  let d = decideRefreshToken(s.get("fam"), claims(0, "R0"));
  assert.deepEqual(d, { kind: "use", token: "R0", newGen: 1, recovered: false });
  s.record("fam", 1, "R1");
  // client DROPS that response, retries with the gen-0 envelope again
  d = decideRefreshToken(s.get("fam"), claims(0, "R0_burned"));
  assert.deepEqual(d, { kind: "use", token: "R1", newGen: 2, recovered: true });
});
