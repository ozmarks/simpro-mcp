import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DcrStore, DcrError } from "../../src/auth/dcrStore.js";

function tempStore(): { store: DcrStore; file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "dcr-"));
  const file = join(dir, "clients.json");
  return { store: new DcrStore(file), file, dir };
}

test("register returns an RFC 7591 body", () => {
  const { store, dir } = tempStore();
  try {
    const res = store.register({ redirect_uris: ["https://app.example/cb"] });
    assert.equal(typeof res.client_id, "string");
    assert.ok(res.client_id.length > 0);
    assert.equal(typeof res.client_id_issued_at, "number");
    assert.deepEqual(res.redirect_uris, ["https://app.example/cb"]);
    assert.deepEqual(res.grant_types, ["authorization_code", "refresh_token"]);
    assert.deepEqual(res.response_types, ["code"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a confidential client (default method) gets a client_secret", () => {
  const { store, dir } = tempStore();
  try {
    const res = store.register({ redirect_uris: ["https://app.example/cb"] });
    assert.equal(res.token_endpoint_auth_method, "client_secret_post");
    assert.equal(typeof res.client_secret, "string");
    assert.ok((res.client_secret as string).length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("client_secret_basic also yields a secret", () => {
  const { store, dir } = tempStore();
  try {
    const res = store.register({
      redirect_uris: ["https://app.example/cb"],
      token_endpoint_auth_method: "client_secret_basic",
    });
    assert.equal(res.token_endpoint_auth_method, "client_secret_basic");
    assert.ok((res.client_secret as string).length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a public client (none) gets no secret", () => {
  const { store, dir } = tempStore();
  try {
    const res = store.register({
      redirect_uris: ["https://app.example/cb"],
      token_endpoint_auth_method: "none",
    });
    assert.equal(res.token_endpoint_auth_method, "none");
    assert.equal("client_secret" in res, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepts https and http loopback redirect URIs", () => {
  const { store, dir } = tempStore();
  try {
    const uris = [
      "https://app.example/cb",
      "http://localhost/cb",
      "http://127.0.0.1/cb",
      "http://[::1]/cb",
    ];
    const res = store.register({ redirect_uris: uris });
    assert.deepEqual(res.redirect_uris, uris);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects http to a public host via DcrError", () => {
  const { store, dir } = tempStore();
  try {
    assert.throws(
      () => store.register({ redirect_uris: ["http://evil.example/cb"] }),
      (err: unknown) => err instanceof DcrError && err.code === "invalid_redirect_uri",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects empty, missing, or non-string redirect_uris", () => {
  const { store, dir } = tempStore();
  try {
    for (const body of [{ redirect_uris: [] }, {}, { redirect_uris: [123] }]) {
      assert.throws(
        () => store.register(body),
        (err: unknown) => err instanceof DcrError && err.code === "invalid_redirect_uri",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects an unsupported auth method", () => {
  const { store, dir } = tempStore();
  try {
    assert.throws(
      () =>
        store.register({
          redirect_uris: ["https://app.example/cb"],
          token_endpoint_auth_method: "private_key_jwt",
        }),
      (err: unknown) => err instanceof DcrError && err.code === "invalid_client_metadata",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a registered client persists across store instances on the same file", () => {
  const { store, file, dir } = tempStore();
  try {
    const res = store.register({ redirect_uris: ["https://app.example/cb"] });
    const reopened = new DcrStore(file);
    const got = reopened.get(res.client_id);
    assert.ok(got);
    assert.equal(got.clientSecret, res.client_secret);
    assert.deepEqual(got.redirectUris, ["https://app.example/cb"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("get returns undefined for an unknown clientId", () => {
  const { store, dir } = tempStore();
  try {
    assert.equal(store.get("nope"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("client_name is preserved when provided and omitted otherwise", () => {
  const { store, dir } = tempStore();
  try {
    const withName = store.register({
      redirect_uris: ["https://app.example/cb"],
      client_name: "My App",
    });
    assert.equal(withName.client_name, "My App");
    const withoutName = store.register({ redirect_uris: ["https://app.example/cb"] });
    assert.equal("client_name" in withoutName, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
