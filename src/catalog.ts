import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { topLevelRoute } from "./simproClient.js";

export interface Endpoint {
  method: string;
  path: string;
  summary: string;
  tags: string[];
  params: string[];
  /** Full compacted request-body schema (writes only). */
  body?: unknown;
  /** Top-level required body fields with a one-line type/enum hint each (writes only). */
  bodyRequired?: Record<string, string>;
  /** Field name -> type/enum hint for the resource's columns (GET only). */
  columns?: Record<string, string>;
}

let cache: Endpoint[] | null = null;

function locateIndex(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "data", "simpro-api-index.json"),
    join(here, "..", "data", "simpro-api-index.json"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    `Endpoint catalog not found. Looked in: ${candidates.join(", ")}. ` +
      `Expected simpro-api-index.json at data/ (copied to dist/data/ by the build).`,
  );
}

function load(): Endpoint[] {
  if (cache) return cache;
  const raw = JSON.parse(readFileSync(locateIndex(), "utf8")) as { endpoints: Endpoint[] };
  cache = raw.endpoints;
  return cache;
}

// "new" included because every create summary reads "Create a new X" — noise, not a discriminator.
const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "for", "in", "on", "and", "or", "with",
  "my", "me", "i", "please", "how", "do", "new", "from", "all",
]);

/** Tokenize into lowercase whole words, dropping stopwords. */
function terms(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => !STOPWORDS.has(t));
}

// ~290 GET-by-id summaries share "Retrieve details for a specific X"; the boilerplate words
// dilute the exactness signal, so collapse the template to its verb.
function normalizeSummary(summary: string): string {
  return summary.replace(/^Retrieve details for a specific\b/i, "Retrieve");
}

export function searchEndpoints(
  query: string,
  opts: { method?: string; limit?: number } = {},
): Array<Endpoint & { score: number }> {
  const q = terms(query);
  const limit = opts.limit ?? 15;
  const method = opts.method?.toUpperCase();

  const scored = load()
    .filter((e) => !method || e.method === method)
    .map((e) => {
      const pathWords = new Set(terms(e.path));
      const tagWords = new Set(terms(e.tags.join(" ")));
      const summaryWords = terms(normalizeSummary(e.summary));
      const summarySet = new Set(summaryWords);

      let score = 0;
      let matched = 0;
      for (const t of q) {
        let hit = false;
        if (pathWords.has(t)) { score += 3; hit = true; }
        if (tagWords.has(t)) { score += 2; hit = true; }
        if (summarySet.has(t)) { score += 2; hit = true; }
        if (hit) matched++;
      }

      if (q.length > 0 && matched === q.length) score += 4;

      if (summaryWords.length > 0 && summaryWords.every((w) => q.includes(w))) score += 6;

      const depth = (e.path.match(/\{/g) ?? []).length;
      score -= depth * 1.2;

      return { ...e, score };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length);

  return scored.slice(0, limit);
}

// Turn an index path or an agent-supplied path into a comparison key: drop the
// /api/v1.0/companies/{companyID} prefix, the query string and trailing slash, and
// replace every {placeholder} OR concrete numeric id segment with "*". So the index's
// ".../quotes/{quoteID}" and the agent's "quotes/123" both key to "quotes/*".
function pathKey(path: string): string {
  let rel = path.trim();
  const m = rel.match(/\/api\/v1\.0\/companies\/[^/]+\/(.*)$/);
  if (m) rel = m[1];
  const qIdx = rel.indexOf("?");
  if (qIdx >= 0) rel = rel.slice(0, qIdx);
  rel = rel.replace(/^\/+/, "").replace(/\/+$/, "");
  // Key top-level routes under their full spelling so a bare "currentUser" matches
  // the index's "/api/v1.0/currentUser/".
  if (topLevelRoute(rel)) rel = `api/v1.0/${rel}`;
  return rel
    .split("/")
    .map((seg) => (/^\{.+\}$/.test(seg) || /^\d+$/.test(seg) ? "*" : seg))
    .join("/");
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

// Segments match exactly, or as a near-miss spelling (costCentres ~ costCenters, prebuild ~ prebuilds).
function sameSegment(a: string, b: string): boolean {
  return a === b || (Math.min(a.length, b.length) >= 6 && editDistance(a, b) <= 2);
}

function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = sameSegment(a[i - 1], b[j - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** Catalog paths most similar to a route Simpro rejected, for an "Invalid route" error. */
export function closestRoutes(method: string, path: string, limit = 3): string[] {
  const wantMethod = method.toUpperCase();
  const segs = pathKey(path).split("/").filter(Boolean);
  const named = segs.filter((s) => s !== "*").map((s) => s.toLowerCase());
  const last = named[named.length - 1];
  if (!last) return [];
  const wantsItem = segs[segs.length - 1] === "*";

  const scored = new Map<string, number>();
  for (const e of load()) {
    if (e.method !== wantMethod) continue;
    const cand = pathKey(e.path).split("/").filter(Boolean);
    const candNamed = cand.filter((s) => s !== "*").map((s) => s.toLowerCase());
    const shared = lcs(named, candNamed);
    if (shared === 0) continue;
    const score =
      shared * 2 +
      (sameSegment(candNamed[candNamed.length - 1], last) ? 3 : 0) +
      ((cand[cand.length - 1] === "*") === wantsItem ? 1 : 0) -
      (candNamed.length - shared) -
      Math.abs(cand.length - segs.length) * 0.25;
    const shown = e.path.replace(/^\/api\/v1\.0\/companies\/\{companyID\}\//, "");
    if (score > (scored.get(shown) ?? -Infinity)) scored.set(shown, score);
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, limit)
    .map(([p]) => p);
}

/** Look up one endpoint by method + path (templated or concrete) for describe_operation. */
export function getEndpoint(method: string, path: string): Endpoint | undefined {
  const wantMethod = method.toUpperCase();
  const key = pathKey(path);
  return load().find((e) => e.method === wantMethod && pathKey(e.path) === key);
}
