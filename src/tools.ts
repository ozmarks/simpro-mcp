import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { SimproClient, SimproError } from "./simproClient.js";
import { cleanRichText, applyLean } from "./format.js";
import { searchEndpoints } from "./catalog.js";
import { ITEM_TYPES, ITEM_TYPE_KEYS, itemCollectionPath, type ItemType } from "./lineItems.js";

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
  // Live: POSTing SellPrice.ExTax → path "/SellPrice/ExTax", message "This API Column does not allow POST requests."
  if (path.includes("sellprice")) {
    return "SellPrice is a read-only shape ({ ExTax, IncTax }) and can't be written. To set a one-off's price, send SellPriceExDiscount (a number) for an exact sell, or EstimatedCost + Markup.";
  }
  return undefined;
}

function fail(err: unknown) {
  let msg: string;
  if (err instanceof SimproError) {
    const body = err.body as { errors?: SimproFieldError[] } | undefined;
    if (body?.errors?.length) {
      const lines = body.errors.map((e) => {
        const hint = footgunHint(e);
        return (
          `  - ${e.path ?? "(root)"}: ${e.message}${e.value !== undefined && e.value !== null ? ` (got: ${JSON.stringify(e.value)})` : ""}` +
          (hint ? `\n    → ${hint}` : "")
        );
      });
      msg = `${err.message}\n${lines.join("\n")}`;
    } else {
      msg = `${err.message}${err.body ? `\n${JSON.stringify(err.body)}` : ""}`;
    }
  } else {
    msg = err instanceof Error ? err.message : String(err);
  }
  return { isError: true, content: [{ type: "text" as const, text: msg }] };
}

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

export function registerTools(server: McpServer, client: SimproClient, cfg: Config): void {
  const defaultPageSize = cfg.defaultPageSize;
  const ok = (data: unknown) => okWithBudget(data, cfg.maxResultBytes, false);
  const okLean = (data: unknown) => okWithBudget(data, cfg.maxResultBytes, true);

  // POST/PUT/PATCH/DELETE through one path that echoes the resource id as a receipt.
  const okWrite = async (
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    opts: { body?: unknown; query?: Record<string, unknown>; mergeMode?: boolean } = {},
  ) => {
    const { body, resourceId } = await client.requestWithReceipt(method, path, opts);
    return ok(writeReceipt(body, resourceId));
  };

  server.registerTool(
    "find_work",
    {
      title: "Find Work (Jobs/Quotes)",
      description:
        "Search or browse jobs or quotes. Set entity to 'job' or 'quote'. Pass `keywords` for free-text matching on the Name (handled internally as a wildcard filter). Use `filters` for server-side narrowing (e.g. { Stage: 'Pending', Customer: 131 }); filters support operators like gt()/between()/in() and nested columns (Customer.ID). Returns one page as { rows, pagination: { page, totalPages, totalRows } }; request later pages with `page`. Returns a lean column set; `columns` adds more (a large pageSize with many columns can exceed the response budget — keep one or the other modest).",
      inputSchema: {
        entity: entityArg,
        keywords: z.string().optional().describe("Free-text to match on the work Name (e.g. 'Croydon'). Applied internally as a wildcard Name filter; this is plain text, not a Simpro search scheme."),
        filters: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Server-side column filters { Column: value }, e.g. { Stage: 'Pending', Total: 'gt(5000)' }."),
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
        "Create a new job or quote. Simpro requires three fields for both: a Customer (ID), a Site (ID), and a Type ('Project' | 'Service' | 'Prepaid'). A customer's sites are listed at /customers/{id}/sites/. A brand-new customer has no site until one is created at POST /customers/{id}/sites/. Other fields (Name, Description, DueDate, …) go in `fields`.",
      inputSchema: {
        entity: entityArg,
        customer: z.number().int().positive().describe("Customer ID (required)."),
        site: z
          .number()
          .int()
          .positive()
          .describe("Site ID (required by Simpro). A customer's sites: /customers/{id}/sites/."),
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
        "Get a job/quote's structure in one call: every section with its cost centers. Each cost center carries an `itemCounts` map (e.g. { prebuild: 4 }) showing how many line items of each type it holds — call list_line_items once per populated type instead of probing all seven. The line items themselves are read with list_line_items.",
      inputSchema: {
        entity: entityArg,
        id: z.number().int().positive().describe("The job/quote Simpro ID."),
      },
      annotations: { title: "Get Breakdown", readOnlyHint: true },
    },
    async ({ entity, id }) => {
      try {
        const work = (await client.get(`${base(entity)}/${id}`, { display: "all" })) as Record<string, any>;
        const sections = (Array.isArray(work.Sections) ? work.Sections : []).map((s: any) => ({
          ID: s.ID,
          Name: s.Name,
          DisplayOrder: s.DisplayOrder,
          costCenters: (Array.isArray(s.CostCenters) ? s.CostCenters : []).map((cc: any) => {
            const { Items, ...rest } = cc;
            return { ...rest, itemCounts: countItems(Items) };
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
        "List line items of one type within a cost center. Get sectionID + costCenterID from get_breakdown (its itemCounts tells you which types are populated, so you can call this once per populated type instead of probing all seven). Returns { rows, _lean }: each row's SellPrice is slimmed to ExTax (+ ExDiscountExTax only when a discount applies) and the _lean note on the result states the leaning rule.",
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

  server.registerTool(
    "add_line_item",
    {
      title: "Add Line Item",
      description:
        "Add a line item to a cost center. Routes to the correct collection for itemType. The result carries `resourceId` — the new line item's id — so a retry that lost the response can confirm-by-id rather than duplicating. Required fields per type — " +
        ITEM_TYPE_KEYS.map((k) => `${k}: ${ITEM_TYPES[k].createHint}`).join("; ") +
        ". The catalog/labor/prebuild anchor fields take a numeric ID; find_catalog_items resolves a catalog ID from a name or part number.",
      inputSchema: {
        ...itemLocator,
        fields: z.record(z.unknown()).describe("Body fields for the new item (see required per type)."),
      },
      annotations: { title: "Add Line Item", readOnlyHint: false },
    },
    async ({ entity, id, sectionID, costCenterID, itemType, fields }) => {
      try {
        const path = itemCollectionPath(entity, id, sectionID, costCenterID, itemType as ItemType);
        return await okWrite("POST", path, { body: fields });
      } catch (e) {
        return fail(e);
      }
    },
  );

  const updatableTypes = ITEM_TYPE_KEYS.filter((k) => ITEM_TYPES[k].canUpdate);
  server.registerTool(
    "update_line_item",
    {
      title: "Update Line Item",
      description:
        "Update one existing line item in place (PATCH — only the fields you pass change). Routes to the correct collection for itemType; `itemID` is the line item's own id (from list_line_items), not its catalog/anchor id. " +
        `Updatable types: ${updatableTypes.join(", ")}. ` +
        "assets have no update endpoint — delete and re-add instead. " +
        "Common edits: Qty via fields.Total ({ Qty }); a oneOff's sell price via fields.SellPriceExDiscount (number) — never POST SellPrice: { ExTax } (read-only shape). To change a line's catalog/labor/prebuild item, delete it and add the new one rather than swapping the anchor.",
      inputSchema: {
        ...itemLocator,
        itemID: z.number().int().positive().describe("The line item's own ID (from list_line_items), i.e. the id under the cost center's item collection."),
        fields: z.record(z.unknown()).describe("Fields to change (PATCH semantics — omit what stays the same)."),
      },
      annotations: { title: "Update Line Item", readOnlyHint: false },
    },
    async ({ entity, id, sectionID, costCenterID, itemType, itemID, fields }) => {
      try {
        if (!ITEM_TYPES[itemType as ItemType].canUpdate) {
          return fail(
            new Error(
              `Item type '${itemType}' has no Simpro update endpoint. Delete the line and re-add it (use simpro_api_delete then add_line_item).`,
            ),
          );
        }
        const path = `${itemCollectionPath(entity, id, sectionID, costCenterID, itemType as ItemType)}${itemID}`;
        return await okWrite("PATCH", path, { body: fields });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "bulk_upsert_items",
    {
      title: "Bulk Upsert Line Items",
      description:
        "Add, merge, or replace many line items of one type in a cost center in a single call. " +
        "mode='append' creates new items; mode='merge' increases the Qty of matching existing items " +
        "(Post-Mode: merge); mode='replace' deletes all existing items of that type and inserts these (PUT). " +
        "append/merge use Simpro's bulk route and return a per-item status array (Batch-ID / Resource-ID / Location, " +
        "not the full item bodies); the created items are then readable via list_line_items. " +
        "Required fields per item type — " +
        ITEM_TYPE_KEYS.map((k) => `${k}: ${ITEM_TYPES[k].createHint}`).join("; ") + ".",
      inputSchema: {
        ...itemLocator,
        mode: z
          .enum(["append", "merge", "replace"])
          .describe("append = add new (POST); merge = increment matching Qty (POST + Post-Mode: merge); replace = overwrite all (PUT)."),
        items: z.array(z.record(z.unknown())).min(1).describe("Array of item bodies (see required fields per type)."),
      },
      annotations: { title: "Bulk Upsert Line Items", readOnlyHint: false, destructiveHint: true },
    },
    async ({ entity, id, sectionID, costCenterID, itemType, mode, items }) => {
      try {
        const path = itemCollectionPath(entity, id, sectionID, costCenterID, itemType as ItemType);
        if (mode === "replace") return ok(await client.put(path, items));
        return ok(await client.post(`${path}multiple/`, items, { mergeMode: mode === "merge" }));
      } catch (e) {
        return fail(e);
      }
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
    "find_catalog_items",
    {
      title: "Find Catalog Items",
      description:
        "Search the catalog to resolve a catalog item ID by name/part number — typically before add_line_item. " +
        "Pass `keywords` for free-text matching on Name and PartNo (handled internally as wildcard filters); " +
        "optionally filter by group or vendor. UOM (unit of measure) is returned; Simpro's catalog data leaves it " +
        "null on many items — when rows lack it a `_uomNote` flags that the unit is unspecified upstream.",
      inputSchema: {
        keywords: z.string().optional().describe("Free-text to match on catalog Name / PartNo. Mapped to wildcard filters internally."),
        filters: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Column filters, e.g. { Group: 12 }."),
        matchScheme: matchSchemeArg,
        columns: z.array(z.string()).optional(),
        page: z.number().int().positive().optional(),
        pageSize: z.number().int().positive().max(250).optional().describe(`Rows per page (max 250; defaults to ${defaultPageSize}). Larger pages risk exceeding the response budget.`),
      },
      annotations: { title: "Find Catalog Items", readOnlyHint: true },
    },
    async ({ keywords, filters, matchScheme, columns, page, pageSize }) => {
      try {
        const result = await client.getList("catalogs/", {
          columns: columns ?? ["ID", "PartNo", "Name", "TradePrice", "SellPrice", "UOM"],
          page,
          pageSize: pageSize ?? defaultPageSize,
          ...buildSearchQuery(keywords, ["Name", "PartNo"], filters, matchScheme),
        });
        return okLean(annotateNullUom(result));
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
        const rows = (await client.getAllPages("invoices/", {
          "Customer.ID": customerID,
          IsPaid: false,
          columns: ["ID", "DateIssued", "PaymentTerms", "Total"],
        })) as Array<Record<string, any>>;
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
        const rows = (await client.getAllPages("schedules/", {
          "Staff.ID": staffID,
          Date: `between(${dateFrom},${dateTo})`,
        })) as Array<Record<string, any>>;
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
        const openQuotes = await client.get("quotes/", {
          "Customer.ID": customerID,
          Stage: "in(InProgress,Complete)",
          columns: ["ID", "Name", "Stage", "Status", "Total", "DateIssued"],
          pageSize: 50,
        });
        const openJobs = await client.get("jobs/", {
          "Customer.ID": customerID,
          Stage: "in(Pending,Progress)",
          columns: ["ID", "Name", "Stage", "Status", "Total", "DateIssued"],
          pageSize: 50,
        });
        const unpaid = (await client.getAllPages("invoices/", {
          "Customer.ID": customerID,
          IsPaid: false,
          columns: ["ID", "Total"],
        })) as Array<Record<string, any>>;
        const outstanding = unpaid.reduce((s, i) => s + (Number(i?.Total?.BalanceDue) || 0), 0);
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
        "Search the full Simpro REST API (~1,300 endpoints; documented at https://developer.simprogroup.com/apidoc/) by intent to find the right operation when no dedicated tool fits — e.g. customers, invoices, catalogues, inventory, contacts, notes, attachments, updating/deleting a job/quote or line item. Returns matching endpoints with method, path, and parameters. simpro_api_get runs GET endpoints; simpro_api_post / simpro_api_put / simpro_api_delete run the matching write methods.",
      inputSchema: {
        query: z.string().describe("What you want to do, in keywords, e.g. 'list customer contacts' or 'update a quote'."),
        method: z
          .enum(["GET", "POST", "PATCH", "PUT", "DELETE"])
          .optional()
          .describe("Optional: restrict to one HTTP method."),
        limit: z.number().int().positive().max(40).optional().describe("Max results (default 15)."),
      },
      annotations: { title: "Find Simpro Operation", readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, method, limit }) => {
      try {
        const results = searchEndpoints(query, { method, limit }).map((e) => ({
          method: e.method,
          path: e.path,
          summary: e.summary,
          params: e.params,
        }));
        if (results.length === 0) return ok({ results: [], note: "No matches. Try different keywords." });
        return ok({
          results,
          note: "Call simpro_api_get (GET) or simpro_api_post / simpro_api_put / simpro_api_delete (writes) with the chosen path. {companyID} is filled automatically.",
        });
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
          .describe("Endpoint path. Catalog form with {companyID} (auto-filled) or a concrete /api/v1.0/... path."),
        query: z.record(z.unknown()).optional().describe("Query params (columns, pageSize, page, orderby, and exact/operator column filters like { Stage: 'Pending', Total: 'gt(5000)' }). `search` here is the match scheme 'all'/'any' only, not free text."),
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
        return fail(e);
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
        return fail(e);
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
        return fail(e);
      }
    },
  );
}

function normalizePath(path: string): string {
  const p = path.trim();
  const m = p.match(/\/api\/v1\.0\/companies\/[^/]+\/(.*)$/);
  let rel = (m ? m[1] : p).replace(/^\/+/, "");

  const qIdx = rel.indexOf("?");
  const query = qIdx >= 0 ? rel.slice(qIdx) : "";
  let route = qIdx >= 0 ? rel.slice(0, qIdx) : rel;

  const lastSegment = route.replace(/\/+$/, "").split("/").pop() ?? "";
  if (/^\d+$/.test(lastSegment)) {
    route = route.replace(/\/+$/, "");
  } else if (route && !route.endsWith("/")) {
    route = `${route}/`;
  }
  return route + query;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Simpro's catalog leaves UOM null on many items (data quality, not our bug). When UOM was
// returned but is null on some rows, attach a note so the agent knows the unit is unspecified
// upstream rather than assuming "Each". Only fires when UOM is actually a selected column.
export function annotateNullUom(result: { rows: unknown[]; pagination: unknown }): unknown {
  const rows = Array.isArray(result.rows) ? (result.rows as Array<Record<string, unknown>>) : [];
  const uomSelected = rows.some((r) => r && typeof r === "object" && "UOM" in r);
  if (!uomSelected) return result;
  const nullUomIds = rows
    .filter((r) => r && typeof r === "object" && "UOM" in r && (r.UOM === null || r.UOM === undefined || r.UOM === ""))
    .map((r) => r.ID)
    .filter((id) => id !== undefined);
  if (nullUomIds.length === 0) return result;
  return {
    ...result,
    _uomNote: `UOM (unit of measure) is null in Simpro's catalog for ${nullUomIds.length} of these item(s) (IDs: ${nullUomIds.join(", ")}). The unit is unspecified upstream — don't assume one.`,
  };
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

function invoiceDueDate(inv: Record<string, any>): string | undefined {
  const pt = inv.PaymentTerms;
  if (pt?.DueDate) return String(pt.DueDate);
  if (inv.DateIssued && pt?.Days != null) {
    const issued = Date.parse(`${inv.DateIssued}T00:00:00Z`);
    if (Number.isFinite(issued)) {
      return new Date(issued + Number(pt.Days) * 86_400_000).toISOString().slice(0, 10);
    }
  }
  return inv.DateIssued ? String(inv.DateIssued) : undefined;
}

function ageReceivables(rows: Array<Record<string, any>>, asOf: string | undefined, customerID: number) {
  const today = asOf ?? new Date().toISOString().slice(0, 10);
  const buckets: Record<string, { count: number; balance: number }> = {};
  for (const b of AGE_BUCKETS) buckets[b] = { count: 0, balance: 0 };
  let total = 0;
  const detail: Array<Record<string, unknown>> = [];

  for (const inv of rows) {
    const balance = Number(inv?.Total?.BalanceDue) || 0;
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
