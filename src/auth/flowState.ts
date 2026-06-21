import { randomBytes } from "node:crypto";

export interface AuthorizeFlow {
  clientId: string;
  codeChallenge: string;
  claudeState?: string;
  claudeRedirectUri: string;
  confidential: boolean;
}

export interface PendingCode {
  clientId: string;
  simproCode: string;
  codeChallenge: string;
  claudeRedirectUri: string;
  confidential: boolean;
}

const TTL_MS = 5 * 60 * 1000;
// /authorize is unauthenticated; cap bounds entries an attacker can spam. Evicts oldest at the cap.
const MAX_ENTRIES = 10_000;

class TtlMap<V> {
  private readonly m = new Map<string, { v: V; exp: number }>();
  set(k: string, v: V): void {
    if (this.m.size >= MAX_ENTRIES) {
      const oldest = this.m.keys().next().value;
      if (oldest !== undefined) this.m.delete(oldest);
    }
    this.m.set(k, { v, exp: Date.now() + TTL_MS });
  }
  take(k: string): V | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    this.m.delete(k);
    if (e.exp < Date.now()) return undefined;
    return e.v;
  }
  sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.m) if (e.exp < now) this.m.delete(k);
  }
}

export class FlowStore {
  private readonly flows = new TtlMap<AuthorizeFlow>();
  private readonly codes = new TtlMap<PendingCode>();

  constructor() {
    // Reclaims expired entries even with no take() traffic to trigger a sweep.
    const t = setInterval(() => { this.flows.sweep(); this.codes.sweep(); }, TTL_MS);
    t.unref();
  }

  startFlow(flow: AuthorizeFlow): string {
    const handle = randomBytes(16).toString("base64url");
    this.flows.set(handle, flow);
    return handle;
  }
  takeFlow(handle: string): AuthorizeFlow | undefined {
    this.flows.sweep();
    return this.flows.take(handle);
  }
  issueCode(code: PendingCode): string {
    const brokerCode = randomBytes(32).toString("base64url");
    this.codes.set(brokerCode, code);
    return brokerCode;
  }
  takeCode(brokerCode: string): PendingCode | undefined {
    this.codes.sweep();
    return this.codes.take(brokerCode);
  }
}
