import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePath } from "../src/tools.js";
import { topLevelRoute } from "../src/simproClient.js";
import { getEndpoint } from "../src/catalog.js";

test("strips the company prefix and drops the trailing slash on an item route", () => {
  assert.equal(normalizePath("/api/v1.0/companies/0/jobs/123/"), "jobs/123");
});

test("adds the trailing slash on a collection route", () => {
  assert.equal(normalizePath("jobs"), "jobs/");
});

test("preserves an embedded query string", () => {
  assert.equal(normalizePath("/api/v1.0/companies/0/jobs/?page=2"), "jobs/?page=2");
});

test("routes a full currentUser path from the API root instead of the company scope", () => {
  assert.equal(normalizePath("/api/v1.0/currentUser/"), "api/v1.0/currentUser/");
});

test("canonicalizes bare top-level routes to the api/v1.0 form", () => {
  assert.equal(normalizePath("currentUser"), "api/v1.0/currentUser/");
  assert.equal(normalizePath("info/"), "api/v1.0/info/");
  assert.equal(normalizePath("companies/"), "api/v1.0/companies/");
  assert.equal(normalizePath("/api/v1.0/info/"), "api/v1.0/info/");
  assert.equal(normalizePath("/api/v1.0/companies/"), "api/v1.0/companies/");
});

test("a company-scoped route that merely contains 'companies' is untouched", () => {
  assert.equal(normalizePath("customers/companies/"), "customers/companies/");
  assert.equal(normalizePath("/api/v1.0/companies/0/customers/companies/42/"), "customers/companies/42");
});

test("topLevelRoute allows subroutes for currentUser/info but only the bare companies listing", () => {
  assert.equal(topLevelRoute("currentUser/"), "currentUser");
  assert.equal(topLevelRoute("info/whatever/"), "info");
  assert.equal(topLevelRoute("companies"), "companies");
  assert.equal(topLevelRoute("companies/3/jobs/"), null);
  assert.equal(topLevelRoute("customers/companies/"), null);
  assert.equal(topLevelRoute("jobs/"), null);
});

test("getEndpoint resolves top-level routes under either spelling", () => {
  assert.equal(getEndpoint("GET", "/api/v1.0/currentUser/")?.path, "/api/v1.0/currentUser/");
  assert.equal(getEndpoint("GET", "currentUser")?.path, "/api/v1.0/currentUser/");
  assert.equal(getEndpoint("GET", "companies/")?.path, "/api/v1.0/companies/");
});
