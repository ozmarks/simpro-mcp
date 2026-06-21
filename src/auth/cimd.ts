import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export interface ClientMetadata {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
}

const FETCH_TIMEOUT_MS = 5000;
const MAX_DOC_BYTES = 64 * 1024; // a CIMD document is tiny; cap to stop OOM.

function v4Bytes(addr: string): [number, number, number, number] {
  const p = addr.split(".").map(Number);
  return [p[0], p[1], p[2], p[3]];
}

// Embedded IPv4 bytes if addr is an IPv4-mapped/compatible IPv6 (same destination as the bare IPv4), else null.
function mappedV4(addr: string): [number, number, number, number] | null {
  const a = addr.toLowerCase();
  const dotted = a.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return v4Bytes(dotted[1]);
  const hex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  }
  return null;
}

// Expand any (valid) IPv6 literal to its 8 16-bit groups, resolving "::" and a
// trailing dotted-quad. Returns null if it doesn't parse as 8 groups.
function v6Groups(addr: string): number[] | null {
  let a = addr.toLowerCase().split("%")[0]; // drop any zone id
  // Fold a trailing dotted-quad (e.g. ::ffff:1.2.3.4) into two hex groups.
  const lastColon = a.lastIndexOf(":");
  const tail = a.slice(lastColon + 1);
  if (tail.includes(".")) {
    const m = tail.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return null;
    const b = m.slice(1, 5).map(Number);
    if (b.some((x) => x > 255)) return null;
    a = `${a.slice(0, lastColon + 1)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    return head.map((h) => parseInt(h, 16));
  }
  const tailParts = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tailParts.length;
  if (missing < 1) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tailParts].map((h) => parseInt(h, 16));
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

// IPv4 embedded by transition mechanisms whose ultimate destination is that v4:
// 6to4 (2002::/16) and the NAT64 well-known prefix (64:ff9b::/96). Classifying
// the embedded bytes stops a private v4 smuggled through these forms.
function transitionEmbeddedV4(addr: string): [number, number, number, number] | null {
  const g = v6Groups(addr);
  if (!g) return null;
  if (g[0] === 0x2002) return [g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff];
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
  }
  return null;
}

function isPrivateV4(b: [number, number, number, number]): boolean {
  const [a, x, y] = b;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 ||
    (a === 169 && x === 254) || // link-local — incl. 169.254.169.254 cloud metadata
    (a === 172 && x >= 16 && x <= 31) ||
    (a === 192 && x === 168) ||
    (a === 192 && x === 0 && y === 0) || // 192.0.0.0/24 IETF protocol assignments
    (a === 198 && (x === 18 || x === 19)) || // 198.18.0.0/15 benchmarking
    (a === 100 && x >= 64 && x <= 127) || // CGNAT 100.64/10
    a >= 224 // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255 broadcast
  );
}

// Classify by BYTES (after mapped-IPv6 canonicalization), not string form — a mapped literal defeats prefix matching.
export function isPrivateAddr(addr: string): boolean {
  const fam = isIP(addr);
  if (fam === 4) return isPrivateV4(v4Bytes(addr));
  if (fam === 6) {
    const m = mappedV4(addr);
    if (m) return isPrivateV4(m);
    const emb = transitionEmbeddedV4(addr);
    if (emb && isPrivateV4(emb)) return true;
    const a = addr.toLowerCase();
    if (a === "::1" || a === "::") return true;
    if (/^fe[89ab]/.test(a)) return true; // fe80::/10 link-local
    if (a.startsWith("fc") || a.startsWith("fd")) return true; // fc00::/7 ULA
    if (/^fe[cdef]/.test(a)) return true; // fec0::/10 deprecated site-local
    return false;
  }
  return false;
}

// Resolve once and return the validated address so the fetch can pin to it, closing the DNS-rebind TOCTOU.
async function resolvePinnedAddress(u: URL): Promise<{ address: string; family: number }> {
  if (u.protocol !== "https:") throw new Error("client_id must be https");
  const host = u.hostname.replace(/^\[|\]$/g, ""); // URL keeps brackets on v6 literals

  const literalFamily = isIP(host);
  if (literalFamily) {
    if (isPrivateAddr(host)) throw new Error("client_id resolves to a private address");
    return { address: host, family: literalFamily };
  }

  const addrs = await lookup(host, { all: true });
  if (addrs.length === 0) throw new Error("client_id host did not resolve");
  if (addrs.some((a) => isPrivateAddr(a.address))) {
    throw new Error("client_id resolves to a private address");
  }
  return { address: addrs[0].address, family: addrs[0].family };
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

export async function resolveClient(clientId: string, redirectUri: string): Promise<ClientMetadata> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new Error("client_id is not a URL");
  }

  const pinned = await resolvePinnedAddress(url);
  // Pin to the validated address; TLS SNI/cert stays on the hostname (we override only address resolution).
  const pinnedLookup: LookupFunction = (_hostname, opts, cb) => {
    if (isPrivateAddr(pinned.address)) {
      cb(new Error("blocked private address"), "", 0);
      return;
    }
    if (opts && opts.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
    else cb(null, pinned.address, pinned.family);
  };
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup } });

  try {
    const res = await undiciFetch(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      dispatcher,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`client_id document fetch failed: ${res.status}`);
    if (!res.headers.get("content-type")?.includes("application/json")) {
      throw new Error("client_id document is not application/json");
    }

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_DOC_BYTES) {
      throw new Error("client_id document too large");
    }
    const text = await readCapped(res.body as AsyncIterable<Uint8Array> | null, MAX_DOC_BYTES);

    let doc: ClientMetadata;
    try {
      doc = JSON.parse(text) as ClientMetadata;
    } catch {
      throw new Error("client_id document is malformed JSON");
    }

    if (doc.client_id !== clientId) throw new Error("client_id document is not self-referential");
    if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.includes(redirectUri)) {
      throw new Error("redirect_uri not registered in client_id document");
    }
    let redir: URL;
    try {
      redir = new URL(redirectUri);
    } catch {
      throw new Error("redirect_uri is not a URL");
    }
    if (!sameOrigin(redir, url)) throw new Error("redirect_uri must be same-origin with client_id");

    return doc;
  } finally {
    await dispatcher.close().catch(() => {});
  }
}

// Aborts past max bytes, guarding a missing/lying Content-Length.
async function readCapped(body: AsyncIterable<Uint8Array> | null, max: number): Promise<string> {
  if (!body) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > max) throw new Error("client_id document too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
