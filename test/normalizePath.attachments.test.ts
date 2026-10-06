import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePath } from "../src/tools.js";

test("normalizePath treats a string attachment file ID as an item route", () => {
  assert.equal(
    normalizePath("/api/v1.0/companies/0/quotes/5451/attachments/files/LlQpLXD2BbIwBxV33GCiqmMxyzOk2ysymmDereThQ-E/"),
    "quotes/5451/attachments/files/LlQpLXD2BbIwBxV33GCiqmMxyzOk2ysymmDereThQ-E",
  );
  assert.equal(normalizePath("jobs/3791/attachments/files"), "jobs/3791/attachments/files/");
  assert.equal(normalizePath("jobs/3791/attachments/files/abc?display=Base64"), "jobs/3791/attachments/files/abc?display=Base64");
});
