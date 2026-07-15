import { test } from "node:test";
import assert from "node:assert/strict";
import { selectRecord, selectRecords, columnsForFields, describeRecord } from "../src/select.js";

test("selects top-level fields into a single nested row when no arrays are crossed", () => {
  const rec = { ID: 5, Name: "A", Total: { ExTax: 100 } };
  assert.deepEqual(selectRecord(rec, ["ID", "Name", "Total.ExTax"]), [
    { ID: 5, Name: "A", Total: { ExTax: 100 } },
  ]);
});

test("fans out one row per array element, nesting the path and repeating record-level fields", () => {
  const rec = {
    ID: 3586,
    Sections: [{ CostCenters: [{ ID: 11, Total: { ExTax: 1953 } }, { ID: 12, Total: { ExTax: 694 } }] }],
  };
  assert.deepEqual(
    selectRecord(rec, ["ID", "Sections.CostCenters.Total.ExTax"]),
    [
      { ID: 3586, Sections: { CostCenters: { ID: 11, Total: { ExTax: 1953 } } } },
      { ID: 3586, Sections: { CostCenters: { ID: 12, Total: { ExTax: 694 } } } },
    ],
  );
});

test("same field name at two levels never collides (lives at different nesting depths)", () => {
  const rec = { ID: 1, Name: "Job", Sections: [{ CostCenters: [{ ID: 9, Name: "CC" }] }] };
  const [row] = selectRecord(rec, ["ID", "Name", "Sections.CostCenters.ID", "Sections.CostCenters.Name"]);
  assert.equal(row.ID, 1);
  assert.equal(row.Name, "Job");
  assert.equal((row.Sections as any).CostCenters.ID, 9);
  assert.equal((row.Sections as any).CostCenters.Name, "CC");
});

test("fans out across two nested arrays (sections × cost centres)", () => {
  const rec = {
    ID: 1,
    Sections: [
      { CostCenters: [{ ID: 11 }, { ID: 12 }] },
      { CostCenters: [{ ID: 21 }] },
    ],
  };
  const rows = selectRecord(rec, ["ID", "Sections.CostCenters.ID"]);
  assert.deepEqual(rows.map((r) => (r.Sections as any).CostCenters.ID), [11, 12, 21]);
  assert.ok(rows.every((r) => r.ID === 1));
});

test("auto-includes an ID at each array level the fields descend through", () => {
  const rec = { ID: 1, Sections: [{ ID: 7, CostCenters: [{ ID: 11, Total: { ExTax: 5 } }] }] };
  const [row] = selectRecord(rec, ["ID", "Sections.CostCenters.Total.ExTax"]);
  assert.equal(row.ID, 1);
  assert.equal((row.Sections as any).ID, 7);
  assert.equal((row.Sections as any).CostCenters.ID, 11);
  assert.equal((row.Sections as any).CostCenters.Total.ExTax, 5);
});

test("does not inject an ID for an array whose elements have none (e.g. Blocks)", () => {
  const rec = { ID: 1, Sections: [{ CostCenters: [{ Hrs: 0.5 }, { Hrs: 0.25 }] }] };
  const rows = selectRecord(rec, ["ID", "Sections.CostCenters.Hrs"]);
  assert.equal(rows.length, 2);
  assert.ok(!("ID" in (rows[0].Sections as any).CostCenters));
  assert.equal((rows[0].Sections as any).CostCenters.Hrs, 0.5);
});

test("a terminal array field is returned whole, not fanned out", () => {
  const rec = { ID: 1, Date: "d", Blocks: [{ Hrs: 0.5 }, { Hrs: 0.25 }] };
  const rows = selectRecord(rec, ["ID", "Date", "Blocks"]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { ID: 1, Date: "d", Blocks: [{ Hrs: 0.5 }, { Hrs: 0.25 }] });
});

test("a terminal empty array is returned as [] on a single row, not zero rows", () => {
  const rec = { ID: 1, Blocks: [] };
  const rows = selectRecord(rec, ["ID", "Blocks"]);
  assert.deepEqual(rows, [{ ID: 1, Blocks: [] }]);
});

test("descending THROUGH an array still fans out even when another field names a terminal array", () => {
  const rec = { ID: 1, Sections: [{ CostCenters: [{ ID: 11 }, { ID: 12 }] }], Tags: ["a", "b"] };
  const rows = selectRecord(rec, ["ID", "Sections.CostCenters.ID", "Tags"]);
  assert.deepEqual(rows.map((r) => (r.Sections as any).CostCenters.ID), [11, 12]);
  assert.ok(rows.every((r) => Array.isArray(r.Tags) && r.Tags.length === 2));
});

test("an empty array yields no rows for that record", () => {
  const rec = { ID: 1, Sections: [] };
  assert.deepEqual(selectRecord(rec, ["ID", "Sections.CostCenters.ID"]), []);
});

test("missing leaves resolve to undefined, not a thrown error", () => {
  const rec = { ID: 1, Sections: [{ CostCenters: [{ ID: 9 }] }] };
  const [row] = selectRecord(rec, ["ID", "Sections.CostCenters.Total.ExTax"]);
  assert.equal((row.Sections as any).CostCenters.Total.ExTax, undefined);
});

test("selectRecords flattens across multiple records", () => {
  const recs = [
    { ID: 1, Sections: [{ CostCenters: [{ ID: 11 }] }] },
    { ID: 2, Sections: [{ CostCenters: [{ ID: 21 }, { ID: 22 }] }] },
  ];
  const rows = selectRecords(recs, ["ID", "Sections.CostCenters.ID"]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => [r.ID, (r.Sections as any).CostCenters.ID]), [
    [1, 11],
    [2, 21],
    [2, 22],
  ]);
});

test("columnsForFields returns distinct top-level segments and always includes ID", () => {
  assert.deepEqual(
    columnsForFields(["Name", "Total.ExTax", "Sections.CostCenters.Total.ExTax"]).sort(),
    ["ID", "Name", "Sections", "Total"].sort(),
  );
  assert.ok(columnsForFields(["Name"]).includes("ID"));
});

test("describeRecord emits leaf dot-paths with type, no example by default", () => {
  const fields = describeRecord({ ID: 5, Name: "A", Total: { ExTax: 100 } });
  const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
  assert.deepEqual(byPath["ID"], { path: "ID", type: "number", array: false });
  assert.deepEqual(byPath["Total.ExTax"], { path: "Total.ExTax", type: "number", array: false });
  assert.equal(byPath["Total"].type, "object");
  assert.equal(byPath["ID"].example, undefined);
});

test("describeRecord includes example values when values: true", () => {
  const fields = describeRecord({ ID: 5, Total: { ExTax: 100 } }, { values: true });
  const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
  assert.equal(byPath["ID"].example, 5);
  assert.equal(byPath["Total.ExTax"].example, 100);
});

test("describeRecord descends arrays one element deep and flags array: true", () => {
  const rec = { ID: 1, Sections: [{ CostCenters: [{ Total: { ExTax: 9 } }, { Total: { ExTax: 8 } }] }] };
  const byPath = Object.fromEntries(describeRecord(rec, { values: true }).map((f) => [f.path, f]));
  assert.equal(byPath["Sections"].array, true);
  assert.equal(byPath["Sections"].type, "array");
  assert.equal(byPath["Sections.CostCenters.Total.ExTax"].array, true);
  // sampled from element [0] only
  assert.equal(byPath["Sections.CostCenters.Total.ExTax"].example, 9);
});

test("describeRecord only: restricts to named top-level columns", () => {
  const rec = { ID: 1, Name: "Job", Sections: [{ CostCenters: [{ Total: { ExTax: 9 } }] }], Totals: { GP: 5 } };
  const paths = describeRecord(rec, { only: ["Sections"] }).map((f) => f.path);
  assert.ok(paths.includes("Sections"));
  assert.ok(paths.includes("Sections.CostCenters.Total.ExTax"));
  assert.ok(!paths.includes("ID"));
  assert.ok(!paths.includes("Totals.GP"));
});

test("describeRecord truncates long string values and marks them (with values)", () => {
  const long = "x".repeat(300);
  const f = describeRecord({ Description: long }, { values: true }).find((x) => x.path === "Description")!;
  assert.equal(f.truncated, true);
  assert.ok((f.example as string).length < long.length);
  assert.ok((f.example as string).endsWith("…"));
});

test("describeRecord handles null and empty arrays without throwing", () => {
  const fields = describeRecord({ ID: 1, SiteContact: null, Tags: [] });
  const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
  assert.equal(byPath["SiteContact"].type, "null");
  assert.equal(byPath["Tags"].type, "array");
  assert.equal(byPath["Tags"].array, true);
});
