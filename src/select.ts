// Dot-path field selection over records, with automatic fan-out across nested arrays.
//
// Simpro's `columns` param selects only TOP-LEVEL columns; with display=all it expands each into its
// full nested tree, but it cannot select sub-columns. So once the (often large) record is fetched, we
// narrow it to exactly the requested dot-paths here — keeping the result token-lean.
//
// A field is the full path from the record root, e.g. "Sections.CostCenters.Total.ExTax". When the
// requested paths cross one or more arrays, the deepest array sequence becomes the ROW boundary: the
// record fans out to one row per leaf-most element. Each row is rebuilt as a NESTED object mirroring the
// path, so a shared prefix ("Sections.CostCenters") is stated once per row rather than baked into every
// key; values at different depths (job "ID" at the root vs a cost-centre "ID" under Sections.CostCenters)
// live at different levels and never collide. Every array level the fields descend through also gets its
// own "ID" auto-included (where the elements have one), so each fanned-out level carries its primary key.

export type Row = Record<string, unknown>;

function topLevelColumns(fields: string[]): string[] {
  const set = new Set<string>();
  for (const f of fields) {
    const head = f.split(".")[0];
    if (head) set.add(head);
  }
  return [...set];
}

// How many arrays a field's path traverses in this record (its fan-out depth). An array reached at the
// FINAL segment is the requested value itself (e.g. "Blocks"), not a fan-out boundary, so it isn't
// counted — only arrays we descend THROUGH (e.g. the "Sections" in "Sections.CostCenters.ID") fan out.
function arrayDepth(record: unknown, parts: string[]): number {
  let node: unknown = record;
  let depth = 0;
  for (let i = 0; i < parts.length; i++) {
    node = (node as Record<string, unknown> | null | undefined)?.[parts[i]];
    if (Array.isArray(node) && i < parts.length - 1) {
      depth++;
      node = node[0];
    }
  }
  return depth;
}

// Set a value at a nested dot-path on `root`, creating intermediate objects as needed.
function setPath(root: Row, parts: string[], value: unknown): void {
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof node[k] !== "object" || node[k] === null) node[k] = {};
    node = node[k] as Row;
  }
  node[parts[parts.length - 1]] = value;
}

// For each array the requested fields descend THROUGH (e.g. "Sections", "Sections.CostCenters"), add an
// "<arrayPrefix>.ID" field so every fanned-out level carries its own primary key — but only where that
// array's elements actually have an `ID` (Simpro arrays like a schedule's Blocks don't). Returns the
// augmented field-part list; injected ID paths are de-duplicated against fields the caller already asked for.
function withLevelIds(record: unknown, split: string[][]): string[][] {
  const wanted = new Set(split.map((p) => p.join(".")));
  const idPaths = new Set<string>();
  for (const parts of split) {
    let node: unknown = record;
    for (let i = 0; i < parts.length; i++) {
      node = (node as Record<string, unknown> | null | undefined)?.[parts[i]];
      if (Array.isArray(node)) {
        const el = node[0];
        if (el && typeof el === "object" && "ID" in el) idPaths.add([...parts.slice(0, i + 1), "ID"].join("."));
        node = el;
      }
    }
  }
  const extra = [...idPaths].filter((p) => !wanted.has(p)).map((p) => p.split("."));
  return [...split, ...extra];
}

// Shape one record into rows. The "spine" is the requested field that traverses the most arrays; we
// walk it, fanning out at each array, recording the index chosen at each array step. Every field is
// then resolved by replaying those indices wherever its own path hits an array, so all fields stay
// aligned to the same leaf element. Output rows are NESTED (the dot-path is rebuilt into a tree) so a
// shared prefix like "Sections.CostCenters" is stated once per row, not baked into every key.
export function selectRecord(record: unknown, fields: string[]): Row[] {
  const requested = fields.map((f) => f.split("."));
  const split = withLevelIds(record, requested);
  const spine = split.slice().sort((a, b) => arrayDepth(record, b) - arrayDepth(record, a))[0] ?? [];

  const spineHasArray = arrayDepth(record, spine) > 0;

  const indexChains: Array<Array<number>> = [];
  const walk = (node: unknown, parts: string[], chain: number[]): void => {
    if (parts.length === 0) {
      indexChains.push(chain);
      return;
    }
    const [head, ...rest] = parts;
    const next = (node as Record<string, unknown> | null | undefined)?.[head];
    if (Array.isArray(next) && rest.length > 0) {
      if (next.length === 0) return; // empty array we descend through → no rows from this branch
      next.forEach((el, i) => walk(el, rest, [...chain, i]));
    } else {
      walk(next, rest, chain); // scalar, object, or a terminal array (returned whole, no fan-out)
    }
  };
  walk(record, spine, []);

  // No arrays on the spine → one record-level row. An array on the spine that came back empty →
  // zero rows (the record genuinely has no elements at that depth), not a phantom record row.
  if (indexChains.length === 0 && !spineHasArray) indexChains.push([]);

  const resolve = (parts: string[], chain: number[]): unknown => {
    let node: unknown = record;
    let ci = 0;
    for (let i = 0; i < parts.length; i++) {
      node = (node as Record<string, unknown> | null | undefined)?.[parts[i]];
      if (node === undefined) return undefined;
      // An array at the final segment is the requested value — return it whole. Only arrays we pass
      // THROUGH are indexed by the replayed fan-out chain.
      if (Array.isArray(node) && i < parts.length - 1) {
        const idx = chain[ci++];
        node = idx === undefined ? node[0] : node[idx];
      }
    }
    return node;
  };

  return indexChains.map((chain) => {
    const row: Row = {};
    for (const parts of split) setPath(row, parts, resolve(parts, chain));
    return row;
  });
}

export function selectRecords(records: unknown[], fields: string[]): Row[] {
  return records.flatMap((r) => selectRecord(r, fields));
}

// Columns to request from Simpro for a given field set: the distinct top-level segments, plus ID so a
// returned row is always identifiable even if the caller forgot to ask for it.
export function columnsForFields(fields: string[]): string[] {
  const cols = topLevelColumns(fields);
  if (!cols.includes("ID")) cols.unshift("ID");
  return cols;
}

export interface FieldInfo {
  /** Full dot-path from the record root, e.g. "Sections.CostCenters.Total.ExTax". */
  path: string;
  /** Leaf scalar type, or "array"/"object" for containers shown so the model knows the shape. */
  type: string;
  /** True when this path (or an ancestor) is an array — selecting it fans out to one row per element. */
  array: boolean;
  /** A sample value from the live record (truncated if long); omitted for container nodes. */
  example?: unknown;
  /** True when `example` was truncated. */
  truncated?: boolean;
}

const MAX_EXAMPLE_LEN = 120;

function sampleValue(v: unknown): { example: unknown; truncated: boolean } {
  if (typeof v === "string" && v.length > MAX_EXAMPLE_LEN) {
    return { example: v.slice(0, MAX_EXAMPLE_LEN) + "…", truncated: true };
  }
  return { example: v, truncated: false };
}

export interface DescribeOptions {
  /** Restrict to these top-level columns (e.g. ['Sections','Totals']). Omit for all. */
  only?: string[];
  /** Include a sample value per leaf. Off by default — examples roughly double the response size. */
  values?: boolean;
  maxDepth?: number;
}

// Walk a live record into the full queryable model: every dot-path the caller can select.
// Arrays are descended ONE element deep (element [0]) and flagged `array: true` so the model knows the
// path fans out; long string values are truncated and marked. Containers (objects/arrays) are emitted
// as nodes too, so the model sees the shape, then their children follow.
export function describeRecord(record: unknown, opts: DescribeOptions = {}): FieldInfo[] {
  const { only, values = false, maxDepth = 8 } = opts;
  const onlySet = only && only.length ? new Set(only) : undefined;
  const out: FieldInfo[] = [];

  // `emitContainer` is false when we've just pushed the array node for this exact prefix and are now
  // descending into its element — the element's children carry the same prefix, so re-emitting the
  // element as an "object" node would clobber the array node at that path.
  const walk = (node: unknown, prefix: string, underArray: boolean, depth: number, emitContainer: boolean): void => {
    if (depth > maxDepth) return;

    if (Array.isArray(node)) {
      if (prefix) out.push({ path: prefix, type: "array", array: true });
      if (node.length > 0) walk(node[0], prefix, true, depth, false); // one element deep
      return;
    }
    if (node !== null && typeof node === "object") {
      if (prefix && emitContainer) out.push({ path: prefix, type: "object", array: underArray });
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, prefix ? `${prefix}.${k}` : k, underArray, depth + 1, true);
      }
      return;
    }
    // leaf
    const info: FieldInfo = { path: prefix, type: node === null ? "null" : typeof node, array: underArray };
    if (values) {
      const { example, truncated } = sampleValue(node);
      info.example = example;
      if (truncated) info.truncated = true;
    }
    out.push(info);
  };

  if (onlySet && record !== null && typeof record === "object" && !Array.isArray(record)) {
    for (const [k, v] of Object.entries(record as Record<string, unknown>)) {
      if (onlySet.has(k)) walk(v, k, false, 1, true);
    }
  } else {
    walk(record, "", false, 0, true);
  }
  return out;
}
