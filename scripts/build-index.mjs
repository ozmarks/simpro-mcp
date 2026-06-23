// Regenerates data/simpro-api-index.json from the full Simpro Swagger spec.
// The spec (~24MB) is NOT checked in — it lives in docs-personal/ and is passed here.
// Run manually after a spec refresh: `npm run build-index [path-to-spec]`.
// The generated index IS committed; the normal `npm run build` does not run this.
//
// Beyond method/path/summary/tags/params, each endpoint now carries the body/column
// schema the escape-hatch tools need so an agent knows what to send on a write and
// which columns exist on a GET — the field-level detail the old index dropped.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, "..");

const specPath =
  process.argv[2] ?? join(serverRoot, "docs-personal", "simpro", "simpro-api.json");
const outPath = join(serverRoot, "data", "simpro-api-index.json");

if (!existsSync(specPath)) {
  console.error(
    `[build-index] spec not found: ${specPath}\n` +
      `Pass the path to simpro-api.json (the full Swagger spec) as the first argument.`,
  );
  process.exit(1);
}

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const definitions = spec.definitions ?? {};

const MAX_DEPTH = 4;

function resolveRef(ref) {
  // "#/definitions/Foo" -> definitions.Foo
  const m = /^#\/definitions\/(.+)$/.exec(ref);
  if (!m) return undefined;
  return definitions[m[1]];
}

// Compact a Swagger schema to the fields an agent needs: type, required, enum, format,
// and ID-hint descriptions ("ID of a customer"). $refs are followed once so the shape
// is inlined; nesting is capped so a deep tree can't blow up. Prose/examples/patterns
// are dropped.
function compact(schema, depth = 0, seen = new Set()) {
  if (!schema || typeof schema !== "object") return schema;

  if (schema.$ref) {
    if (seen.has(schema.$ref) || depth >= MAX_DEPTH) return { type: "object" };
    const target = resolveRef(schema.$ref);
    if (!target) return { type: "object" };
    return compact(target, depth, new Set([...seen, schema.$ref]));
  }

  const out = {};
  if (schema.type) out.type = schema.type;
  if (schema.enum) out.enum = schema.enum;
  if (schema.format) out.format = schema.format;

  const desc = schema.description ?? "";
  if (typeof desc === "string" && desc.includes("ID of")) out.desc = desc;

  if (schema.type === "array" && schema.items) {
    out.items = compact(schema.items, depth + 1, seen);
  }

  if (schema.properties && depth < MAX_DEPTH) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = compact(v, depth + 1, seen);
    }
  }

  if (schema.required) out.required = schema.required;
  return out;
}

// Top-level required field names, with a one-line type/enum hint each. This is the
// cheap inline view shown on find_operation's top results.
function requiredSummary(bodySchema) {
  if (!bodySchema || !bodySchema.properties) return undefined;
  const req = bodySchema.required ?? [];
  if (req.length === 0) return undefined;
  const out = {};
  for (const name of req) {
    const p = bodySchema.properties[name];
    if (!p) {
      out[name] = "?";
      continue;
    }
    if (p.enum) out[name] = `enum[${p.enum.join("|")}]`;
    else if (p.desc) out[name] = `${p.type ?? "?"} (${p.desc})`;
    else if (p.type === "array") out[name] = `array<${p.items?.type ?? "?"}>`;
    else out[name] = p.type ?? "?";
  }
  return out;
}

// The full column set for a GET. The list endpoint's 200 response only names the default
// return columns (often just ID + one name field); the resource's real shape lives on the
// sibling GET-by-id response. So for a list path we resolve to its by-id sibling.
function byIdSiblingProps(listPath, methodsByPath) {
  // collection path ".../quotes/" -> item path ".../quotes/{...}"
  const base = listPath.replace(/\/$/, "");
  for (const [p, methods] of methodsByPath) {
    if (!methods.get) continue;
    // sibling = base + "/{param}" with nothing further
    const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\{[^/]+\\}$`).exec(p);
    if (m) {
      const props = getResponseProps(methods.get);
      if (props) return props;
    }
  }
  return undefined;
}

function getResponseProps(op) {
  const sch = op?.responses?.["200"]?.schema;
  if (!sch) return undefined;
  const obj = sch.properties ? sch : sch.items ?? {};
  return obj.properties;
}

// type/enum hint per column, kept tiny
function columnHints(props) {
  if (!props) return undefined;
  const out = {};
  for (const [name, p] of Object.entries(props)) {
    if (!p || typeof p !== "object") {
      out[name] = "?";
      continue;
    }
    if (p.enum) out[name] = `enum[${p.enum.join("|")}]`;
    else if (p.type === "array") out[name] = "array";
    else out[name] = p.type ?? "object";
  }
  return out;
}

const pathsEntries = Object.entries(spec.paths ?? {});
const endpoints = [];

for (const [path, methods] of pathsEntries) {
  for (const [method, op] of Object.entries(methods)) {
    if (!["get", "post", "put", "delete", "patch"].includes(method)) continue;

    const endpoint = {
      method: method.toUpperCase(),
      path,
      summary: (op.summary ?? "").slice(0, 100),
      tags: op.tags ?? [],
    };

    const params = (op.parameters ?? []).map((p) => p.name).filter(Boolean);
    if (params.length) endpoint.params = params;

    if (["post", "put", "patch"].includes(method)) {
      const bodyParam = (op.parameters ?? []).find((p) => p.in === "body" && p.schema);
      if (bodyParam) {
        const body = compact(bodyParam.schema);
        endpoint.body = body;
        const reqSummary = requiredSummary(body);
        if (reqSummary) endpoint.bodyRequired = reqSummary;
      }
    } else if (method === "get") {
      const isItem = /\}$/.test(path);
      const props = isItem
        ? getResponseProps(op)
        : byIdSiblingProps(path, pathsEntries) ?? getResponseProps(op);
      const cols = columnHints(props);
      if (cols && Object.keys(cols).length) endpoint.columns = cols;
    }

    endpoints.push(endpoint);
  }
}

const index = {
  info: spec.info ?? {},
  basePath: spec.basePath ?? "",
  endpoints,
};

writeFileSync(outPath, JSON.stringify(index));
const bytes = Buffer.byteLength(JSON.stringify(index));
console.error(
  `[build-index] ${endpoints.length} endpoints -> ${outPath} (${(bytes / 1024).toFixed(0)} KB)`,
);
