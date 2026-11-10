// Pure logic behind the billing-check tools (find_unsent_invoices, find_uninvoiced_work). The tools
// in tools.ts do the fetching; everything here is deterministic so it can be unit-tested.

type AnyRec = Record<string, any>;

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Run `fn` over items with at most `limit` in flight. Calls still pass through the shared rate
// limiter; this only bounds how many requests queue at once.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
  return ISO_DATE.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));
}

// Today's date in the server's local timezone (not UTC: a Melbourne morning is still "yesterday" in UTC).
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(later: string, earlier: string): number {
  const a = Date.parse(`${later}T00:00:00Z`);
  const b = Date.parse(`${earlier}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((a - b) / 86_400_000);
}

// Resolve the "work up to" date: an explicit cutoffDate wins; otherwise asOf (default today) minus offsetDays.
export function resolveCutoff(opts: { cutoffDate?: string; offsetDays?: number; asOf?: string }): string {
  if (opts.cutoffDate) {
    if (!isIsoDate(opts.cutoffDate)) throw new Error(`cutoffDate must be YYYY-MM-DD (got "${opts.cutoffDate}").`);
    return opts.cutoffDate;
  }
  const asOf = opts.asOf ?? localToday();
  if (!isIsoDate(asOf)) throw new Error(`asOf must be YYYY-MM-DD (got "${asOf}").`);
  return addDays(asOf, -(opts.offsetDays ?? 0));
}

export function customerName(c: AnyRec | undefined): string | undefined {
  if (!c) return undefined;
  if (c.CompanyName) return String(c.CompanyName);
  const n = [c.GivenName, c.FamilyName].filter(Boolean).join(" ");
  return n || c.Name || undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Escape Simpro's wildcard so a literal % in the search text can't widen the match. Simpro's
// filter grammar has no documented escape, so a % is simply dropped.
export function wildcard(text: string): string {
  return `%${text.replace(/%/g, "")}%`;
}

// ---------- find_unsent_invoices ----------

export function shapeUnsentInvoices(
  invoices: AnyRec[],
  matchedInvoiceIDs: Set<number>,
  asOf: string,
): { summary: Record<string, unknown>; invoices: AnyRec[] } {
  const unsent: AnyRec[] = [];
  let unsentIncTax = 0;
  for (const inv of invoices) {
    if (matchedInvoiceIDs.has(Number(inv.ID))) continue;
    const incTax = Number(inv.Total?.IncTax) || 0;
    const paid = Number(inv.Total?.Paid) || 0;
    unsentIncTax += incTax - paid;
    unsent.push({
      ID: inv.ID,
      customer: customerName(inv.Customer),
      customerID: inv.Customer?.ID,
      jobIDs: Array.isArray(inv.Jobs) ? inv.Jobs.map((j: AnyRec) => j?.ID).filter((x: unknown) => x != null) : [],
      stage: inv.Stage,
      status: inv.Status?.Name,
      dateIssued: inv.DateIssued,
      dueDate: inv.DueDate,
      daysSinceIssued: inv.DateIssued ? daysBetween(asOf, String(inv.DateIssued)) : undefined,
      totalIncTax: round2(incTax),
      paid: round2(paid),
      ...(inv.IsCredit ? { isCredit: true } : {}),
    });
  }
  unsent.sort((a, b) => String(a.dateIssued ?? "").localeCompare(String(b.dateIssued ?? "")));
  return {
    summary: {
      unpaidChecked: invoices.length,
      withMatchingLog: invoices.length - unsent.length,
      withoutMatchingLog: unsent.length,
      outstandingIncTax: round2(unsentIncTax),
    },
    invoices: unsent,
  };
}

// ---------- find_uninvoiced_work ----------

export type ScheduleRow = { ID?: number; Date?: string; Reference?: string; TotalHours?: number; Staff?: { ID?: number } };

// A job schedule's Reference is "<jobID>-<costCenterID>".
export function parseReference(ref: string | undefined): { jobID: number; costCenterID: number } | undefined {
  const m = /^(\d+)-(\d+)$/.exec(String(ref ?? "").trim());
  return m ? { jobID: Number(m[1]), costCenterID: Number(m[2]) } : undefined;
}

type CcSched = { lastScheduled: string; firstScheduled: string; bookings: number; hours: number };

// Per cost centre: the latest / earliest scheduled date at or before the cutoff, booking count and hours.
export function summarizeSchedules(
  schedules: ScheduleRow[],
  opts: { cutoff: string; from?: string; excludeStaffIDs?: number[] },
): Map<number, CcSched> {
  const exclude = new Set(opts.excludeStaffIDs ?? []);
  const out = new Map<number, CcSched>();
  for (const s of schedules) {
    const date = s.Date;
    if (!date || date > opts.cutoff || (opts.from && date < opts.from)) continue;
    if (s.Staff?.ID != null && exclude.has(Number(s.Staff.ID))) continue;
    const ref = parseReference(s.Reference);
    if (!ref) continue;
    const cur = out.get(ref.costCenterID);
    const hrs = Number(s.TotalHours) || 0;
    if (!cur) {
      out.set(ref.costCenterID, { lastScheduled: date, firstScheduled: date, bookings: 1, hours: hrs });
    } else {
      if (date > cur.lastScheduled) cur.lastScheduled = date;
      if (date < cur.firstScheduled) cur.firstScheduled = date;
      cur.bookings += 1;
      cur.hours += hrs;
    }
  }
  for (const v of out.values()) v.hours = round2(v.hours);
  return out;
}

// Latest invoice DateIssued per cost centre, from invoice rows carrying CostCenters[].ID.
export function lastInvoicePerCostCenter(invoices: AnyRec[]): Map<number, { date: string; invoiceID: number }> {
  const out = new Map<number, { date: string; invoiceID: number }>();
  for (const inv of invoices) {
    const date = inv.DateIssued ? String(inv.DateIssued) : undefined;
    // Accept the raw array or a fanned-out row (one cost centre object per row).
    const ccs = Array.isArray(inv.CostCenters) ? inv.CostCenters : inv.CostCenters ? [inv.CostCenters] : [];
    if (!date) continue;
    for (const cc of ccs) {
      const id = Number(cc?.ID);
      if (!Number.isFinite(id)) continue;
      const cur = out.get(id);
      if (!cur || date > cur.date) out.set(id, { date, invoiceID: Number(inv.ID) });
    }
  }
  return out;
}

// Unclaimed ex-tax value of a cost centre. Simpro omits Claimed on a cost centre that has never been
// claimed, so a missing block means the whole total is unclaimed.
export function unclaimed(cc: AnyRec): { total: number; claimedPercent: number; remaining: number } {
  const total = Number(cc?.Total?.ExTax) || 0;
  const claimed = cc?.Claimed;
  const remainingAmt = claimed?.Remaining?.Amount?.ExTax;
  const toDateAmt = Number(claimed?.ToDate?.Amount?.ExTax) || 0;
  const remaining = remainingAmt != null ? Number(remainingAmt) || 0 : total - toDateAmt;
  const claimedPercent =
    claimed?.ToDate?.Percent != null ? Number(claimed.ToDate.Percent) || 0 : total ? (toDateAmt / total) * 100 : 0;
  return { total: round2(total), claimedPercent: round2(claimedPercent), remaining: round2(remaining) };
}

export type JobCostCenterRow = {
  ID: number;
  Name?: string;
  Stage?: string;
  Customer?: AnyRec;
  Sections?: { ID?: number; CostCenters?: AnyRec };
};

// Combine the three reads into the report: one entry per job that has at least one cost centre
// scheduled at or before the cutoff with unclaimed value left.
export function buildUninvoicedReport(
  jobRows: JobCostCenterRow[],
  schedulesByJob: Map<number, ScheduleRow[]>,
  invoices: AnyRec[],
  opts: { cutoff: string; from?: string; excludeStaffIDs?: number[]; asOf: string; minUnclaimed?: number },
): { summary: Record<string, unknown>; jobs: AnyRec[] } {
  const minUnclaimed = opts.minUnclaimed ?? 0.01;
  const lastInv = lastInvoicePerCostCenter(invoices);
  const perJobSched = new Map<number, Map<number, CcSched>>();
  for (const [jobID, rows] of schedulesByJob) perJobSched.set(jobID, summarizeSchedules(rows, opts));

  const jobs = new Map<number, AnyRec>();
  for (const row of jobRows) {
    const cc = row.Sections?.CostCenters;
    const ccID = Number(cc?.ID);
    if (!cc || !Number.isFinite(ccID)) continue;
    const sched = perJobSched.get(row.ID)?.get(ccID);
    if (!sched) continue;
    const u = unclaimed(cc);
    if (u.remaining < minUnclaimed) continue;
    const inv = lastInv.get(ccID);
    let job = jobs.get(row.ID);
    if (!job) {
      job = {
        jobID: row.ID,
        name: row.Name,
        stage: row.Stage,
        customer: customerName(row.Customer),
        customerID: row.Customer?.ID,
        unclaimedExTax: 0,
        lastScheduled: sched.lastScheduled,
        costCenters: [] as AnyRec[],
      };
      jobs.set(row.ID, job);
    }
    job.unclaimedExTax = round2(job.unclaimedExTax + u.remaining);
    if (sched.lastScheduled > job.lastScheduled) job.lastScheduled = sched.lastScheduled;
    job.costCenters.push({
      costCenterID: ccID,
      sectionID: row.Sections?.ID,
      name: cc.Name,
      totalExTax: u.total,
      claimedPercent: u.claimedPercent,
      unclaimedExTax: u.remaining,
      firstScheduled: sched.firstScheduled,
      lastScheduled: sched.lastScheduled,
      bookings: sched.bookings,
      scheduledHours: sched.hours,
      lastInvoiced: inv?.date,
      lastInvoiceID: inv?.invoiceID,
      invoicedSinceLastSchedule: inv ? inv.date >= sched.lastScheduled : false,
    });
  }

  const list: AnyRec[] = [...jobs.values()].map((j) => ({ ...j, daysSinceLastScheduled: daysBetween(opts.asOf, j.lastScheduled) }));
  list.sort((a, b) => String(a.lastScheduled).localeCompare(String(b.lastScheduled)));
  const totalUnclaimed = round2(list.reduce((s, j) => s + j.unclaimedExTax, 0));
  return {
    summary: {
      jobs: list.length,
      costCenters: list.reduce((s, j) => s + j.costCenters.length, 0),
      unclaimedExTax: totalUnclaimed,
    },
    jobs: list,
  };
}
