import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { SimproClient, SimproError, topLevelRoute } from "./simproClient.js";
import { cleanRichText, applyLean } from "./format.js";
import { searchEndpoints, getEndpoint, closestRoutes } from "./catalog.js";
import {
  ITEM_TYPES,
  ITEM_TYPE_KEYS,
  itemCollectionPath,
  planLineItemOps,
  validateLineItemOps,
  type ItemType,
  type LineItemOp,
} from "./lineItems.js";
import { selectRecords, columnsForFields, describeRecord } from "./select.js";
import type { VersionChecker, UpdateInfo } from "./versionCheck.js";
import { sharedUploadStore, validateStart, UploadError, CHUNK_MAX_BYTES, ALLOWED_EXTENSIONS } from "./uploads.js";

// One-line agent-facing update notice (stdio surfaces it on a tool result; HTTP logs it instead).
export function formatUpdateNotice(u: UpdateInfo): string {
  return (
    `A newer version of simpro-mcp-server is available: ${u.latest} (running ${u.current}).` +
    (u.notice ? ` ${u.notice}` : "") +
    (u.url ? ` See ${u.url}.` : "")
  );
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };

// Append the update notice as an extra content block. Pure; the once-per-session latch lives in
// registerTools (it owns the `sent` flag).
export function appendUpdateNotice(result: ToolResult, update: UpdateInfo | undefined): ToolResult {
  if (!update) return result;
  return { content: [...result.content, { type: "text", text: formatUpdateNotice(update) }] };
}

function okWithBudget(data: unknown, maxBytes = Number.POSITIVE_INFINITY, doLean = false) {
  const cleaned = doLean ? applyLean(cleanRichText(data)) : cleanRichText(data);
  const text = cleaned === undefined ? JSON.stringify({ success: true }) : JSON.stringify(cleaned);

  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    const count = Array.isArray(cleaned)
      ? cleaned.length
      : Array.isArray((cleaned as { rows?: unknown[] } | undefined)?.rows)
        ? (cleaned as { rows: unknown[] }).rows.length
        : undefined;
    const pagination = (cleaned as { pagination?: unknown } | undefined)?.pagination;
    const note =
      `Result withheld: ${bytes} bytes exceeds the ${maxBytes}-byte response budget` +
      (count !== undefined ? ` (${count} rows on this page)` : "") +
      ". Narrow the request — request fewer columns, a smaller pageSize, or tighter filters — then retry.";
    return { content: [{ type: "text" as const, text: JSON.stringify({ tooLarge: true, bytes, maxBytes, rows: count, pagination, note }) }] };
  }
  return { content: [{ type: "text" as const, text }] };
}
export type SimproFieldError = { path?: string; message?: string; value?: unknown };

// Known Simpro footguns where the raw 422 path/message is opaque. Maps a matched error to a
// concrete fix hint so the agent self-corrects (per the "clearer errors, no silent translation" rule).
export function footgunHint(e: SimproFieldError): string | undefined {
  const path = (e.path ?? "").toLowerCase();
  const message = e.message ?? "";
  // Live: POSTing SellPrice.ExTax → path "/SellPrice/ExTax", message "This API Column does not allow POST requests."
  if (path.includes("sellprice")) {
    return "SellPrice is a read-only shape ({ ExTax, IncTax }) and can't be written. To set a one-off's price, send SellPriceExDiscount (a number) for an exact sell, or EstimatedCost + Markup.";
  }
  // Live: "This quote is currently locked by Jane Citizen. Please try again later."
  const lock = message.match(/currently locked by ([^.]+)/i);
  if (lock) {
    return (
      `The record is open in Simpro by ${lock[1].trim()}, and Simpro locks it until they close it. ` +
      "The API can't read who holds a lock or when it clears, so retrying won't help. Tell the user the item is locked " +
      "and must be closed inside Simpro, then retry. Don't DELETE the …/lock/ route to force the write."
    );
  }
  if (/(standard|set)-price prebuild not found/i.test(message)) {
    return (
      "Pre-builds are either set price (/prebuilds/setPrice/{id}) or standard price (/prebuilds/standardPrice/{id}), and each ID " +
      "answers on only one route. GET prebuilds/ with columns 'ID,_href' shows which route each pre-build uses."
    );
  }
  if (/Material Sell mode is 'Default'/i.test(message) || /add a default labour rate/i.test(message)) {
    return (
      "A standard-price pre-build's price comes from its materials and labour, so TotalEx can't be set directly. Send " +
      "{ MaterialSale: 'None', MaterialSellPrice: <price> }. The price only sticks once the pre-build has materials " +
      "(POST prebuilds/{id}/catalogs/); without them an update can report success while the price stays 0."
    );
  }
  return undefined;
}

function formatFieldErrors(errors: SimproFieldError[]): string {
  return errors
    .map((e) => {
      const hint = footgunHint(e);
      return (
        `  - ${e.path ?? "(root)"}: ${e.message}${e.value !== undefined && e.value !== null ? ` (got: ${JSON.stringify(e.value)})` : ""}` +
        (hint ? `\n    → ${hint}` : "")
      );
    })
    .join("\n");
}

export type RouteContext = { method: string; path: string };

export function routeHint(err: SimproError, ctx: RouteContext | undefined): string | undefined {
  if (!ctx || err.status !== 404) return undefined;
  const errors = (err.body as { errors?: SimproFieldError[] } | undefined)?.errors ?? [];
  if (!errors.some((e) => /invalid route/i.test(e.message ?? ""))) return undefined;
  const near = closestRoutes(ctx.method, ctx.path);
  if (!near.length) return "→ Simpro has no such route. Use find_operation to get the exact path.";
  return `→ Simpro has no such route. Closest ${ctx.method} routes: ${near.join(", ")}. Use find_operation if none fit.`;
}

export function fail(err: unknown, ctx?: RouteContext) {
  let msg: string;
  if (err instanceof SimproError) {
    const body = err.body as { errors?: SimproFieldError[] } | undefined;
    if (body?.errors?.length) {
      msg = `${err.message}\n${formatFieldErrors(body.errors)}`;
    } else {
      msg = `${err.message}${err.body ? `\n${JSON.stringify(err.body)}` : ""}`;
    }
    const hint = routeHint(err, ctx);
    if (hint) msg += `\n${hint}`;
  } else {
    msg = err instanceof Error ? err.message : String(err);
  }
  return { isError: true, content: [{ type: "text" as const, text: msg }] };
}

type BulkItem = { status: number; headers?: Record<string, unknown>; body?: unknown };

function isBulkResponse(body: unknown): body is BulkItem[] {
  return (
    Array.isArray(body) &&
    body.length > 0 &&
    body.every((r) => r && typeof r === "object" && typeof (r as BulkItem).status === "number")
  );
}

// A /multiple/ call answers 200 even when every item inside failed, so lead with the tally.
export function summarizeBulk(body: unknown): unknown {
  if (!isBulkResponse(body)) return body;
  const failed = body.filter((r) => r.status >= 400);
  const summary: Record<string, unknown> = {
    bulk: { total: body.length, succeeded: body.length - failed.length, failed: failed.length },
  };
  if (failed.length) {
    summary.failures = failed.map((r) => {
      const errors = (r.body as { errors?: SimproFieldError[] } | undefined)?.errors;
      return {
        batchId: r.headers?.["Batch-ID"],
        status: r.status,
        errors: errors?.length ? formatFieldErrors(errors) : r.body,
      };
    });
  }
  summary.results = body;
  return summary;
}

// Each update/delete is its own request, so this bounds a call to a few seconds at the shared ~8 req/s.
const MAX_LINE_ITEM_OPS = 50;

const entityArg = z
  .enum(["job", "quote"])
  .describe("'job' or 'quote' — collectively 'work'. Jobs and quotes share the same structure.");

const workTypeArg = z
  .enum(["Project", "Service", "Prepaid"])
  .describe("Work type (required by Simpro): 'Project', 'Service', or 'Prepaid'.");

const DEFAULT_LIST_COLUMNS = ["ID", "Name", "Customer", "Status", "Stage", "Total", "DateIssued", "DueDate"];
const base = (entity: "job" | "quote") => (entity === "quote" ? "quotes" : "jobs");

const matchSchemeArg = z
  .enum(["all", "any"])
  .optional()
  .describe("Match scheme across filters: 'all' = AND (default), 'any' = OR. This is Simpro's `search` param — NOT a keyword field.");

function buildSearchQuery(
  keywords: string | undefined,
  searchColumns: string[],
  filters: Record<string, unknown> | undefined,
  matchScheme: "all" | "any" | undefined,
): Record<string, unknown> {
  const q: Record<string, unknown> = { ...(filters ?? {}) };
  const kw = keywords?.trim();
  if (kw) {
    const pattern = `%${kw}%`;
    for (const col of searchColumns) {
      if (q[col] === undefined) q[col] = pattern;
    }
    if (matchScheme === undefined && searchColumns.length > 1) q.search = "any";
  }
  if (matchScheme !== undefined) q.search = matchScheme;
  return q;
}

// Shape a write result so it always carries the resource id Simpro reported (from the Location /
// Resource-ID header). On a 204 (no body) this is the only id the agent gets back; on a 200/201
// the id is surfaced alongside the body so a client that lost the socket can confirm-by-id.
export function writeReceipt(body: unknown, resourceId: string | number | undefined): unknown {
  if (resourceId === undefined) return body;
  if (body === undefined) return { success: true, resourceId };
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const rec = body as Record<string, unknown>;
    return rec.resourceId === undefined ? { ...rec, resourceId } : rec;
  }
  return { resourceId, result: body };
}

export function registerTools(
  server: McpServer,
  client: SimproClient,
  cfg: Config,
  versionChecker?: VersionChecker,
): void {
  const defaultPageSize = cfg.defaultPageSize;
  const uploads = sharedUploadStore({ maxUploadBytes: cfg.maxUploadBytes, memoryBytes: cfg.uploadMemoryBytes });

  // Surface a "new version available" notice as an extra content block on the FIRST tool result
  // of this server's lifetime, then latch off. stdio = one long-lived server, so this fires once
  // per session; the HTTP transports rebuild per request (and log the notice instead), so they
  // pass no checker here and never reach this path.
  let updateNoticeSent = false;
  const withUpdateNotice = (result: { content: Array<{ type: "text"; text: string }> }) => {
    if (updateNoticeSent || !versionChecker) return result;
    const update = versionChecker.getUpdate();
    if (!update) return result;
    updateNoticeSent = true;
    return appendUpdateNotice(result, update);
  };

  const ok = (data: unknown) => withUpdateNotice(okWithBudget(data, cfg.maxResultBytes, false));
  const okLean = (data: unknown) => withUpdateNotice(okWithBudget(data, cfg.maxResultBytes, true));

  // POST/PUT/PATCH/DELETE through one path that echoes the resource id as a receipt.
  const okWrite = async (
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    opts: { body?: unknown; query?: Record<string, unknown> } = {},
  ) => {
    const { body, resourceId } = await client.requestWithReceipt(method, path, opts);
    return ok(writeReceipt(summarizeBulk(body), resourceId));
  };

  server.registerTool(
    "find_work",
    {
      title: "Find Work (Jobs/Quotes)",
      description:
        "Search or browse jobs or quotes. Set entity to 'job' or 'quote'. Pass `keywords` for free-text matching on the Name (handled internally as a wildcard filter). Use `filters` for server-side narrowing (e.g. { Stage: 'InProgress', Customer: 131 }). Stage values differ by entity: quotes are InProgress | Complete | Approved; jobs are Pending | Progress | Complete | Invoiced | Archived. Filters support operators like gt()/between()/in() and nested columns (Customer.ID). Returns one page as { rows, pagination: { page, totalPages, totalRows } }; request later pages with `page`. Returns a lean column set; `columns` adds more (a large pageSize with many columns can exceed the response budget — keep one or the other modest).",
      inputSchema: {
        entity: entityArg,
        keywords: z.string().optional().describe("Free-text to match on the work Name (e.g. 'Croydon'). Applied internally as a wildcard Name filter; this is plain text, not a Simpro search scheme."),
        filters: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Server-side column filters { Column: value }, e.g. { Stage: 'InProgress', Total: 'gt(5000)' }. Quote stages: InProgress | Complete | Approved. Job stages: Pending | Progress | Complete | Invoiced | Archived."),
        matchScheme: matchSchemeArg,
        columns: z.array(z.string()).optional().describe("Columns to return (omit for default)."),
        page: z.number().int().positive().optional(),
        pageSize: z.number().int().positive().max(250).optional().describe(`Rows per page (max 250; defaults to ${defaultPageSize}). Larger pages risk exceeding the response budget.`),
        orderby: z.array(z.string()).optional().describe("e.g. ['-ID'] for newest first."),
      },
      annotations: { title: "Find Work", readOnlyHint: true },
    },
    async ({ entity, keywords, filters, matchScheme, columns, page, pageSize, orderby }) => {
      try {
        return okLean(
          await client.getList(`${base(entity)}/`, {
            columns: columns ?? DEFAULT_LIST_COLUMNS,
            page,
            pageSize: pageSize ?? defaultPageSize,
            orderby,
            ...buildSearchQuery(keywords, ["Name"], filters, matchScheme),
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_work",
    {
      title: "Get Work (Job/Quote)",
      description:
        "Retrieve one job or quote's top-level details by ID (no nested tree). For its structure use get_breakdown; for cost-center lines use list_line_items. Returns a lean payload (empty/null fields and Simpro's duplicate 'Revized' figures stripped; see the _lean note on the result for the rule).",
      inputSchema: {
        entity: entityArg,
        id: z.number().int().positive().describe("The job/quote Simpro ID."),
        columns: z.array(z.string()).optional().describe("Limit fields (omit for all top-level)."),
      },
      annotations: { title: "Get Work", readOnlyHint: true },
    },
    async ({ entity, id, columns }) => {
      try {
        return okLean(await client.get(`${base(entity)}/${id}`, { columns }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_work",
    {
      title: "Create Work (Job/Quote)",
      description:
        "Create a new job or quote. Simpro requires three fields for both: a Customer (ID), a Site (ID), and a Type ('Project' | 'Service' | 'Prepaid'). " +
        "Find a customer's sites with simpro_api_get path 'sites/' and query { 'Customers.ID': <customerID>, columns: 'ID,Name,Address' }. " +
        "A brand-new customer has no site until one is created with simpro_api_post path 'sites/' and body { Name, Address?, Customers: [<customerID>] }. " +
        "Other fields (Name, Description, DueDate, …) go in `fields`. Description is rich text (HTML): plain-text line breaks are collapsed, so use <p>, <br>, <strong> and <ul><li>.",
      inputSchema: {
        entity: entityArg,
        customer: z.number().int().positive().describe("Customer ID (required)."),
        site: z
          .number()
          .int()
          .positive()
          .describe("Site ID (required by Simpro). A customer's sites: GET sites/ filtered by { 'Customers.ID': <customerID> }."),
        type: workTypeArg,
        fields: z.record(z.unknown()).optional().describe("Additional body fields, merged in."),
      },
      annotations: { title: "Create Work", readOnlyHint: false },
    },
    async ({ entity, customer, site, type, fields }) => {
      try {
        return await okWrite("POST", `${base(entity)}/`, {
          body: { Customer: customer, Site: site, Type: type, ...(fields ?? {}) },
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // Only the work-level display=all read inlines the full Items tree; the costCenters collection does not (verified live).
  server.registerTool(
    "get_breakdown",
    {
      title: "Get Breakdown",
      description:
        "Get a job/quote's structure in one call: every section with its cost centers. Each cost center carries an `itemCounts` map (e.g. { prebuild: 4 }) showing how many line items of each type it holds — call list_line_items once per populated type instead of probing all seven. " +
        "Pass items:true to also get every cost center's line items inline from the same call (each with its ID, description, qty and sell price) — use this to scan many cost centers or quotes without a list_line_items call each. " +
        "Inline items don't include PartNo, EstimatedCost or other cost fields; read those with list_line_items.",
      inputSchema: {
        entity: entityArg,
        id: z.number().int().positive().describe("The job/quote Simpro ID."),
        items: z.boolean().optional().describe("Include each cost center's line items inline (no extra calls). Default false."),
      },
      annotations: { title: "Get Breakdown", readOnlyHint: true },
    },
    async ({ entity, id, items }) => {
      try {
        const work = (await client.get(`${base(entity)}/${id}`, { display: "all" })) as Record<string, any>;
        const sections = (Array.isArray(work.Sections) ? work.Sections : []).map((s: any) => ({
          ID: s.ID,
          Name: s.Name,
          DisplayOrder: s.DisplayOrder,
          costCenters: (Array.isArray(s.CostCenters) ? s.CostCenters : []).map((cc: any) => {
            const { Items, ...rest } = cc;
            return { ...rest, itemCounts: countItems(Items), ...(items ? { items: Items ?? {} } : {}) };
          }),
        }));
        return okLean({ entity, id, sections });
      } catch (e) {
        return fail(e);
      }
    },
  );

  const itemLocator = {
    entity: entityArg,
    id: z.number().int().positive().describe("The job/quote Simpro ID."),
    sectionID: z.number().int().positive().describe("Section ID (from get_breakdown)."),
    costCenterID: z.number().int().positive().describe("Cost center ID (from get_breakdown)."),
    itemType: z
      .enum(ITEM_TYPE_KEYS)
      .describe("catalog | labor | oneOff | prebuild | serviceFee | stock | asset."),
  };

  server.registerTool(
    "list_line_items",
    {
      title: "List Line Items",
      description:
        "List line items of one type within a cost center. Get sectionID + costCenterID from get_breakdown (its itemCounts tells you which types are populated, so you can call this once per populated type instead of probing all seven). Returns { rows, _lean }: each row's SellPrice is slimmed to ExTax (+ ExDiscountExTax only when a discount applies) and the _lean note on the result states the leaning rule. " +
        "Valid `columns` vary by type and an unknown one is a 422 (there is no CostPrice; a line's cost is EstimatedCost). " +
        "describe_operation with GET on the cost center's item collection lists the valid columns for any type.",
      inputSchema: { ...itemLocator, columns: z.array(z.string()).optional() },
      annotations: { title: "List Line Items", readOnlyHint: true },
    },
    async ({ entity, id, sectionID, costCenterID, itemType, columns }) => {
      try {
        const path = itemCollectionPath(entity, id, sectionID, costCenterID, itemType as ItemType);
        return okLean(await client.get(path, { columns }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // Fresh schemas per branch: shared ones serialize as a $ref that some MCP clients don't resolve.
  const lineItemType = () => z.enum(ITEM_TYPE_KEYS).describe(itemLocator.itemType.description ?? "");
  const lineItemFields = () => z.record(z.unknown());
  const lineItemOp = z.discriminatedUnion("op", [
    z.object({
      op: z.literal("add"),
      itemType: lineItemType(),
      fields: lineItemFields().describe("Body for the new line (required fields per type are in the tool description)."),
    }),
    z.object({
      op: z.literal("update"),
      itemType: lineItemType(),
      itemID: z.number().int().positive().describe("The line's own ID (from list_line_items), not its catalog/anchor ID."),
      fields: lineItemFields().describe("Fields to change (PATCH: omit what stays the same)."),
    }),
    z.object({
      op: z.literal("delete"),
      itemType: lineItemType(),
      itemID: z.number().int().positive().describe("The line's own ID (from list_line_items)."),
    }),
  ]);

  server.registerTool(
    "manage_line_items",
    {
      title: "Manage Line Items",
      description:
        "Add, update and delete line items in one cost center, one or many per call. Each op names its own itemType and the tool routes it to the right Simpro collection. " +
        "Ops run in the order given; consecutive adds of the same type are sent as one bulk request. " +
        "add — required fields per type: " +
        ITEM_TYPE_KEYS.map((k) => `${k}: ${ITEM_TYPES[k].createHint}`).join("; ") +
        ". The catalog/labor/prebuild anchor fields take a numeric ID; find_materials resolves a catalog or prebuild ID from a name or part number. " +
        "update — PATCH by the line's own itemID (from list_line_items); only the fields you pass change. Qty via fields.Total ({ Qty }); a oneOff's sell price via fields.SellPriceExDiscount (number), never SellPrice: { ExTax }. " +
        "To change which catalog/labor/prebuild a line points at, delete it and add the new one. " +
        "asset lines can't be updated and stock lines can't be deleted; such ops are rejected before anything is written. " +
        "To raise the qty of a line that already exists, update its Total.Qty rather than adding the item again (an add always creates a new line). " +
        "Simpro has no transactions: on the first failed op the rest are skipped (unless continueOnError) and the result lists what was done, what failed and what was skipped. " +
        "Single adds, updates and deletes carry `resourceId`; bulk adds return a per-item status tally.",
      inputSchema: {
        entity: itemLocator.entity,
        id: itemLocator.id,
        sectionID: itemLocator.sectionID,
        costCenterID: itemLocator.costCenterID,
        ops: z.array(lineItemOp).min(1).max(MAX_LINE_ITEM_OPS).describe(`Line item operations, run in order (max ${MAX_LINE_ITEM_OPS}).`),
        continueOnError: z.boolean().optional().describe("Keep running later ops after one fails. Default false (stop at the first failure)."),
      },
      annotations: { title: "Manage Line Items", readOnlyHint: false, destructiveHint: true },
    },
    async ({ entity, id, sectionID, costCenterID, ops, continueOnError }) => {
      const invalid = validateLineItemOps(ops as LineItemOp[]);
      if (invalid.length) return fail(new Error(`Nothing was written.\n${invalid.join("\n")}`));

      const steps = planLineItemOps(ops as LineItemOp[]);
      const results: Record<string, unknown>[] = [];
      let failed = 0;
      let skipped = 0;
      for (const step of steps) {
        const summary: Record<string, unknown> = { ops: step.indexes, op: step.op, itemType: step.itemType };
        if ("itemID" in step) summary.itemID = step.itemID;
        if (failed && !continueOnError) {
          skipped += step.indexes.length;
          results.push({ ...summary, status: "skipped" });
          continue;
        }
        const collection = itemCollectionPath(entity, id, sectionID, costCenterID, step.itemType);
        try {
          if (step.op === "add" && step.bodies.length > 1) {
            const bulk = summarizeBulk(
              await client.post(`${collection}multiple/`, step.bodies),
            ) as { bulk?: { failed: number } };
            const bad = bulk.bulk?.failed ?? 0;
            if (bad) failed += bad;
            results.push({ ...summary, status: bad ? "failed" : "ok", result: bulk });
            continue;
          }
          const [method, path, body] =
            step.op === "add"
              ? (["POST", collection, step.bodies[0]] as const)
              : step.op === "update"
                ? (["PATCH", `${collection}${step.itemID}`, step.fields] as const)
                : (["DELETE", `${collection}${step.itemID}`, undefined] as const);
          const { resourceId } = await client.requestWithReceipt(method, path, { body });
          results.push({ ...summary, status: "ok", ...(resourceId !== undefined ? { resourceId } : {}) });
        } catch (e) {
          failed += step.indexes.length;
          results.push({ ...summary, status: "failed", error: fail(e).content[0].text });
        }
      }
      return ok({ total: ops.length, failed, skipped, results });
    },
  );

  server.registerTool(
    "convert_work",
    {
      title: "Convert / Create From",
      description:
        "Run a Simpro conversion: convert a lead to a quote, a quote to a job, or create a job from a recurring job. " +
        "No other fields are needed. (These are not in the API catalog, so this is the only way to reach them.)",
      inputSchema: {
        from: z
          .enum(["lead", "quote", "recurringJob"])
          .describe("Source type: 'lead' → quote, 'quote' → job, 'recurringJob' → job."),
        id: z.number().int().positive().describe("ID of the source lead / quote / recurring job."),
      },
      annotations: { title: "Convert / Create From", readOnlyHint: false },
    },
    async ({ from, id }) => {
      try {
        const path =
          from === "lead"
            ? `leads/${id}/convert/`
            : from === "quote"
              ? `quotes/${id}/convert/`
              : `recurringJobs/${id}/createJob/`;
        return await okWrite("POST", path);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "duplicate_work",
    {
      title: "Duplicate Work (Job/Quote)",
      description:
        "Clone a job or quote — including its sections, cost centers and line items — into a new one. " +
        "Optionally reassign to a different customer. Reads the source in one call and recreates it.",
      inputSchema: {
        entity: entityArg,
        id: z.number().int().positive().describe("Source job/quote ID to clone."),
        intoCustomer: z.number().int().positive().optional().describe("Customer ID for the copy (defaults to the source's customer)."),
        name: z.string().optional().describe("Name for the copy (defaults to source name + ' (copy)')."),
      },
      annotations: { title: "Duplicate Work", readOnlyHint: false },
    },
    async ({ entity, id, intoCustomer, name }) => {
      try {
        const b = base(entity);
        const src = (await client.get(`${b}/${id}`, { display: "all" })) as Record<string, any>;
        const body = buildDuplicateBody(entity, src, { intoCustomer, name });
        return await okWrite("POST", `${b}/`, { body });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "start_attachment_upload",
    {
      title: "Start Attachment Upload",
      description:
        "Begin attaching a file (up to 50 MB) to a quote or job in pieces. Use this for any file over about 700 KB: Simpro's " +
        "attachment route takes the whole file base64-encoded in one request, which is too large for one connector call beyond that size. " +
        "Order: start_attachment_upload once → upload_attachment_chunk per piece (any order, resends overwrite) → finish_attachment_upload → poll attachment_upload_status until done/failed. " +
        `Split the raw file into ${CHUNK_MAX_BYTES} bytes per chunk or fewer (before base64); a small file is just one chunk. ` +
        `Allowed types: ${ALLOWED_EXTENSIONS.join(" ")}. The file is posted byte-for-byte under its original name.`,
      inputSchema: {
        entity: entityArg,
        id: z.number().int().positive().describe("Quote or job ID to attach to."),
        filename: z.string().min(1).describe("Original filename including extension; spaces and brackets are kept."),
        size: z.number().int().positive().describe("Total file size in bytes."),
        sha256: z.string().describe("Hex SHA-256 of the whole file, checked after joining."),
        chunks: z.number().int().positive().describe(`Number of chunks the file will be sent in (each at most ${CHUNK_MAX_BYTES} bytes decoded).`),
      },
      annotations: { title: "Start Attachment Upload", readOnlyHint: false },
    },
    async ({ entity, id, filename, size, sha256, chunks }) => {
      try {
        validateStart({ filename, size, sha256, chunks }, cfg.maxUploadBytes);
        try {
          await client.get(`${base(entity)}/${id}`, { columns: "ID" });
        } catch (e) {
          if (e instanceof SimproError && e.status === 404) throw new UploadError(`${entity} ${id} does not exist in Simpro.`);
          throw e;
        }
        return ok(uploads.start({ entity, id, filename, size, sha256, chunks }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "upload_attachment_chunk",
    {
      title: "Upload Attachment Chunk",
      description:
        "Send one piece of a file started with start_attachment_upload. Indexes are 0-based, may arrive in any order or in parallel, and resending an index overwrites it. " +
        "Returns how many of the chunks have arrived.",
      inputSchema: {
        uploadId: z.string().min(1).describe("uploadId from start_attachment_upload."),
        index: z.number().int().min(0).describe("0-based chunk index."),
        data: z.string().min(1).describe(`Base64 of this chunk's raw bytes (at most ${CHUNK_MAX_BYTES} bytes decoded).`),
      },
      annotations: { title: "Upload Attachment Chunk", readOnlyHint: false, idempotentHint: true },
    },
    async ({ uploadId, index, data }) => {
      try {
        return ok(uploads.putChunk(uploadId, index, data));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "finish_attachment_upload",
    {
      title: "Finish Attachment Upload",
      description:
        "Join and verify (size, SHA-256) all chunks of an upload, then attach the file to the quote/job in the background. " +
        "Returns status 'working' (poll attachment_upload_status), or 'failed' with nothing posted if verification fails. Refused while chunks are missing (names them). Safe to call again — never attaches twice.",
      inputSchema: {
        uploadId: z.string().min(1).describe("uploadId from start_attachment_upload."),
      },
      annotations: { title: "Finish Attachment Upload", readOnlyHint: false },
    },
    async ({ uploadId }) => {
      try {
        return ok(uploads.finish(uploadId, client));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "attachment_upload_status",
    {
      title: "Attachment Upload Status",
      description:
        "Status of a chunked attachment upload: collecting (with chunks received), working, done (with Simpro's string attachmentId), or failed (with the reason).",
      inputSchema: {
        uploadId: z.string().min(1).describe("uploadId from start_attachment_upload."),
      },
      annotations: { title: "Attachment Upload Status", readOnlyHint: true },
    },
    async ({ uploadId }) => {
      try {
        return ok(uploads.status(uploadId));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "find_customers",
    {
      title: "Find Customers",
      description:
        "Search or browse customers (both company and individual). Pass `keywords` for free-text matching on customer name " +
        "(company name, or given/family name when type='individual') — handled internally as wildcard filters. " +
        "Use `filters` for column filters (supports operators like gt()/between()/in() and nested columns). " +
        "Returns ID, name, type, and the _href that identifies whether each is a company or individual.",
      inputSchema: {
        keywords: z.string().optional().describe("Free-text to match on customer name. Mapped to a wildcard name filter internally (CompanyName, or GivenName/FamilyName for individuals)."),
        type: z.enum(["company", "individual", "all"]).optional().describe("Restrict to one customer kind (default all)."),
        filters: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Column filters { Column: value }."),
        matchScheme: matchSchemeArg,
        columns: z.array(z.string()).optional(),
        page: z.number().int().positive().optional(),
        pageSize: z.number().int().positive().max(250).optional().describe(`Rows per page (max 250; defaults to ${defaultPageSize}). Larger pages risk exceeding the response budget.`),
      },
      annotations: { title: "Find Customers", readOnlyHint: true },
    },
    async ({ keywords, type, filters, matchScheme, columns, page, pageSize }) => {
      try {
        const seg = type === "company" ? "customers/companies/" : type === "individual" ? "customers/individuals/" : "customers/";
        // The individuals list has no CompanyName column; it matches on given/family name.
        const nameCols = type === "individual" ? ["GivenName", "FamilyName"] : ["CompanyName"];
        return okLean(
          await client.getList(seg, {
            columns: columns ?? ["ID", "CompanyName", "GivenName", "FamilyName", "_href"],
            page,
            pageSize: pageSize ?? defaultPageSize,
            ...buildSearchQuery(keywords, nameCols, filters, matchScheme),
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_customer",
    {
      title: "Get Customer",
      description:
        "Get one customer's full details by ID, automatically resolving whether it is a company or an individual " +
        "(the bare /customers/{id} route errors with the correct _href, which this follows).",
      inputSchema: {
        id: z.number().int().positive().describe("Customer ID."),
        columns: z.array(z.string()).optional(),
      },
      annotations: { title: "Get Customer", readOnlyHint: true },
    },
    async ({ id, columns }) => {
      try {
        try {
          return okLean(await client.get(`customers/companies/${id}`, { columns }));
        } catch (e1) {
          if (e1 instanceof SimproError && e1.status === 404) {
            return okLean(await client.get(`customers/individuals/${id}`, { columns }));
          }
          throw e1;
        }
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "find_materials",
    {
      title: "Find Materials (catalog + prebuilds)",
      description:
        "Resolve a product name/part number to an ID across BOTH the catalog (stocked materials/parts) AND prebuilds " +
        "(assemblies) in one call, then say which it is. A name like '100mm solid centre line' could be either, and " +
        "nothing in the name declares it — so this searches both master collections and tags each match with its " +
        "`type` ('catalog' or 'prebuild'). That type tells you which line-item endpoint to POST to and which anchor " +
        "field to use: type 'catalog' -> .../costCenters/{id}/catalogs/ with body { Catalog: <id>, ... }; type " +
        "'prebuild' -> .../prebuilds/ with body { Prebuild: <id>, ... }. If a term matches in both, you have a genuine " +
        "ambiguity (a part and an assembly sharing a name) - surface both to the user. Returns id, name, partNo, type " +
        "and group per match, plus pricing: catalog matches carry tradePrice, sellPrice and uom (uom is null when " +
        "unspecified upstream — a note lists those ids); prebuild matches carry totalEx (the assembly's standard " +
        "build price ex-tax). The same item can appear several times under the SAME name/PartNo in different groups - " +
        "when that happens, the group is what distinguishes them; surface the options and let the user pick rather than " +
        "grabbing the first.",
      inputSchema: {
        searchText: z
          .string()
          .describe("Wildcard search term — matched against name and part number on both collections (Simpro's `searchText` param)."),
        includeArchived: z.boolean().optional().describe("Include archived records (default false)."),
        pageSize: z
          .number()
          .int()
          .positive()
          .max(250)
          .optional()
          .describe(`Max rows per collection (max 250; defaults to ${defaultPageSize}).`),
      },
      annotations: { title: "Find Materials", readOnlyHint: true },
    },
    async ({ searchText, includeArchived, pageSize }) => {
      try {
        // `searchText` is Simpro's wildcard search across name/part number — token-aware, so it beats
        // our buildSearchQuery %...% substring (which needs the words contiguous). Not in the Swagger
        // spec (so not in our index), but live-verified 2026-06-23: filters on both catalogs/ and
        // prebuilds/, junk term -> [], composes with Archived=false.
        // TradePrice/SellPrice/UOM (catalog) and TotalEx (prebuild) aren't advertised on the list
        // endpoints' default columns, but — like Group — are accepted when selected explicitly
        // (live-verified 2026-06-23). UOM is an object {ID,Name} or null; TotalEx is the prebuild's
        // standard build price ex-tax. So no per-id follow-up GET is needed for price.
        const common = ["ID", "Name", "PartNo", "Group"];
        const base = { searchText, pageSize: pageSize ?? defaultPageSize };
        const archived = includeArchived ? {} : { Archived: false };

        const [catalogs, prebuilds] = await Promise.all([
          client.getList("catalogs/", { ...base, ...archived, columns: [...common, "TradePrice", "SellPrice", "UOM"] }),
          client.getList("prebuilds/", { ...base, ...archived, columns: [...common, "TotalEx"] }),
        ]);

        const tag = (rows: unknown[], type: "catalog" | "prebuild") =>
          (rows as Array<Record<string, unknown>>).map((r) => {
            const m: Record<string, unknown> = { id: r.ID, name: r.Name, partNo: r.PartNo, type };
            if (r.Group !== undefined && r.Group !== null) m.group = r.Group;
            if (type === "catalog") {
              m.tradePrice = r.TradePrice;
              m.sellPrice = r.SellPrice;
              m.uom = r.UOM ?? null;
            } else {
              m.totalEx = r.TotalEx;
            }
            return m;
          });

        const matches = [...tag(catalogs.rows, "catalog"), ...tag(prebuilds.rows, "prebuild")];

        const nullUomIds = matches
          .filter((m) => m.type === "catalog" && (m.uom === null || m.uom === undefined))
          .map((m) => m.id);

        // Flag when several matches share a name within a type — the group is what tells them apart.
        const byName = new Map<string, number>();
        for (const m of matches) {
          const key = `${m.type}|${String(m.name).trim().toLowerCase()}`;
          byName.set(key, (byName.get(key) ?? 0) + 1);
        }
        const hasCollision = [...byName.values()].some((n) => n > 1);

        const notes: string[] = [];
        if (catalogs.rows.length && prebuilds.rows.length)
          notes.push("Matched in BOTH collections (catalog material and prebuild assembly) — confirm which the user means before adding.");
        else if (matches.length === 0)
          notes.push("No matches in either collection. Loosen the search term (a single distinctive word often beats a full phrase).");
        if (hasCollision)
          notes.push("Several matches share a name — they differ by `group`. Surface the options and let the user pick the right one rather than assuming the first.");
        if (nullUomIds.length)
          notes.push(`UOM (unit of measure) is null in Simpro's catalog for ${nullUomIds.length} match(es) (IDs: ${nullUomIds.join(", ")}). The unit is unspecified upstream — don't assume one.`);

        return okLean({ matches, note: notes.length ? notes.join(" ") : undefined });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "customer_aged_receivables",
    {
      title: "Customer Aged Receivables",
      description:
        "Aged receivables for one customer: unpaid invoices bucketed into current / 1-30 / 31-60 / 61-90 / 90+ days " +
        "overdue, with the outstanding balance per bucket and total. Uses each invoice's due date and balance directly.",
      inputSchema: {
        customerID: z.number().int().positive().describe("Customer ID."),
        asOf: z.string().optional().describe("Reference date YYYY-MM-DD (defaults to today)."),
      },
      annotations: { title: "Customer Aged Receivables", readOnlyHint: true },
    },
    async ({ customerID, asOf }) => {
      try {
        const { rows } = await fetchProjected(
          client,
          "invoices/",
          ["ID", "DateIssued", "PaymentTerms.DueDate", "PaymentTerms.Days", "Total.BalanceDue"],
          { filters: { "Customer.ID": customerID, IsPaid: false }, allPages: true },
        );
        return ok(ageReceivables(rows, asOf, customerID));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "staff_schedule",
    {
      title: "Staff Schedule",
      description:
        "One staff member's schedule over a date range: every booking (date, hours, blocks, reference) plus total " +
        "scheduled hours. Read-only.",
      inputSchema: {
        staffID: z.number().int().positive().describe("Employee/staff ID (Staff.ID on schedules)."),
        dateFrom: z.string().describe("Start date YYYY-MM-DD (inclusive)."),
        dateTo: z.string().describe("End date YYYY-MM-DD (inclusive)."),
      },
      annotations: { title: "Staff Schedule", readOnlyHint: true },
    },
    async ({ staffID, dateFrom, dateTo }) => {
      try {
        const { rows } = await fetchProjected(
          client,
          "schedules/",
          ["ID", "Date", "TotalHours", "Reference", "Blocks"],
          { filters: { "Staff.ID": staffID, Date: `between(${dateFrom},${dateTo})` }, allPages: true },
        );
        const totalHours = rows.reduce((s, r) => s + (Number(r.TotalHours) || 0), 0);
        return ok({ staffID, dateFrom, dateTo, count: rows.length, totalHours, schedules: rows });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "customer_overview",
    {
      title: "Customer Overview",
      description:
        "A one-call profile of a customer: their details, open quotes, open jobs, and outstanding receivables total. " +
        "Collapses several reads into a single response.",
      inputSchema: {
        customerID: z.number().int().positive().describe("Customer ID."),
      },
      annotations: { title: "Customer Overview", readOnlyHint: true },
    },
    async ({ customerID }) => {
      try {
        // Sequential to respect the shared rate limit; each is one cheap call.
        const customer = await getCustomerAny(client, customerID);
        const workFields = ["ID", "Name", "Stage", "Status", "Total.ExTax", "DateIssued"];
        const openQuotes = await fetchProjected(client, "quotes/", workFields, {
          filters: { "Customer.ID": customerID, Stage: "in(InProgress,Complete)" },
          pageSize: 50,
        });
        const openJobs = await fetchProjected(client, "jobs/", workFields, {
          filters: { "Customer.ID": customerID, Stage: "in(Pending,Progress)" },
          pageSize: 50,
        });
        const { rows: unpaid } = await fetchProjected(client, "invoices/", ["ID", "Total.BalanceDue"], {
          filters: { "Customer.ID": customerID, IsPaid: false },
          allPages: true,
        });
        const outstanding = unpaid.reduce((s, i) => s + (Number((i.Total as any)?.BalanceDue) || 0), 0);
        return ok({
          customer,
          openQuotes,
          openJobs,
          receivables: { unpaidInvoices: unpaid.length, outstandingBalance: round2(outstanding) },
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "find_operation",
    {
      title: "Find Simpro Operation",
      description:
        "Search the full Simpro REST API (~1,300 endpoints; documented at https://developer.simprogroup.com/apidoc/) by intent to find the right operation when no dedicated tool fits — e.g. customers, invoices, catalogues, inventory, contacts, notes, attachments, updating/deleting a job/quote (for line items use manage_line_items). Returns matching endpoints with method, path, and parameters; the top results also carry a schema preview (writes: required body fields; GET: available columns). For the full body schema or full column list of any endpoint, call describe_operation. simpro_api_get runs GET endpoints; simpro_api_post / simpro_api_put / simpro_api_delete run the matching write methods. " +
        "Pre-builds come in two kinds with separate routes, set price (prebuilds/setPrice/{id}) and standard price (prebuilds/standardPrice/{id}); each ID answers on only one. The generic prebuilds/ list shows which via its `_href` column (request columns 'ID,Name,_href').",
      inputSchema: {
        query: z.string().describe("What you want to do, in keywords, e.g. 'list customer contacts' or 'update a quote'."),
        method: z
          .enum(["GET", "POST", "PATCH", "PUT", "DELETE"])
          .optional()
          .describe("Optional: restrict to one HTTP method."),
        limit: z.number().int().positive().max(40).optional().describe("Max results (default 10)."),
      },
      annotations: { title: "Find Simpro Operation", readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, method, limit }) => {
      try {
        const found = searchEndpoints(query, { method, limit: limit ?? 10 });
        // Schema preview rides only the top few hits — the agent acts on these, and
        // attaching it to every result would bloat a search the agent mostly scrolls past.
        // For a lower-ranked pick, describe_operation fetches the same detail on demand.
        const PREVIEW_COUNT = 3;
        const results = found.map((e, i) => {
          const base = { method: e.method, path: e.path, summary: e.summary, params: e.params };
          if (i >= PREVIEW_COUNT) return base;
          if (e.bodyRequired) return { ...base, requiredFields: e.bodyRequired };
          if (e.columns) return { ...base, columns: Object.keys(e.columns) };
          return base;
        });
        if (results.length === 0) return ok({ results: [], note: "No matches. Try different keywords." });
        return ok({
          results,
          note: "Call simpro_api_get (GET) or simpro_api_post / simpro_api_put / simpro_api_delete (writes) with the chosen path. {companyID} is filled automatically. Top results show requiredFields (writes) or columns (GET); for the full schema of any endpoint — including all optional body fields — call describe_operation with its method + path.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "describe_operation",
    {
      title: "Describe Simpro Operation",
      description:
        "Get the full schema for one Simpro endpoint (method + path from find_operation). For a write (POST/PUT/PATCH) returns the complete request-body schema — every field with type, required flag, enum values, and ID-hints — so you can build the body without guessing. For a GET returns the full column list of the resource. Use this when find_operation's top-result preview wasn't enough, or you picked a lower-ranked endpoint that had no inline schema.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).describe("HTTP method of the endpoint."),
        path: z.string().describe("Endpoint path from find_operation (templated like .../quotes/{quoteID} or a concrete path — {companyID} and ids are matched leniently)."),
      },
      annotations: { title: "Describe Simpro Operation", readOnlyHint: true, openWorldHint: true },
    },
    async ({ method, path }) => {
      try {
        const ep = getEndpoint(method, path);
        if (!ep) {
          const near = closestRoutes(method, path);
          return fail(
            new Error(
              `No endpoint found for ${method} ${path}.` +
                (near.length ? ` Closest ${method} routes: ${near.join(", ")}.` : "") +
                " Use find_operation to get the exact method + path.",
            ),
          );
        }
        const out: Record<string, unknown> = { method: ep.method, path: ep.path, summary: ep.summary };
        if (ep.body !== undefined) out.body = ep.body;
        if (ep.columns) out.columns = ep.columns;
        if (ep.body === undefined && !ep.columns) {
          out.note = "This endpoint has no body schema or column list in the index (e.g. DELETE, or a path-only operation). Its params: " + (ep.params?.join(", ") ?? "none");
        }
        return ok(out);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "simpro_api_get",
    {
      title: "Simpro API GET",
      description:
        "Read from any Simpro REST API GET endpoint (paths from find_operation; full reference at https://developer.simprogroup.com/apidoc/). {companyID} is auto-filled; other {placeholders} take real IDs. Covers reads in areas without a dedicated tool. " +
        "Free-text filtering on a Simpro list is NOT done via the `search` param — that param only takes 'all'/'any' (a match scheme); passing words 422s. To match free text, use a wildcard column filter: query: { Name: '%court%' }. " +
        "For convenience pass `keywords` + `keywordColumns` and this wraps each column in %…% for you (e.g. keywords:'court', keywordColumns:['Name'] → Name='%court%'). You must name the column(s) — the right one varies by resource (Name, CompanyName, GivenName/FamilyName, PartNo, Description, …); inspect a row or find_operation params if unsure. Not every column is filterable. " +
        "Use simpro_api_post / simpro_api_put / simpro_api_delete for writes.",
      inputSchema: {
        path: z
          .string()
          .trim()
          .min(1, "path is empty. Use find_operation to get the endpoint path.")
          .describe("Endpoint path. Catalog form with {companyID} (auto-filled) or a concrete /api/v1.0/... path."),
        query: z.record(z.unknown()).optional().describe("Query params (columns, pageSize, page, orderby, and exact/operator column filters like { Total: 'gt(5000)' }). `search` here is the match scheme 'all'/'any' only, not free text."),
        keywords: z.string().optional().describe("Free text to match. Requires keywordColumns. Wrapped as %keywords% on each named column; multiple columns default to OR (search=any)."),
        keywordColumns: z.array(z.string()).optional().describe("Column(s) the keywords match against — e.g. ['Name'] or ['GivenName','FamilyName']. You pick these; the passthrough can't know a resource's 'name' column."),
      },
      annotations: { title: "Simpro API GET", readOnlyHint: true, openWorldHint: true },
    },
    async ({ path, query, keywords, keywordColumns }) => {
      try {
        if (keywords?.trim() && !(keywordColumns && keywordColumns.length)) {
          return fail(new Error("keywords requires keywordColumns — name the column(s) to match (e.g. ['Name']). The passthrough can't guess a resource's name column."));
        }
        const q = buildSearchQuery(keywords, keywordColumns ?? [], query as Record<string, unknown> | undefined, undefined);
        return okLean(await client.request("GET", normalizePath(path), { query: q }));
      } catch (e) {
        return fail(e, { method: "GET", path });
      }
    },
  );

  server.registerTool(
    "query_collection",
    {
      title: "Query Collection (multi-record field select)",
      description:
        "Fetch many records from any Simpro list (GET-multiple) endpoint and return ONLY the dot-path fields you ask for — across nested levels. Built for cross-record rollups (e.g. cost-centre $ totals over many jobs) without dumping whole records to the model. " +
        "Each `field` is the full path from the record root, e.g. 'ID', 'Total.ExTax', 'Sections.CostCenters.Total.ExTax'. " +
        "Simpro can only select TOP-LEVEL columns, so this requests those (with display=all to expand them) and narrows to your exact sub-paths itself. " +
        "When fields cross an array (e.g. Sections→CostCenters), the record FANS OUT to one row per leaf-most element, with the record-level fields repeated on each row. Rows are returned NESTED (the path is rebuilt into a tree), so a shared prefix like Sections.CostCenters is stated once per row, not on every key; a job 'ID' at the root and a cost-centre 'ID' under Sections.CostCenters sit at different depths and never collide. Each array level the fields descend through also carries its own 'ID' automatically (where the elements have one), so every fanned-out level is identifiable. " +
        "A field that NAMES an array directly (e.g. 'Blocks') returns that whole array as the value — no fan-out; only naming a sub-path INTO it (e.g. 'Blocks.Hrs') fans out one row per element. " +
        "Returns one page as { collection, rows, pagination }; `collection` echoes the queried path so you know what the root 'ID' on each row identifies (e.g. collection 'jobs' → the root 'ID' is the job's). Request later pages with `page`. " +
        "Note: display=all expands sell-side values (Total/SellPrice/Claimed) at every level, but the cost/margin `Totals` object is NOT expandable into nested arrays — it exists only at the record top level (job 'Totals') and on the cost-centre resource itself. For per-cost-centre cost/margin you must read each cost centre directly.",
      inputSchema: {
        path: z
          .string()
          .describe("A collection (GET-multiple) path, e.g. 'jobs/', 'quotes/', 'customers/companies/', 'catalogs/'. {companyID} is auto-filled."),
        fields: z
          .array(z.string())
          .min(1)
          .describe("Full dot-paths to return, from the record root. Nested + array-crossing allowed, e.g. ['ID','Name','Sections.CostCenters.Name','Sections.CostCenters.Total.ExTax']. The deepest array crossed defines the row granularity."),
        filters: z
          .record(z.unknown())
          .optional()
          .describe("Server-side column filters { Column: value }; supports operators (gt(), between(), in()) and nested columns (Customer.ID). Property names are case-sensitive (ID, not id)."),
        keywords: z.string().optional().describe("Free text to match. Requires keywordColumns. Wrapped as %keywords% on each named column."),
        keywordColumns: z.array(z.string()).optional().describe("Column(s) the keywords match against (e.g. ['Name']). You pick these; the right one varies by resource."),
        matchScheme: matchSchemeArg,
        page: z.number().int().positive().optional(),
        pageSize: z.number().int().positive().max(250).optional().describe(`Records (not rows) per page (max 250; defaults to ${defaultPageSize}). One record can fan out to many rows.`),
        orderby: z.array(z.string()).optional().describe("e.g. ['-ID'] for newest first."),
      },
      annotations: { title: "Query Collection", readOnlyHint: true, openWorldHint: true },
    },
    async ({ path, fields, filters, keywords, keywordColumns, matchScheme, page, pageSize, orderby }) => {
      try {
        if (keywords?.trim() && !(keywordColumns && keywordColumns.length)) {
          return fail(new Error("keywords requires keywordColumns — name the column(s) to match (e.g. ['Name'])."));
        }
        const q: Record<string, unknown> = {
          columns: columnsForFields(fields),
          display: "all",
          page,
          pageSize: pageSize ?? defaultPageSize,
          orderby,
          ...buildSearchQuery(keywords, keywordColumns ?? [], filters as Record<string, unknown> | undefined, matchScheme),
        };
        const { rows, pagination } = await client.getList(normalizePath(path), q);
        const collection = path.replace(/^\/+|\/+$/g, "");
        return okLean({ collection, rows: selectRecords(rows, fields), pagination });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "describe_collection",
    {
      title: "Describe Collection Fields",
      description:
        "Discover the selectable dot-path fields for query_collection on a given collection. Fetches one live record (display=all) and returns its full queryable model: every field as a full dot-path from the record root (e.g. 'Sections.CostCenters.Total.ExTax'), its type, and an `array: true` flag where a path passes THROUGH an array (so selecting a sub-path fans out one row per element). An array node itself (e.g. 'Blocks', type:'array') can be selected directly to get the whole array as one value; selecting a sub-path into it (e.g. 'Blocks.Hrs') is what fans out. Call this first when you don't know a collection's field paths, then pass the ones you want to query_collection. " +
        "Example values are OMITTED by default to stay lean — pass values:true to include a sample value per leaf. The jobs/ model is large (~260 paths); scope it with `only` (e.g. ['Sections','Totals']) to the subtrees you care about. " +
        "Reflects the live data shape, not a static spec — fields absent from a sample record (empty arrays, null objects) won't appear.",
      inputSchema: {
        path: z
          .string()
          .describe("A collection (GET-multiple) path, e.g. 'jobs/', 'quotes/', 'customers/companies/', 'catalogs/'. {companyID} is auto-filled."),
        only: z
          .array(z.string())
          .optional()
          .describe("Restrict discovery to these TOP-LEVEL columns (e.g. ['Sections','Totals']). Omit to return every column — useful to trim the large jobs/ model to just the subtrees you'll query."),
        values: z
          .boolean()
          .optional()
          .describe("Include a sample value per leaf field. Default false (examples roughly double the response). Turn on when you need to see real data shapes."),
        filters: z
          .record(z.unknown())
          .optional()
          .describe("Optional column filters to pick WHICH record is sampled (e.g. { Stage: 'Progress' } to sample a record likely to have populated nested data). Property names are case-sensitive."),
      },
      annotations: { title: "Describe Collection Fields", readOnlyHint: true, openWorldHint: true },
    },
    async ({ path, only, values, filters }) => {
      try {
        // A collection GET with display=all only returns the default list columns — the full nested
        // tree (Sections, Totals, …) is NOT expanded there. So sample one ID from the collection, then
        // GET that record BY ID, where display=all returns the complete shape.
        const coll = normalizePath(path);
        const { rows } = await client.getList(coll, { columns: ["ID"], pageSize: 1, ...(filters ?? {}) });
        const sample = rows[0] as { ID?: number } | undefined;
        if (!sample?.ID) {
          return ok({ path, fields: [], note: "No records matched — cannot infer fields. Loosen filters or pick a collection with data." });
        }
        const record = await client.get(normalizePath(`${coll.replace(/\/$/, "")}/${sample.ID}`), { display: "all" });
        return okLean({
          path,
          sampledId: sample.ID,
          fields: describeRecord(record, { only, values }),
          note: "Field paths from a live sample record. Paths flagged array:true fan out to one row per element in query_collection. Example values omitted (pass values:true to include them). Fields absent from this sample (empty arrays/null objects) won't appear.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  const writeBody = z
    .union([z.record(z.unknown()), z.array(z.record(z.unknown()))])
    .optional()
    .describe(
      "JSON body. An object for a single record, or an ARRAY for Simpro's bulk routes " +
        "(append '/multiple/' to a collection path, e.g. .../costCenters/multiple/ — POST array to create many, " +
        "PATCH array with an `ID` per item to update many). Bulk responses return per-item {status, headers} " +
        "with the new Resource-ID in headers (bodies are not echoed); add a `BatchID` per item to correlate.",
    );

  const writePath = z
    .string()
    .trim()
    .min(1, "path is empty. Use find_operation to get the endpoint path.")
    .describe("Endpoint path. Catalog form with {companyID} (auto-filled) or a concrete /api/v1.0/... path.");

  server.registerTool(
    "simpro_api_post",
    {
      title: "Simpro API POST / PATCH (write)",
      description:
        "Create or partially update via the Simpro REST API (POST and PATCH; paths from find_operation; full reference at https://developer.simprogroup.com/apidoc/). {companyID} is auto-filled; other {placeholders} take real IDs. Mutates real data in the connected Simpro account. The result carries `resourceId` — the id Simpro assigned/updated — so a retry that lost the response can confirm-by-id instead of re-creating. Use simpro_api_put to replace, simpro_api_delete to remove, simpro_api_get to read.",
      inputSchema: {
        method: z.enum(["POST", "PATCH"]).optional().describe("POST (create) or PATCH (partial update). Defaults to POST."),
        path: writePath,
        query: z.record(z.unknown()).optional().describe("Query-string params."),
        body: writeBody,
      },
      annotations: { title: "Simpro API POST / PATCH", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ method, path, query, body }) => {
      try {
        return await okWrite(method ?? "POST", normalizePath(path), { query, body });
      } catch (e) {
        return fail(e, { method: method ?? "POST", path });
      }
    },
  );

  server.registerTool(
    "simpro_api_put",
    {
      title: "Simpro API PUT (write)",
      description:
        "Replace a record via the Simpro REST API (PUT; paths from find_operation; full reference at https://developer.simprogroup.com/apidoc/). {companyID} is auto-filled; other {placeholders} take real IDs. Mutates real data in the connected Simpro account. Use simpro_api_post for create / partial update, simpro_api_delete to remove, simpro_api_get to read.",
      inputSchema: {
        path: writePath,
        query: z.record(z.unknown()).optional().describe("Query-string params."),
        body: writeBody,
      },
      annotations: { title: "Simpro API PUT", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ path, query, body }) => {
      try {
        return await okWrite("PUT", normalizePath(path), { query, body });
      } catch (e) {
        return fail(e, { method: "PUT", path });
      }
    },
  );

  server.registerTool(
    "simpro_api_delete",
    {
      title: "Simpro API DELETE (write)",
      description:
        "Delete a record via the Simpro REST API (DELETE; paths from find_operation; full reference at https://developer.simprogroup.com/apidoc/). {companyID} is auto-filled; other {placeholders} take real IDs. Permanently removes real data from the connected Simpro account. Use simpro_api_get to read, simpro_api_post / simpro_api_put to write.",
      inputSchema: {
        path: writePath,
        query: z.record(z.unknown()).optional().describe("Query-string params."),
      },
      annotations: { title: "Simpro API DELETE", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ path, query }) => {
      try {
        return ok(await client.request("DELETE", normalizePath(path), { query }));
      } catch (e) {
        return fail(e, { method: "DELETE", path });
      }
    },
  );
}

export function normalizePath(path: string): string {
  const p = path.trim();
  const m = p.match(/\/api\/v1\.0\/companies\/[^/]+\/(.*)$/);
  let rel = (m ? m[1] : p).replace(/^\/+/, "");

  const qIdx = rel.indexOf("?");
  const query = qIdx >= 0 ? rel.slice(qIdx) : "";
  let route = qIdx >= 0 ? rel.slice(0, qIdx) : rel;

  // Top-level routes (currentUser, info, the companies listing) sit outside the
  // company scope; canonicalize bare and full spellings to the api/v1.0/ form the
  // client routes past its company pin. No company-scoped route shares these segments.
  const bare = route.replace(/^api\/v1\.0\//, "");
  if (topLevelRoute(bare)) route = `api/v1.0/${bare}`;

  const trimmed = route.replace(/\/+$/, "");
  const lastSegment = trimmed.split("/").pop() ?? "";
  // Attachment file IDs are opaque strings, not numbers, but are still item routes.
  if (/^\d+$/.test(lastSegment) || /(^|\/)attachments\/files\/[^/]+$/.test(trimmed)) {
    route = route.replace(/\/+$/, "");
  } else if (route && !route.endsWith("/")) {
    route = `${route}/`;
  }
  return route + query;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// The data path that backs query_collection, reused by the aggregation tools: select the requested
// dot-paths via display=all (the only way to reliably pull a nested value like Total.BalanceDue —
// top-level `columns` alone doesn't guarantee the nested field comes back), then narrow with
// selectRecords. `allPages` walks the whole collection (for sums/aging); otherwise one page is returned.
async function fetchProjected(
  client: SimproClient,
  path: string,
  fields: string[],
  opts: { filters?: Record<string, unknown>; allPages?: boolean; pageSize?: number } = {},
): Promise<{ rows: Array<Record<string, unknown>>; pagination?: { page: number; pageSize?: number; totalPages: number; totalRows: number } }> {
  const query = { columns: columnsForFields(fields), display: "all", ...(opts.filters ?? {}) };
  if (opts.allPages) {
    const raw = await client.getAllPages(path, query, { pageSize: opts.pageSize });
    return { rows: selectRecords(raw, fields) };
  }
  const { rows, pagination } = await client.getList(path, { ...query, pageSize: opts.pageSize });
  return { rows: selectRecords(rows, fields), pagination };
}

// Stock/Assets array names are unconfirmed (absent from probed data); a wrong guess undercounts, never miscounts.
const ITEM_ARRAY_KEY: Record<ItemType, string> = {
  catalog: "Catalogs",
  labor: "Labors",
  oneOff: "OneOffs",
  prebuild: "Prebuilds",
  serviceFee: "ServiceFees",
  stock: "Stock",
  asset: "Assets",
};

function countItems(items: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!items || typeof items !== "object") return out;
  const blk = items as Record<string, unknown>;
  for (const t of ITEM_TYPE_KEYS) {
    const arr = blk[ITEM_ARRAY_KEY[t]];
    if (Array.isArray(arr) && arr.length > 0) out[t] = arr.length;
  }
  return out;
}

async function getCustomerAny(client: SimproClient, id: number): Promise<unknown> {
  try {
    return await client.get(`customers/companies/${id}`);
  } catch (e) {
    if (e instanceof SimproError && e.status === 404) {
      return client.get(`customers/individuals/${id}`);
    }
    throw e;
  }
}

function buildDuplicateBody(
  entity: "job" | "quote",
  src: Record<string, any>,
  opts: { intoCustomer?: number; name?: string },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    Customer: opts.intoCustomer ?? src.Customer?.ID ?? src.Customer,
    Name: opts.name ?? `${src.Name ?? "Untitled"} (copy)`,
  };
  const srcSite = src.Site?.ID ?? src.Site;
  if (srcSite !== undefined && srcSite !== null) body.Site = srcSite;
  if (src.Type) body.Type = src.Type;
  if (src.Description) body.Description = src.Description;

  const sections = Array.isArray(src.Sections) ? src.Sections : [];
  body.Sections = sections.map((s: any) => ({
    Name: s.Name,
    DisplayOrder: s.DisplayOrder,
    CostCenters: (Array.isArray(s.CostCenters) ? s.CostCenters : []).map((cc: any) => ({
      CostCenter: cc.CostCenter?.ID ?? cc.CostCenter,
      Name: cc.Name,
      Items: mapItems(cc.Items),
    })),
  }));
  return body;
}

function mapItems(items: any): Record<string, unknown> {
  if (!items || typeof items !== "object") return {};
  const out: Record<string, unknown> = {};
  const passQty = (it: any) => ({ Total: it.Total?.Qty !== undefined ? { Qty: it.Total.Qty } : it.Total });
  if (Array.isArray(items.Catalogs))
    out.Catalogs = items.Catalogs.map((it: any) => ({ Catalog: it.Catalog?.ID ?? it.Catalog, ...passQty(it) }));
  if (Array.isArray(items.Labors))
    out.Labors = items.Labors.map((it: any) => ({ LaborType: it.LaborType?.ID ?? it.LaborType, ...passQty(it) }));
  if (Array.isArray(items.Prebuilds))
    out.Prebuilds = items.Prebuilds.map((it: any) => ({ Prebuild: it.Prebuild?.ID ?? it.Prebuild, ...passQty(it) }));
  if (Array.isArray(items.OneOffs))
    out.OneOffs = items.OneOffs.map((it: any) => ({ Type: it.Type, Description: it.Description, Total: it.Total }));
  if (Array.isArray(items.ServiceFees))
    out.ServiceFees = items.ServiceFees.map((it: any) => ({ ServiceFee: it.ServiceFee?.ID ?? it.ServiceFee, ...passQty(it) }));
  return out;
}

const AGE_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;

function daysBetween(a: string, b: string): number {
  const ad = Date.parse(`${a}T00:00:00Z`);
  const bd = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ad) || !Number.isFinite(bd)) return 0;
  return Math.round((ad - bd) / 86_400_000);
}

// Due date from a projected invoice row: prefer Simpro's PaymentTerms.DueDate, else derive it from
// DateIssued + PaymentTerms.Days, else fall back to the issue date.
function invoiceDueDate(inv: Record<string, any>): string | undefined {
  const explicit = inv.PaymentTerms?.DueDate;
  if (explicit) return String(explicit);
  const issued = inv.DateIssued;
  const days = inv.PaymentTerms?.Days;
  if (issued && days != null) {
    const ms = Date.parse(`${issued}T00:00:00Z`);
    if (Number.isFinite(ms)) {
      return new Date(ms + Number(days) * 86_400_000).toISOString().slice(0, 10);
    }
  }
  return issued ? String(issued) : undefined;
}

function ageReceivables(rows: Array<Record<string, any>>, asOf: string | undefined, customerID: number) {
  const today = asOf ?? new Date().toISOString().slice(0, 10);
  const buckets: Record<string, { count: number; balance: number }> = {};
  for (const b of AGE_BUCKETS) buckets[b] = { count: 0, balance: 0 };
  let total = 0;
  const detail: Array<Record<string, unknown>> = [];

  for (const inv of rows) {
    const balance = Number(inv.Total?.BalanceDue) || 0;
    if (balance === 0) continue;
    const due = invoiceDueDate(inv);
    const overdue = due ? daysBetween(today, due) : 0; // positive = past due
    let bucket: (typeof AGE_BUCKETS)[number];
    if (overdue <= 0) bucket = "current";
    else if (overdue <= 30) bucket = "1-30";
    else if (overdue <= 60) bucket = "31-60";
    else if (overdue <= 90) bucket = "61-90";
    else bucket = "90+";
    buckets[bucket].count += 1;
    buckets[bucket].balance = round2(buckets[bucket].balance + balance);
    total = round2(total + balance);
    detail.push({ ID: inv.ID, dueDate: due, daysOverdue: overdue, balance: round2(balance), bucket });
  }
  return { customerID, asOf: today, totalOutstanding: total, buckets, invoices: detail };
}
