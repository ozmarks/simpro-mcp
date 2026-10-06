import { test } from "node:test";
import assert from "node:assert/strict";
import { SimproError } from "../src/simproClient.js";
import { closestRoutes } from "../src/catalog.js";
import { fail, footgunHint, summarizeBulk } from "../src/tools.js";

test("closestRoutes points a guessed nested sites route at the top-level sites collection", () => {
  assert.equal(closestRoutes("GET", "customers/101/sites/")[0], "sites/");
  assert.equal(closestRoutes("POST", "/api/v1.0/companies/0/customers/101/sites/")[0], "sites/");
});

test("closestRoutes drops a wrong prefix and keeps collection vs item shape", () => {
  assert.equal(closestRoutes("GET", "/setup/materials/prebuildGroups/")[0], "prebuildGroups/");
  assert.equal(closestRoutes("GET", "prebuilds/standardPrice/2001/catalogs/")[0], "prebuilds/{prebuildID}/catalogs/");
});

test("closestRoutes tolerates a near-miss segment spelling", () => {
  assert.equal(
    closestRoutes("GET", "quotes/1001/sections/1/costCenters/2/oneOff/")[0],
    "quotes/{quoteID}/sections/{sectionID}/costCenters/{costCenterID}/oneOffs/",
  );
});

test("closestRoutes returns nothing for a path with no named segments", () => {
  assert.deepEqual(closestRoutes("GET", "123/"), []);
});

const invalidRoute = () =>
  new SimproError("Simpro GET customers/101/sites/ failed: 404 Not Found", 404, { errors: [{ message: "Invalid route." }] });

test("fail adds the closest routes to an Invalid route 404 when it knows the request", () => {
  const text = fail(invalidRoute(), { method: "GET", path: "customers/101/sites/" }).content[0].text;
  assert.match(text, /Closest GET routes: sites\//);
});

test("fail leaves other 404s and context-free calls alone", () => {
  assert.doesNotMatch(fail(invalidRoute()).content[0].text, /Closest/);
  const notFound = new SimproError("Simpro GET quotes/1 failed: 404 Not Found", 404, { errors: [{ message: "Quote not found." }] });
  assert.doesNotMatch(fail(notFound, { method: "GET", path: "quotes/1" }).content[0].text, /Closest/);
});

test("footgunHint names the lock holder and says to close the item in Simpro", () => {
  const hint = footgunHint({ message: "This quote is currently locked by Jane Citizen. Please try again later." });
  assert.ok(hint);
  assert.match(hint, /open in Simpro by Jane Citizen/);
  assert.match(hint, /closed inside Simpro/);
  assert.match(hint, /Don't DELETE/);
});

test("footgunHint matches a lock on any record type", () => {
  assert.ok(footgunHint({ message: "This job is currently locked by John Citizen. Please try again later." }));
  assert.ok(footgunHint({ message: "This cost center is currently locked by John Citizen." }));
});

test("footgunHint explains the set/standard price route split", () => {
  assert.match(footgunHint({ message: "Standard-price prebuild not found." }) ?? "", /_href/);
  assert.match(footgunHint({ message: "Set-price prebuild not found." }) ?? "", /_href/);
});

test("footgunHint explains how to price a standard-price pre-build", () => {
  const sellMode = footgunHint({
    message: "Markup or sell price cannot be set when Material Sell mode is 'Default'. MaterialSale must be None to manually set a markup or sell price.",
  });
  const labour = footgunHint({
    message: "Unable to create a Prebuild Item. Please add a default labour rate or update the rate to more than 0 in Simpro.",
  });
  for (const hint of [sellMode, labour]) {
    assert.match(hint ?? "", /MaterialSale: 'None'/);
    assert.match(hint ?? "", /materials/);
  }
});

test("summarizeBulk counts successes and surfaces failed items with their errors", () => {
  const out = summarizeBulk([
    { status: 204, headers: { "Batch-ID": 0, "Resource-ID": 3001 }, body: null },
    { status: 404, headers: { "Batch-ID": 1 }, body: { errors: [{ message: "Set-price prebuild not found." }] } },
  ]) as { bulk: Record<string, number>; failures: Array<Record<string, unknown>>; results: unknown[] };
  assert.deepEqual(out.bulk, { total: 2, succeeded: 1, failed: 1 });
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].batchId, 1);
  assert.equal(out.failures[0].status, 404);
  assert.match(String(out.failures[0].errors), /Set-price prebuild not found/);
  assert.equal(out.results.length, 2);
});

test("summarizeBulk omits failures when every item succeeded", () => {
  const out = summarizeBulk([{ status: 201, headers: { "Batch-ID": 0, "Resource-ID": 1 }, body: null }]) as Record<string, unknown>;
  assert.deepEqual(out.bulk, { total: 1, succeeded: 1, failed: 0 });
  assert.equal(out.failures, undefined);
});

test("summarizeBulk passes non-bulk bodies through untouched", () => {
  const record = { ID: 5, Name: "x" };
  assert.equal(summarizeBulk(record), record);
  assert.equal(summarizeBulk(undefined), undefined);
  const rows = [{ ID: 1 }, { ID: 2 }];
  assert.equal(summarizeBulk(rows), rows);
});
