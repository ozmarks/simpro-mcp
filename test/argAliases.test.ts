import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveArgAliases, formatDeprecationNotice } from "../src/tools.js";

test("resolveArgAliases maps a deprecated name to its replacement and records the use", () => {
  const r = resolveArgAliases({ customer: 7, siteID: 9 }, { customer: "customerID", site: "siteID" });
  assert.deepEqual(r.args, { customerID: 7, siteID: 9 });
  assert.deepEqual(r.used, [{ alias: "customer", name: "customerID" }]);
  assert.equal(r.conflict, undefined);
});

test("resolveArgAliases leaves new names untouched and reports nothing", () => {
  const r = resolveArgAliases({ uploadID: "u1" }, { uploadId: "uploadID" });
  assert.deepEqual(r.args, { uploadID: "u1" });
  assert.deepEqual(r.used, []);
});

test("resolveArgAliases accepts both names with the same value but rejects a mismatch", () => {
  assert.equal(resolveArgAliases({ uploadId: "u1", uploadID: "u1" }, { uploadId: "uploadID" }).conflict, undefined);
  assert.match(resolveArgAliases({ uploadId: "u1", uploadID: "u2" }, { uploadId: "uploadID" }).conflict ?? "", /not both/);
});

test("formatDeprecationNotice names each alias and its replacement", () => {
  assert.match(formatDeprecationNotice([{ alias: "query", name: "intent" }]), /^Deprecated argument name: 'query' \(use 'intent'\)\. This will be removed/);
  assert.match(
    formatDeprecationNotice([{ alias: "customer", name: "customerID" }, { alias: "site", name: "siteID" }]),
    /names: 'customer' \(use 'customerID'\), 'site' \(use 'siteID'\)\. These will be removed/,
  );
});
