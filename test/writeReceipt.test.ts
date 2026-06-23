import { test } from "node:test";
import assert from "node:assert/strict";
import { extractResourceId } from "../src/simproClient.js";
import { writeReceipt, footgunHint } from "../src/tools.js";

test("extractResourceId reads a numeric Resource-ID header", () => {
  const h = new Headers({ "Resource-ID": "456" });
  assert.equal(extractResourceId(h), 456);
});

test("extractResourceId falls back to the Location header's trailing id", () => {
  const h = new Headers({ Location: "/api/v1.0/companies/0/jobs/1/sections/2/costCenters/3/catalogs/789" });
  assert.equal(extractResourceId(h), 789);
});

test("extractResourceId strips a query string and trailing slash on Location", () => {
  const h = new Headers({ Location: "/customers/companies/42/?display=all" });
  assert.equal(extractResourceId(h), 42);
});

test("extractResourceId prefers Resource-ID over Location", () => {
  const h = new Headers({ "Resource-ID": "10", Location: "/jobs/99" });
  assert.equal(extractResourceId(h), 10);
});

test("extractResourceId returns undefined when neither header is present", () => {
  assert.equal(extractResourceId(new Headers()), undefined);
});

test("extractResourceId returns a non-numeric id verbatim", () => {
  const h = new Headers({ "Resource-ID": "abc-123" });
  assert.equal(extractResourceId(h), "abc-123");
});

test("writeReceipt synthesizes a success body for a 204 (no body)", () => {
  assert.deepEqual(writeReceipt(undefined, 12), { success: true, resourceId: 12 });
});

test("writeReceipt merges resourceId into an object body without clobbering an existing one", () => {
  assert.deepEqual(writeReceipt({ ID: 5, Name: "x" }, 12), { ID: 5, Name: "x", resourceId: 12 });
  assert.deepEqual(writeReceipt({ resourceId: 7 }, 12), { resourceId: 7 });
});

test("writeReceipt wraps a non-object body alongside the id", () => {
  assert.deepEqual(writeReceipt([1, 2], 12), { resourceId: 12, result: [1, 2] });
});

test("writeReceipt passes the body through when there is no resourceId", () => {
  assert.deepEqual(writeReceipt({ ID: 5 }, undefined), { ID: 5 });
  assert.equal(writeReceipt(undefined, undefined), undefined);
});

test("footgunHint flags a rejected SellPrice write", () => {
  // The live message is "This API Column does not allow POST requests." — match on path, not wording.
  const hint = footgunHint({ path: "/SellPrice/ExTax", message: "This API Column does not allow POST requests.", value: 5 });
  assert.ok(hint && hint.includes("SellPriceExDiscount"));
});

test("footgunHint ignores unrelated errors", () => {
  assert.equal(footgunHint({ path: "/Customer", message: "is required" }), undefined);
});
