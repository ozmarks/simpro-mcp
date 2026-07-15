import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { SimproClient, SimproError } from "./simproClient.js";
import { cleanRichText, applyLean } from "./format.js";
import { searchEndpoints, getEndpoint } from "./catalog.js";
import { ITEM_TYPES, ITEM_TYPE_KEYS, itemCollectionPath, type ItemType } from "./lineItems.js";
import { selectRecords, columnsForFields, describeRecord } from "./select.js";
import type { VersionChecker, UpdateInfo } from "./versionCheck.js";

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

export function registerTools(
  server: McpServer,
  client: SimproClient,
  cfg: Config,
  versionChecker?: VersionChecker,
): void {
  const defaultPageSize = cfg.defaultPageSize;

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
        ". The catalog/labor/prebuild anchor fields take a numeric ID; find_materials resolves a catalog or prebuild ID from a name or part number.",
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
        "Search the full Simpro REST API (~1,300 endpoints; documented at https://developer.simprogroup.com/apidoc/) by intent to find the right operation when no dedicated tool fits — e.g. customers, invoices, catalogues, inventory, contacts, notes, attachments, updating/deleting a job/quote or line item. Returns matching endpoints with method, path, and parameters; the top results also carry a schema preview (writes: required body fields; GET: available columns). For the full body schema or full column list of any endpoint, call describe_operation. simpro_api_get runs GET endpoints; simpro_api_post / simpro_api_put / simpro_api_delete run the matching write methods.",
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
          return fail(new Error(`No endpoint found for ${method} ${path}. Use find_operation to get the exact method + path.`));
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
