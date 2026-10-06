import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  UploadStore,
  CHUNK_MAX_BYTES,
  sanitizeFilename,
  validateStart,
  type AttachmentClient,
} from "../src/uploads.js";
import { SimproError, type RequestOpts } from "../src/simproClient.js";

const MB = 1024 * 1024;

function pdf(size: number): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) & 0xff;
  b.write("%PDF-1.7", 0, "latin1");
  return b;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function split(b: Buffer): string[] {
  const out: string[] = [];
  for (let o = 0; o < b.length; o += CHUNK_MAX_BYTES) out.push(b.subarray(o, o + CHUNK_MAX_BYTES).toString("base64"));
  return out;
}

class StubClient implements AttachmentClient {
  posts: { path: string; body: { Filename: string; Base64Data: string } }[] = [];
  existing: { ID: string; Filename: string; FileSizeBytes: number }[] = [];
  failures: unknown[] = [];
  async getAllPages(): Promise<unknown[]> {
    return this.existing;
  }
  async requestWithReceipt(_method: string, path: string, opts: RequestOpts = {}) {
    const f = this.failures.shift();
    if (f) throw f;
    const body = opts.body as { Filename: string; Base64Data: string };
    this.posts.push({ path, body });
    return { body: undefined, resourceId: "oAEGOhP1a6KgUxdh" };
  }
}

function newStore(opts: Partial<ConstructorParameters<typeof UploadStore>[0]> = {}) {
  return new UploadStore({ maxUploadBytes: 50 * MB, memoryBytes: 200 * MB, retryDelaysMs: [1, 1], log: () => {}, ...opts });
}

async function settled(store: UploadStore, id: string) {
  for (let i = 0; i < 200; i++) {
    const s = store.status(id);
    if (s.status === "done" || s.status === "failed") return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("upload never settled");
}

function begin(store: UploadStore, file: Buffer, over: Partial<Parameters<UploadStore["start"]>[0]> = {}) {
  const chunks = split(file);
  const { uploadId } = store.start({
    entity: "quote",
    id: 42,
    filename: "Plan [rev B].pdf",
    size: file.length,
    sha256: sha(file),
    chunks: chunks.length,
    ...over,
  });
  return { uploadId, chunks };
}

test("sanitizeFilename strips only the forbidden characters", () => {
  assert.equal(sanitizeFilename('Level 1 (Plan) [rev B]: a/b\\c*?"<>|.pdf'), "Level 1 (Plan) [rev B] abc.pdf");
});

test("validateStart refuses oversize, bad type, bad hash and wrong chunk counts", () => {
  const ok = { filename: "a.pdf", size: 1000, sha256: "a".repeat(64), chunks: 1 };
  assert.equal(validateStart(ok, 50 * MB), "a.pdf");
  assert.throws(() => validateStart({ ...ok, size: 51 * MB, chunks: 90 }, 50 * MB), /limit is/);
  assert.throws(() => validateStart({ ...ok, filename: "setup.exe" }, 50 * MB), /not an allowed file type/);
  assert.throws(() => validateStart({ ...ok, sha256: "xyz" }, 50 * MB), /sha256/);
  assert.throws(() => validateStart({ ...ok, size: 2 * CHUNK_MAX_BYTES, chunks: 1 }, 50 * MB), /chunks must be between 2/);
  assert.throws(() => validateStart({ ...ok, size: 10, chunks: 11 }, 50 * MB), /chunks must be between/);
  assert.equal(validateStart({ ...ok, filename: "photo.HEIC" }, 50 * MB), "photo.HEIC");
});

test("chunks in reverse order plus a resend still post the identical bytes", async () => {
  const store = newStore();
  const client = new StubClient();
  const file = pdf(Math.floor(3.8 * MB));
  const { uploadId, chunks } = begin(store, file);
  assert.equal(chunks.length, 7);
  for (let i = chunks.length - 1; i >= 0; i--) store.putChunk(uploadId, i, chunks[i]);
  assert.deepEqual(store.putChunk(uploadId, 3, chunks[3]), { received: 7, of: 7 });

  assert.equal(store.finish(uploadId, client).status, "working");
  const done = await settled(store, uploadId);
  assert.deepEqual(done, { status: "done", attachmentId: "oAEGOhP1a6KgUxdh" });
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].path, "quotes/42/attachments/files/");
  assert.equal(client.posts[0].body.Filename, "Plan [rev B].pdf");
  assert.ok(Buffer.from(client.posts[0].body.Base64Data, "base64").equals(file));
});

test("putChunk rejects out-of-range indexes, oversize chunks and bad base64", () => {
  const store = newStore();
  const file = pdf(2 * CHUNK_MAX_BYTES);
  const { uploadId } = begin(store, file);
  assert.throws(() => store.putChunk(uploadId, 2, "AAAA"), /out of range/);
  assert.throws(() => store.putChunk(uploadId, -1, "AAAA"), /out of range/);
  assert.throws(() => store.putChunk(uploadId, 0, Buffer.alloc(CHUNK_MAX_BYTES + 1).toString("base64")), /limit is/);
  assert.throws(() => store.putChunk(uploadId, 0, "not base64!"), /valid base64/);
});

test("finish with a missing chunk is refused and names the index", () => {
  const store = newStore();
  const client = new StubClient();
  const file = pdf(3 * CHUNK_MAX_BYTES);
  const { uploadId, chunks } = begin(store, file);
  store.putChunk(uploadId, 0, chunks[0]);
  store.putChunk(uploadId, 2, chunks[2]);
  assert.throws(() => store.finish(uploadId, client), /Missing chunk index\(es\): 1\./);
  assert.equal(store.status(uploadId).status, "collecting");
});

test("a wrong SHA-256 fails and posts nothing", () => {
  const store = newStore();
  const client = new StubClient();
  const file = pdf(1000);
  const { uploadId, chunks } = begin(store, file, { sha256: "0".repeat(64) });
  store.putChunk(uploadId, 0, chunks[0]);
  const r = store.finish(uploadId, client);
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /SHA-256 mismatch.*Nothing was posted/);
  assert.equal(client.posts.length, 0);
});

test("a .pdf that doesn't start with %PDF fails", () => {
  const store = newStore();
  const file = Buffer.from("hello world");
  const { uploadId, chunks } = begin(store, file);
  store.putChunk(uploadId, 0, chunks[0]);
  assert.match(store.finish(uploadId, new StubClient()).error ?? "", /%PDF/);
});

test("finish called twice attaches once", async () => {
  const store = newStore();
  const client = new StubClient();
  const file = pdf(1000);
  const { uploadId, chunks } = begin(store, file);
  store.putChunk(uploadId, 0, chunks[0]);
  store.finish(uploadId, client);
  assert.equal(store.finish(uploadId, client).status, "working");
  await settled(store, uploadId);
  assert.equal(store.finish(uploadId, client).status, "done");
  assert.equal(client.posts.length, 1);
});

test("an existing attachment with the same name and size is reused, not re-posted", async () => {
  const store = newStore();
  const client = new StubClient();
  const file = pdf(1000);
  client.existing = [{ ID: "existing-id", Filename: "Plan [rev B].pdf", FileSizeBytes: 1000 }];
  const { uploadId, chunks } = begin(store, file);
  store.putChunk(uploadId, 0, chunks[0]);
  store.finish(uploadId, client);
  assert.deepEqual(await settled(store, uploadId), { status: "done", attachmentId: "existing-id" });
  assert.equal(client.posts.length, 0);
});

test("a 5xx is retried, then succeeds", async () => {
  const store = newStore();
  const client = new StubClient();
  client.failures = [new SimproError("Simpro POST failed: 503", 503)];
  const file = pdf(1000);
  const { uploadId, chunks } = begin(store, file, { entity: "job" });
  store.putChunk(uploadId, 0, chunks[0]);
  store.finish(uploadId, client);
  assert.equal((await settled(store, uploadId)).status, "done");
  assert.equal(client.posts[0].path, "jobs/42/attachments/files/");
});

test("a 4xx is final and carries Simpro's message", async () => {
  const store = newStore();
  const client = new StubClient();
  client.failures = [
    new SimproError("Simpro POST failed: 422", 422, { errors: [{ path: "/Filename", message: "Invalid file name" }] }),
  ];
  const file = pdf(1000);
  const { uploadId, chunks } = begin(store, file);
  store.putChunk(uploadId, 0, chunks[0]);
  store.finish(uploadId, client);
  const r = await settled(store, uploadId);
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /\/Filename: Invalid file name/);
  assert.equal(client.posts.length, 0);
});

test("unknown and expired uploads say to start again", async () => {
  const store = newStore({ ttlMs: 20 });
  assert.throws(() => store.status("nope"), /expired.*Start again/);
  const { uploadId } = begin(store, pdf(1000));
  await new Promise((r) => setTimeout(r, 40));
  assert.throws(() => store.putChunk(uploadId, 0, "AAAA"), /expired/);
});

test("the memory cap refuses new uploads until space frees up", () => {
  const store = newStore({ memoryBytes: 1500 });
  begin(store, pdf(1000));
  assert.throws(() => begin(store, pdf(1000)), /too many uploads/);
});
