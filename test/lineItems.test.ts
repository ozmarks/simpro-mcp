import { test } from "node:test";
import assert from "node:assert/strict";
import { itemCollectionPath, ITEM_TYPES, ITEM_TYPE_KEYS } from "../src/lineItems.js";

test("itemCollectionPath builds a job collection path with a trailing slash", () => {
  assert.equal(
    itemCollectionPath("job", 1, 2, 3, "catalog"),
    "jobs/1/sections/2/costCenters/3/catalogs/",
  );
});

test("itemCollectionPath builds a quote collection path", () => {
  assert.equal(
    itemCollectionPath("quote", 10, 20, 30, "serviceFee"),
    "quotes/10/sections/20/costCenters/30/serviceFees/",
  );
});

test("itemCollectionPath ends with the type's segment for every type", () => {
  for (const type of ITEM_TYPE_KEYS) {
    const path = itemCollectionPath("job", 1, 2, 3, type);
    assert.ok(
      path.endsWith(`${ITEM_TYPES[type].segment}/`),
      `${type}: ${path} should end with ${ITEM_TYPES[type].segment}/`,
    );
  }
});

test("stock cannot delete or replace but can update", () => {
  assert.equal(ITEM_TYPES.stock.canDelete, false);
  assert.equal(ITEM_TYPES.stock.canReplace, false);
  assert.equal(ITEM_TYPES.stock.canUpdate, true);
});

test("asset cannot update but can delete and replace", () => {
  assert.equal(ITEM_TYPES.asset.canUpdate, false);
  assert.equal(ITEM_TYPES.asset.canDelete, true);
  assert.equal(ITEM_TYPES.asset.canReplace, true);
});

test("anchorField matches the documented anchor per type", () => {
  const expected: Record<string, string> = {
    catalog: "Catalog",
    labor: "LaborType",
    oneOff: "Type",
    prebuild: "Prebuild",
    serviceFee: "ServiceFee",
    stock: "AssignedBreakdown",
    asset: "Asset",
  };
  for (const type of ITEM_TYPE_KEYS) {
    assert.equal(ITEM_TYPES[type].anchorField, expected[type]);
  }
});

test("ITEM_TYPE_KEYS equals Object.keys(ITEM_TYPES) and has 7 entries", () => {
  assert.deepEqual([...ITEM_TYPE_KEYS], Object.keys(ITEM_TYPES));
  assert.equal(ITEM_TYPE_KEYS.length, 7);
});
