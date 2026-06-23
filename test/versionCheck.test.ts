import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, VersionChecker } from "../src/versionCheck.js";
import { formatUpdateNotice, appendUpdateNotice } from "../src/tools.js";

test("compareVersions orders by major, minor, patch", () => {
  assert.ok(compareVersions("0.2.0", "0.1.0") > 0);
  assert.ok(compareVersions("1.0.0", "0.9.9") > 0);
  assert.ok(compareVersions("0.1.1", "0.1.0") > 0);
  assert.ok(compareVersions("0.1.0", "0.1.0") === 0);
  assert.ok(compareVersions("0.1.0", "0.2.0") < 0);
});

test("compareVersions tolerates differing segment counts", () => {
  assert.ok(compareVersions("1.2", "1.2.0") === 0);
  assert.ok(compareVersions("1.2.1", "1.2") > 0);
});

test("compareVersions ignores pre-release / build suffixes", () => {
  assert.ok(compareVersions("1.0.0-rc1", "1.0.0") === 0);
  assert.ok(compareVersions("1.0.0+build5", "1.0.0") === 0);
});

// Swap global fetch for a stub returning a canned version.json.
function withFetch(impl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

const jsonResponse = (body: unknown, ok = true) =>
  ({ ok, text: async () => JSON.stringify(body) }) as unknown as Response;

test("checkOnce reports an update when the remote version is newer", async () => {
  await withFetch(async () => jsonResponse({ version: "0.2.0", url: "https://x", notice: "upgrade soon" }), async () => {
    const c = new VersionChecker("0.1.0", "https://example/version.json");
    const u = await c.checkOnce();
    assert.ok(u);
    assert.equal(u?.latest, "0.2.0");
    assert.equal(u?.current, "0.1.0");
    assert.equal(u?.url, "https://x");
    assert.equal(c.getUpdate()?.latest, "0.2.0");
  });
});

test("checkOnce reports no update when the remote version is equal or older", async () => {
  await withFetch(async () => jsonResponse({ version: "0.1.0" }), async () => {
    const c = new VersionChecker("0.1.0", "https://example/version.json");
    assert.equal(await c.checkOnce(), undefined);
    assert.equal(c.getUpdate(), undefined);
  });
});

test("checkOnce swallows a fetch error and leaves state clean", async () => {
  await withFetch(async () => { throw new Error("network down"); }, async () => {
    const c = new VersionChecker("0.1.0", "https://example/version.json");
    assert.equal(await c.checkOnce(), undefined);
  });
});

test("checkOnce swallows a non-OK response", async () => {
  await withFetch(async () => jsonResponse({ version: "9.9.9" }, false), async () => {
    const c = new VersionChecker("0.1.0", "https://example/version.json");
    assert.equal(await c.checkOnce(), undefined);
  });
});

test("checkOnce swallows malformed JSON", async () => {
  await withFetch(async () => ({ ok: true, text: async () => "not json" }) as unknown as Response, async () => {
    const c = new VersionChecker("0.1.0", "https://example/version.json");
    assert.equal(await c.checkOnce(), undefined);
  });
});

test("formatUpdateNotice includes version, notice and url", () => {
  const s = formatUpdateNotice({ current: "0.1.0", latest: "0.2.0", url: "https://x", notice: "do it" });
  assert.ok(s.includes("0.2.0") && s.includes("0.1.0") && s.includes("do it") && s.includes("https://x"));
});

test("appendUpdateNotice adds one extra content block when an update exists", () => {
  const base = { content: [{ type: "text" as const, text: "payload" }] };
  const out = appendUpdateNotice(base, { current: "0.1.0", latest: "0.2.0" });
  assert.equal(out.content.length, 2);
  assert.equal(out.content[0].text, "payload");
  assert.ok(out.content[1].text.includes("0.2.0"));
});

test("appendUpdateNotice is a no-op when there is no update", () => {
  const base = { content: [{ type: "text" as const, text: "payload" }] };
  assert.equal(appendUpdateNotice(base, undefined), base);
});
