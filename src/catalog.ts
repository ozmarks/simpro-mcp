import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  return rel
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .map((seg) => (/^\{.+\}$/.test(seg) || /^\d+$/.test(seg) ? "*" : seg))
    .join("/");
}

/** Look up one endpoint by method + path (templated or concrete) for describe_operation. */
export function getEndpoint(method: string, path: string): Endpoint | undefined {
  const wantMethod = method.toUpperCase();
  const key = pathKey(path);
  return load().find((e) => e.method === wantMethod && pathKey(e.path) === key);
}
