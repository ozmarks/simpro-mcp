import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sealAccess,
  unsealAccess,
  sealRefresh,
  unsealRefresh,
} from "../../src/auth/seal.js";

const KEY = Buffer.alloc(32, 1);

test("access token round-trips its claims", () => {
  const claims = { aud: "res", exp: 123, simproAccessToken: "tok" };
  assert.deepEqual(unsealAccess(KEY, sealAccess(KEY, claims)), claims);
});

test("refresh token round-trips with and without clientId", () => {
  const withId = { aud: "res", exp: 9, simproRefreshToken: "r", clientId: "c1" };
  const withoutId = { aud: "res", exp: 9, simproRefreshToken: "r" };
  assert.deepEqual(unsealRefresh(KEY, sealRefresh(KEY, withId)), withId);
  assert.deepEqual(unsealRefresh(KEY, sealRefresh(KEY, withoutId)), withoutId);
});

test("tampering with the ciphertext makes unseal throw", () => {
  const token = sealAccess(KEY, { aud: "res", exp: 1, simproAccessToken: "tok" });
  const raw = Buffer.from(token, "base64url");
  raw[raw.length - 1] ^= 0xff; // flip a ciphertext byte (index >= 28)
  assert.throws(() => unsealAccess(KEY, raw.toString("base64url")));
});

test("an access token cannot be unsealed as a refresh token, and vice versa", () => {
  const access = sealAccess(KEY, { aud: "res", exp: 1, simproAccessToken: "tok" });
  const refresh = sealRefresh(KEY, { aud: "res", exp: 1, simproRefreshToken: "r" });
  assert.throws(() => unsealRefresh(KEY, access));
  assert.throws(() => unsealAccess(KEY, refresh));
});

test("a wrong key throws", () => {
  const token = sealAccess(KEY, { aud: "res", exp: 1, simproAccessToken: "tok" });
  assert.throws(() => unsealAccess(Buffer.alloc(32, 2), token));
});

test("a malformed or short token throws", () => {
  assert.throws(() => unsealAccess(KEY, "AAAA"), /malformed token/);
  assert.throws(() => unsealAccess(KEY, "!!!not base64!!!"));
});
