import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;

export interface AccessTokenClaims {
  aud: string;
  exp: number;
  simproAccessToken: string;
}

export interface RefreshTokenClaims {
  aud: string;
  exp: number;
  simproRefreshToken: string;
  /** client_id when issued to a confidential static client; absent for CIMD. */
  clientId?: string;
}

// envelope = base64url( iv(12) | tag(16) | ciphertext ). The tag is bound to a
// one-char domain prefix so an access token can't be replayed as a refresh token.
function seal(key: Buffer, domain: "a" | "r", claims: unknown): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(domain));
  const pt = Buffer.from(JSON.stringify(claims), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64url");
}

function unseal<T>(key: Buffer, domain: "a" | "r", token: string): T {
  const raw = Buffer.from(token, "base64url");
  if (raw.length < IV_LEN + TAG_LEN) throw new Error("malformed token");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(domain));
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}

export const sealAccess = (key: Buffer, c: AccessTokenClaims) => seal(key, "a", c);
export const sealRefresh = (key: Buffer, c: RefreshTokenClaims) => seal(key, "r", c);
export const unsealAccess = (key: Buffer, t: string) => unseal<AccessTokenClaims>(key, "a", t);
export const unsealRefresh = (key: Buffer, t: string) => unseal<RefreshTokenClaims>(key, "r", t);
