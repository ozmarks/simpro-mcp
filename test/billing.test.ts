import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunk,
  mapLimit,
  resolveCutoff,
  localToday,
  wildcard,
  parseReference,
  summarizeSchedules,
  lastInvoicePerCostCenter,
  unclaimed,
  shapeUnsentInvoices,
  buildUninvoicedReport,
} from "../src/billing.js";

test("chunk splits into fixed-size batches", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
});

test("mapLimit preserves order and caps concurrency", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
  assert.equal(peak, 2);
});

test("resolveCutoff: explicit date wins, else asOf minus offsetDays", () => {
  assert.equal(resolveCutoff({ cutoffDate: "2026-10-30", offsetDays: 5, asOf: "2026-11-10" }), "2026-10-30");
  assert.equal(resolveCutoff({ offsetDays: 11, asOf: "2026-11-10" }), "2026-10-30");
  assert.equal(resolveCutoff({ asOf: "2026-03-01", offsetDays: 1 }), "2026-02-28");
  assert.equal(resolveCutoff({ asOf: "2026-11-10" }), "2026-11-10");
  assert.throws(() => resolveCutoff({ cutoffDate: "30/10/2026" }), /YYYY-MM-DD/);
});

test("localToday uses local calendar components", () => {
  assert.equal(localToday(new Date(2026, 10, 10, 8, 0)), "2026-11-10");
});

test("wildcard wraps text and strips literal %", () => {
  assert.equal(wildcard("Emailed"), "%Emailed%");
  assert.equal(wildcard("50%"), "%50%");
});

test("parseReference splits jobID-costCenterID and rejects other shapes", () => {
  assert.deepEqual(parseReference("3761-12414"), { jobID: 3761, costCenterID: 12414 });
  assert.equal(parseReference("3761"), undefined);
  assert.equal(parseReference(undefined), undefined);
});

test("summarizeSchedules applies cutoff, from and staff exclusion per cost centre", () => {
  const s = summarizeSchedules(
    [
      { Date: "2026-10-20", Reference: "1-10", TotalHours: 2, Staff: { ID: 5 } },
      { Date: "2026-10-25", Reference: "1-10", TotalHours: 3, Staff: { ID: 5 } },
      { Date: "2026-11-20", Reference: "1-10", TotalHours: 8, Staff: { ID: 5 } }, // after cutoff
      { Date: "2026-10-26", Reference: "1-11", TotalHours: 0.5, Staff: { ID: 146 } }, // excluded crew
      { Date: "2026-09-01", Reference: "1-12", TotalHours: 1, Staff: { ID: 5 } }, // before from
    ],
    { cutoff: "2026-10-30", from: "2026-10-01", excludeStaffIDs: [146] },
  );
  assert.deepEqual([...s.keys()], [10]);
  assert.deepEqual(s.get(10), { lastScheduled: "2026-10-25", firstScheduled: "2026-10-20", bookings: 2, hours: 5 });
});

test("lastInvoicePerCostCenter takes the latest date, from arrays or fanned-out rows", () => {
  const m = lastInvoicePerCostCenter([
    { ID: 1, DateIssued: "2026-09-30", CostCenters: [{ ID: 10 }, { ID: 11 }] },
    { ID: 2, DateIssued: "2026-11-01", CostCenters: { ID: 10 } },
  ]);
  assert.deepEqual(m.get(10), { date: "2026-11-01", invoiceID: 2 });
  assert.deepEqual(m.get(11), { date: "2026-09-30", invoiceID: 1 });
});

test("unclaimed treats a missing Claimed block as fully unclaimed", () => {
  assert.deepEqual(unclaimed({ Total: { ExTax: 1000 } }), { total: 1000, claimedPercent: 0, remaining: 1000 });
  assert.deepEqual(
    unclaimed({
      Total: { ExTax: 1000 },
      Claimed: { ToDate: { Percent: 40, Amount: { ExTax: 400 } }, Remaining: { Percent: 60, Amount: { ExTax: 600 } } },
    }),
    { total: 1000, claimedPercent: 40, remaining: 600 },
  );
});

test("shapeUnsentInvoices keeps only invoices without a matching log, oldest first", () => {
  const r = shapeUnsentInvoices(
    [
      { ID: 1, DateIssued: "2026-11-01", Customer: { ID: 9, CompanyName: "Acme" }, Jobs: [{ ID: 50 }], Total: { IncTax: 110, Paid: 0 } },
      { ID: 2, DateIssued: "2026-10-01", Customer: { ID: 8, GivenName: "Jo", FamilyName: "Bloggs" }, Total: { IncTax: 220, Paid: 20 } },
      { ID: 3, DateIssued: "2026-10-05", Total: { IncTax: 999 } },
    ],
    new Set([3]),
    "2026-11-10",
  );
  assert.deepEqual(r.summary, { unpaidChecked: 3, withMatchingLog: 1, withoutMatchingLog: 2, outstandingIncTax: 310 });
  assert.deepEqual(r.invoices.map((i) => i.ID), [2, 1]);
  assert.equal(r.invoices[0].customer, "Jo Bloggs");
  assert.equal(r.invoices[0].daysSinceIssued, 40);
  assert.deepEqual(r.invoices[1].jobIDs, [50]);
});

test("buildUninvoicedReport lists scheduled cost centres with unclaimed value", () => {
  const jobRows = [
    { ID: 1, Name: "J1", Stage: "Progress", Customer: { ID: 7, CompanyName: "C" }, Sections: { ID: 100, CostCenters: { ID: 10, Name: "A", Total: { ExTax: 1000 } } } },
    // fully claimed: dropped
    {
      ID: 1,
      Name: "J1",
      Sections: { ID: 100, CostCenters: { ID: 11, Name: "B", Total: { ExTax: 500 }, Claimed: { ToDate: { Percent: 100, Amount: { ExTax: 500 } }, Remaining: { Percent: 0, Amount: { ExTax: 0 } } } } },
    },
    // unclaimed but never scheduled: dropped
    { ID: 1, Name: "J1", Sections: { ID: 100, CostCenters: { ID: 12, Name: "C", Total: { ExTax: 300 } } } },
    // job with no schedules at all: dropped
    { ID: 2, Name: "J2", Sections: { ID: 200, CostCenters: { ID: 20, Name: "D", Total: { ExTax: 800 } } } },
  ];
  const schedules = new Map([
    [
      1,
      [
        { Date: "2026-10-25", Reference: "1-10", TotalHours: 4 },
        { Date: "2026-10-26", Reference: "1-11", TotalHours: 4 },
      ],
    ],
  ]);
  const invoices = [{ ID: 900, DateIssued: "2026-10-01", CostCenters: [{ ID: 10 }] }];
  const r = buildUninvoicedReport(jobRows, schedules, invoices, { cutoff: "2026-10-30", asOf: "2026-11-10" });
  assert.deepEqual(r.summary, { jobs: 1, costCenters: 1, unclaimedExTax: 1000 });
  const [job] = r.jobs;
  assert.equal(job.jobID, 1);
  assert.equal(job.customer, "C");
  assert.equal(job.daysSinceLastScheduled, 16);
  assert.equal(job.costCenters[0].costCenterID, 10);
  assert.equal(job.costCenters[0].lastInvoiced, "2026-10-01");
  assert.equal(job.costCenters[0].invoicedSinceLastSchedule, false);
});
