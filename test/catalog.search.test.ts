import { test } from "node:test";
import assert from "node:assert/strict";
import { searchEndpoints, getEndpoint } from "../src/catalog.js";

/**
 * Ranking tests for `find_operation`'s endpoint search.
 *
 * Each case is a real-world phrasing paired with the path the model SHOULD land
 * on, and the worst acceptable rank. The motivating bug: "delete a quote"
 * returned the right endpoint at ~rank 60 — past find_operation's default
 * limit of 15 — so the model never saw it. These pin the fix in place.
 *
 * `topRank: 1` means it must be the first result; a larger number tolerates a
 * few near-synonym neighbours ahead of it where the phrasing is genuinely
 * ambiguous.
 */
const CASES: Array<{ query: string; method?: string; path: string; topRank: number }> = [
  // The original failure.
  { query: "delete a quote", method: "DELETE", path: "/api/v1.0/companies/{companyID}/quotes/{quoteID}", topRank: 1 },
  // Collection-create routes (trailing slash, no {id}) must beat their children.
  { query: "create a job", method: "POST", path: "/api/v1.0/companies/{companyID}/jobs/", topRank: 1 },
  { query: "create a quote", method: "POST", path: "/api/v1.0/companies/{companyID}/quotes/", topRank: 1 },
  // Nested-but-exact: the deep route is correct here and its summary is exact.
  { query: "update a customer contact", method: "PATCH", path: "/api/v1.0/companies/{companyID}/customers/{customerID}/contacts/{contactID}", topRank: 1 },
  // List/collection reads.
  { query: "list all customers", method: "GET", path: "/api/v1.0/companies/{companyID}/customers/", topRank: 1 },
  { query: "delete a job", method: "DELETE", path: "/api/v1.0/companies/{companyID}/jobs/{jobID}", topRank: 1 },
  { query: "retrieve a quote", method: "GET", path: "/api/v1.0/companies/{companyID}/quotes/{quoteID}", topRank: 1 },
];

for (const c of CASES) {
  test(`"${c.query}" ranks ${c.path} within top ${c.topRank}`, () => {
    const results = searchEndpoints(c.query, { method: c.method, limit: 40 });
    const rank = results.findIndex((e) => e.path === c.path && (!c.method || e.method === c.method)) + 1;
    assert.ok(
      rank >= 1 && rank <= c.topRank,
      `expected ${c.method ?? ""} ${c.path} within top ${c.topRank}, got rank ${rank || "not found"}.\n` +
        `Top 5 were:\n` +
        results.slice(0, 5).map((e, i) => `  ${i + 1}. [${e.score.toFixed(1)}] ${e.method} ${e.path}`).join("\n"),
    );
  });
}

test("stopword-only query returns nothing rather than everything", () => {
  const results = searchEndpoints("a the to for", {});
  assert.equal(results.length, 0);
});

// getEndpoint backs describe_operation: it must match the index's templated paths
// against both templated and concrete (id-filled, prefix-stripped) agent paths.
test("getEndpoint matches a templated path and exposes the body schema", () => {
  const ep = getEndpoint("POST", "/api/v1.0/companies/{companyID}/quotes/");
  assert.ok(ep, "POST quotes/ should be found");
  assert.deepEqual(ep!.bodyRequired && Object.keys(ep!.bodyRequired).sort(), ["Customer", "Site", "Type"]);
});

test("getEndpoint matches a concrete id-filled path with the companyID prefix stripped", () => {
  const ep = getEndpoint("GET", "quotes/123");
  assert.ok(ep, "GET quotes/123 should map to quotes/{quoteID}");
  assert.equal(ep!.path, "/api/v1.0/companies/{companyID}/quotes/{quoteID}");
  assert.ok(ep!.columns && Object.keys(ep!.columns).length > 10, "should carry the full column list");
});

test("getEndpoint is method-specific", () => {
  const get = getEndpoint("GET", "quotes/9");
  const del = getEndpoint("DELETE", "quotes/9");
  assert.ok(get && del);
  assert.equal(get!.method, "GET");
  assert.equal(del!.method, "DELETE");
});

test("getEndpoint returns undefined for an unknown path", () => {
  assert.equal(getEndpoint("GET", "this/is/not/a/route"), undefined);
});
