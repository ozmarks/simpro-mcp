import { test } from "node:test";
import assert from "node:assert/strict";
import {
  itemCollectionPath,
  planLineItemOps,
  validateLineItemOps,
  ITEM_TYPES,
  ITEM_TYPE_KEYS,
  type LineItemOp,
} from "../src/lineItems.js";

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

test("stock cannot delete but can update", () => {
  assert.equal(ITEM_TYPES.stock.canDelete, false);
  assert.equal(ITEM_TYPES.stock.canUpdate, true);
});

test("asset cannot update but can delete", () => {
  assert.equal(ITEM_TYPES.asset.canUpdate, false);
  assert.equal(ITEM_TYPES.asset.canDelete, true);
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

test("planLineItemOps batches consecutive adds of the same type", () => {
  const ops: LineItemOp[] = [
    { op: "add", itemType: "catalog", fields: { Catalog: 1 } },
    { op: "add", itemType: "catalog", fields: { Catalog: 2 } },
    { op: "add", itemType: "labor", fields: { LaborType: 3 } },
  ];
  assert.deepEqual(planLineItemOps(ops), [
    { op: "add", itemType: "catalog", indexes: [0, 1], bodies: [{ Catalog: 1 }, { Catalog: 2 }] },
    { op: "add", itemType: "labor", indexes: [2], bodies: [{ LaborType: 3 }] },
  ]);
});

test("planLineItemOps keeps order: an update between adds splits the batch", () => {
  const ops: LineItemOp[] = [
    { op: "add", itemType: "catalog", fields: { Catalog: 1 } },
    { op: "update", itemType: "catalog", itemID: 9, fields: { Total: { Qty: 2 } } },
    { op: "add", itemType: "catalog", fields: { Catalog: 2 } },
    { op: "delete", itemType: "oneOff", itemID: 7 },
  ];
  assert.deepEqual(
    planLineItemOps(ops).map((s) => [s.op, s.indexes]),
    [["add", [0]], ["update", [1]], ["add", [2]], ["delete", [3]]],
  );
});

test("validateLineItemOps rejects asset updates and stock deletes by index", () => {
  const errors = validateLineItemOps([
    { op: "update", itemType: "asset", itemID: 1, fields: {} },
    { op: "delete", itemType: "catalog", itemID: 2 },
    { op: "delete", itemType: "stock", itemID: 3 },
  ]);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /^ops\[0\]: asset/);
  assert.match(errors[1], /^ops\[2\]: stock/);
});

test("validateLineItemOps accepts every supported op", () => {
  assert.deepEqual(
    validateLineItemOps([
      { op: "add", itemType: "asset", fields: { Asset: 1 } },
      { op: "update", itemType: "stock", itemID: 1, fields: {} },
      { op: "delete", itemType: "asset", itemID: 1 },
    ]),
    [],
  );
});
