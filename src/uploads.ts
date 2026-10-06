import { createHash, randomBytes } from "node:crypto";
import { SimproError, type RequestOpts } from "./simproClient.js";

export const CHUNK_MAX_BYTES = 600 * 1024;
export const MAX_CHUNKS = 1000;
export const UPLOAD_TTL_MS = 60 * 60 * 1000;
export const ALLOWED_EXTENSIONS = [".pdf", ".eml", ".msg", ".jpg", ".jpeg", ".png", ".heic"];
const POST_TIMEOUT_MS = 5 * 60 * 1000;
const RETRY_DELAYS_MS = [5_000, 20_000];
// Polling must still see a terminal result for a while, even when delivery ran past the TTL.
const RESULT_GRACE_MS = 10 * 60 * 1000;

export type UploadEntity = "quote" | "job";
export type UploadStatus = "collecting" | "working" | "done" | "failed";

export interface UploadResult {
  status: UploadStatus;
  attachmentId?: string;
  error?: string;
}

export interface StartInput {
  entity: UploadEntity;
  id: number;
  filename: string;
  size: number;
  sha256: string;
  chunks: number;
}

// A refusal whose message is meant for the end user verbatim.
export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

export interface AttachmentClient {
  getAllPages(path: string, query?: Record<string, unknown>, opts?: { pageSize?: number }): Promise<unknown[]>;
  requestWithReceipt(method: string, path: string, opts?: RequestOpts): Promise<{ body: unknown; resourceId?: string | number }>;
}

interface Session extends UploadResult {
  entity: UploadEntity;
  entityId: number;
  filename: string;
  size: number;
  sha256: string;
  parts: (Buffer | undefined)[];
  held: number;
  expiresAt: number;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").trim();
}

export function attachmentsPath(entity: UploadEntity, id: number): string {
  return `${entity === "quote" ? "quotes" : "jobs"}/${id}/attachments/files/`;
}

// Returns the sanitized filename, or throws an UploadError naming the first problem.
export function validateStart(input: Omit<StartInput, "entity" | "id">, maxBytes: number): string {
  const filename = sanitizeFilename(input.filename);
  if (!filename) throw new UploadError("filename is empty once \\ / : * ? \" < > | are removed.");
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new UploadError(`"${filename}" is not an allowed file type. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}.`);
  }
  if (!Number.isInteger(input.size) || input.size < 1) throw new UploadError("size must be a positive whole number of bytes.");
  if (input.size > maxBytes) {
    throw new UploadError(`File is ${input.size} bytes; the limit is ${maxBytes} bytes (${(maxBytes / 1024 / 1024).toFixed(0)} MB).`);
  }
  if (!/^[0-9a-f]{64}$/i.test(input.sha256)) throw new UploadError("sha256 must be the 64-character hex SHA-256 of the whole file.");
  const minChunks = Math.ceil(input.size / CHUNK_MAX_BYTES);
  const maxChunks = Math.min(MAX_CHUNKS, input.size);
  if (!Number.isInteger(input.chunks) || input.chunks < minChunks || input.chunks > maxChunks) {
    throw new UploadError(
      `chunks must be between ${minChunks} and ${maxChunks} for a ${input.size}-byte file (each chunk at most ${CHUNK_MAX_BYTES} bytes decoded).`,
    );
  }
  return filename;
}

export function missingIndexes(parts: (Buffer | undefined)[]): number[] {
  const missing: number[] = [];
  parts.forEach((p, i) => { if (!p) missing.push(i); });
  return missing;
}

export function assemble(
  parts: Buffer[],
  expected: { filename: string; size: number; sha256: string },
): { bytes: Buffer } | { error: string } {
  const bytes = Buffer.concat(parts);
  if (bytes.length !== expected.size) {
    return { error: `Joined file is ${bytes.length} bytes but start declared ${expected.size}.` };
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected.sha256.toLowerCase()) {
    return { error: `SHA-256 mismatch: joined file hashes to ${actual}, start declared ${expected.sha256.toLowerCase()}.` };
  }
  if (expected.filename.toLowerCase().endsWith(".pdf") && bytes.subarray(0, 4).toString("latin1") !== "%PDF") {
    return { error: "File is named .pdf but does not start with %PDF." };
  }
  return { bytes };
}

function decodeChunk(data: string): Buffer {
  const clean = data.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) {
    throw new UploadError("data is not valid base64.");
  }
  return Buffer.from(clean, "base64");
}

function describeError(e: unknown): string {
  if (e instanceof SimproError) {
    const errors = (e.body as { errors?: { path?: string; message?: string }[] } | undefined)?.errors;
    if (errors?.length) return `${e.message}: ${errors.map((x) => `${x.path ?? "(root)"}: ${x.message}`).join("; ")}`;
    return e.body && typeof e.body === "string" ? `${e.message}: ${e.body}` : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

// 5xx, an exhausted 429, a timeout or a dropped connection are worth retrying; any other 4xx is final.
function isRetryable(e: unknown): boolean {
  if (e instanceof SimproError) return e.status !== undefined && (e.status >= 500 || e.status === 429);
  return true;
}

export interface UploadStoreOptions {
  maxUploadBytes: number;
  memoryBytes: number;
  ttlMs?: number;
  retryDelaysMs?: number[];
  log?: (line: string) => void;
}

export class UploadStore {
  private readonly sessions = new Map<string, Session>();
  private reserved = 0;
  private readonly ttlMs: number;
  private readonly retryDelaysMs: number[];
  private readonly log: (line: string) => void;

  constructor(private readonly opts: UploadStoreOptions) {
    this.ttlMs = opts.ttlMs ?? UPLOAD_TTL_MS;
    this.retryDelaysMs = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.log = opts.log ?? ((line) => console.error(`[${new Date().toISOString()}] ${line}`));
    const t = setInterval(() => this.sweep(), Math.min(this.ttlMs, 5 * 60 * 1000));
    t.unref();
  }

  start(input: StartInput): { uploadId: string; chunkSize: number; chunks: number; expiresAt: string } {
    this.sweep();
    const filename = validateStart(input, this.opts.maxUploadBytes);
    if (this.reserved + input.size > this.opts.memoryBytes) {
      throw new UploadError("The server is holding too many uploads right now. Try again in a few minutes.");
    }
    const uploadId = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.ttlMs;
    this.sessions.set(uploadId, {
      status: "collecting",
      entity: input.entity,
      entityId: input.id,
      filename,
      size: input.size,
      sha256: input.sha256,
      parts: new Array(input.chunks).fill(undefined),
      held: 0,
      expiresAt,
    });
    this.reserved += input.size;
    return { uploadId, chunkSize: CHUNK_MAX_BYTES, chunks: input.chunks, expiresAt: new Date(expiresAt).toISOString() };
  }

  putChunk(uploadId: string, index: number, data: string): { received: number; of: number } {
    const s = this.get(uploadId);
    if (s.status !== "collecting") throw new UploadError(`Upload is already ${s.status}; chunks can no longer change.`);
    if (!Number.isInteger(index) || index < 0 || index >= s.parts.length) {
      throw new UploadError(`index ${index} is out of range (0 to ${s.parts.length - 1}).`);
    }
    const buf = decodeChunk(data);
    if (buf.length === 0) throw new UploadError("Chunk is empty.");
    if (buf.length > CHUNK_MAX_BYTES) throw new UploadError(`Chunk is ${buf.length} bytes decoded; the limit is ${CHUNK_MAX_BYTES}.`);
    const held = s.held - (s.parts[index]?.length ?? 0) + buf.length;
    if (held > s.size) throw new UploadError(`Chunks now total more than the declared ${s.size} bytes.`);
    s.parts[index] = buf;
    s.held = held;
    return { received: s.parts.length - missingIndexes(s.parts).length, of: s.parts.length };
  }

  // Idempotent: once past `collecting`, every call just reports the current result, so a repeat
  // never posts twice. The Simpro post runs in the background; poll with status().
  finish(uploadId: string, client: AttachmentClient): UploadResult {
    const s = this.get(uploadId);
    if (s.status !== "collecting") return result(s);
    const missing = missingIndexes(s.parts);
    if (missing.length) {
      const shown = missing.slice(0, 20).join(", ") + (missing.length > 20 ? `, … (${missing.length} total)` : "");
      throw new UploadError(`Missing chunk index(es): ${shown}. Send them, then finish again.`);
    }
    const joined = assemble(s.parts as Buffer[], s);
    if ("error" in joined) {
      this.settle(s, { status: "failed", error: `${joined.error} Nothing was posted to Simpro.` });
      return result(s);
    }
    s.status = "working";
    s.parts = [];
    s.held = 0;
    void this.deliver(client, s, joined.bytes);
    return result(s);
  }

  status(uploadId: string): UploadResult & { received?: number; of?: number } {
    const s = this.get(uploadId);
    if (s.status === "collecting") {
      return { ...result(s), received: s.parts.length - missingIndexes(s.parts).length, of: s.parts.length };
    }
    return result(s);
  }

  private async deliver(client: AttachmentClient, s: Session, bytes: Buffer): Promise<void> {
    const path = attachmentsPath(s.entity, s.entityId);
    for (let attempt = 0; ; attempt++) {
      try {
        // Re-checked before every attempt: a post that timed out may still have landed.
        const existing = await this.findExisting(client, path, s);
        if (existing !== undefined) return this.settle(s, { status: "done", attachmentId: existing });
        const { body, resourceId } = await client.requestWithReceipt("POST", path, {
          body: { Filename: s.filename, Base64Data: bytes.toString("base64") },
          timeoutMs: POST_TIMEOUT_MS,
        });
        const id = resourceId ?? (body as { ID?: string | number } | undefined)?.ID;
        return this.settle(s, { status: "done", attachmentId: id === undefined ? undefined : String(id) });
      } catch (e) {
        if (isRetryable(e) && attempt < this.retryDelaysMs.length) {
          await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt]));
          continue;
        }
        return this.settle(s, { status: "failed", error: describeError(e) });
      }
    }
  }

  private async findExisting(client: AttachmentClient, path: string, s: Session): Promise<string | undefined> {
    const rows = (await client.getAllPages(path, { columns: "ID,Filename,FileSizeBytes" }, { pageSize: 250 })) as {
      ID?: string | number;
      Filename?: string;
      FileSizeBytes?: number;
    }[];
    const hit = rows.find((r) => r.Filename === s.filename && Number(r.FileSizeBytes) === s.size);
    return hit?.ID === undefined ? undefined : String(hit.ID);
  }

  private settle(s: Session, r: UploadResult): void {
    if (s.status === "collecting" || s.status === "working") this.reserved -= s.size;
    s.status = r.status;
    s.attachmentId = r.attachmentId;
    s.error = r.error;
    s.parts = [];
    s.held = 0;
    s.expiresAt = Math.max(s.expiresAt, Date.now() + RESULT_GRACE_MS);
    this.log(
      `upload ${r.status} ${s.entity} ${s.entityId} "${s.filename}" ${s.size} bytes` +
        (r.attachmentId ? ` attachment=${r.attachmentId}` : "") +
        (r.error ? ` error=${r.error}` : ""),
    );
  }

  private get(uploadId: string): Session {
    this.sweep();
    const s = this.sessions.get(uploadId);
    if (!s) throw new UploadError("Upload not found or expired (uploads last 1 hour). Start again with start_attachment_upload.");
    return s;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.expiresAt >= now || s.status === "working") continue;
      if (s.status === "collecting") this.reserved -= s.size;
      this.sessions.delete(id);
    }
  }
}

function result(s: Session): UploadResult {
  return {
    status: s.status,
    ...(s.attachmentId !== undefined ? { attachmentId: s.attachmentId } : {}),
    ...(s.error !== undefined ? { error: s.error } : {}),
  };
}

let shared: UploadStore | undefined;

// Process-wide, like the rate limiter: the HTTP transports rebuild registerTools per request.
export function sharedUploadStore(opts: UploadStoreOptions): UploadStore {
  shared ??= new UploadStore(opts);
  return shared;
}
