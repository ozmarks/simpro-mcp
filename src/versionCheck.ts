// Background "is a newer version published?" check. Fetches a small version.json over HTTPS,
// compares against the running version, and caches the verdict. Fire-and-forget: any failure
// (network, 404, malformed JSON, timeout) is swallowed and leaves the last good state intact —
// it must never affect tool calls. Single-instance, in-memory; a restart re-checks at startup.

const FETCH_TIMEOUT_MS = 5_000;
const MAX_BYTES = 8_192;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1_000; // 6h

export interface UpdateInfo {
  current: string;
  latest: string;
  url?: string;
  notice?: string;
}

interface RemoteVersion {
  version?: unknown;
  url?: unknown;
  notice?: unknown;
}

// Compare two dotted numeric versions (e.g. "0.2.0" vs "0.1.0"). Pre-release/build suffixes are
// ignored (split on the first '-' or '+') — a coarse but safe comparison for "newer is available".
// Returns >0 if a is newer than b, <0 if older, 0 if equal/uncomparable.
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .split(/[-+]/)[0]
      .split(".")
      .map((p) => Number.parseInt(p, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export class VersionChecker {
  private update: UpdateInfo | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastCheckedAt = 0;

  constructor(
    private readonly currentVersion: string,
    private readonly url: string,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {}

  // The detected update, or undefined if up-to-date / not yet checked / check failed.
  getUpdate(): UpdateInfo | undefined {
    return this.update;
  }

  // Kick off an immediate check and schedule periodic refreshes. unref() so the timer never
  // keeps the process alive (stdio especially must exit cleanly). onDetect, if given, fires each
  // time a check transitions to (or stays) "update available" — used by HTTP transports to log.
  start(onDetect?: (u: UpdateInfo) => void): void {
    const run = () =>
      void this.checkOnce().then((u) => {
        if (u && onDetect) onDetect(u);
      });
    run();
    if (this.timer) return;
    this.timer = setInterval(run, this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // One check. Resolves to the UpdateInfo if a newer version is found this round, else undefined.
  // Never throws.
  async checkOnce(): Promise<UpdateInfo | undefined> {
    this.lastCheckedAt = Date.now();
    const remote = await this.fetchRemote();
    if (!remote) return this.update;
    const latest = remote.version;
    if (compareVersions(latest, this.currentVersion) > 0) {
      this.update = {
        current: this.currentVersion,
        latest,
        url: remote.url,
        notice: remote.notice,
      };
    } else {
      this.update = undefined;
    }
    return this.update;
  }

  private async fetchRemote(): Promise<{ version: string; url?: string; notice?: string } | undefined> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(this.url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return undefined;
      const text = (await res.text()).slice(0, MAX_BYTES);
      const parsed = JSON.parse(text) as RemoteVersion;
      const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
      if (!version) return undefined;
      return {
        version,
        url: typeof parsed.url === "string" && parsed.url ? parsed.url : undefined,
        notice: typeof parsed.notice === "string" && parsed.notice ? parsed.notice : undefined,
      };
    } catch {
      return undefined;
    } finally {
      clearTimeout(t);
    }
  }
}
