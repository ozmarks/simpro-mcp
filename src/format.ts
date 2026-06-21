// Output shaping: compact JSON, strip HTML from rich-text fields, preserve tables.

const RICH_TEXT_FIELDS = new Set(["Description", "Notes"]);

/** Convert a Simpro HTML rich-text blob to compact plain text, keeping tables. */
export function htmlToText(html: string): string {
  if (!html || !/[<&]/.test(html)) return html;
  let s = html;

  s = s.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_m, row: string) => {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
      stripTags(c[1]).trim(),
    );
    return cells.length ? `| ${cells.join(" | ")} |\n` : "";
  });

  s = s.replace(/<\/(p|div|li|h[1-6]|br)\s*\/?>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");

  s = stripTags(s);
  s = decodeEntities(s);

  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

/** Recursively clean rich-text fields in an object/array tree. */
export function cleanRichText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanRichText);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = RICH_TEXT_FIELDS.has(k) && typeof v === "string" ? htmlToText(v) : cleanRichText(v);
    }
    return out;
  }
  return value;
}

// Inside these blocks a zero is dropped; elsewhere a zero is kept (a zero
// BalanceDue/Qty is meaningful and must not read as absent).
const ZERO_NOISE_BLOCKS = new Set(["Totals"]);

export const LEAN_RULE =
  "Lean view: empty/null fields (and zero figures inside Totals) removed and SellPrice slimmed to ExTax; an absent field is not proof it doesn't exist.";

export interface LeanMarker {
  dropped: number;
  rule: string;
}

// Strip empty/null fields (zeros only inside a noise block), drop Revized* twins,
// slim SellPrice. booleans (incl. false) are always kept.
export function lean(value: unknown, dropZeros = false, counter?: { n: number }): unknown {
  if (Array.isArray(value)) {
    const kept = value.map((v) => lean(v, dropZeros, counter)).filter((v) => !isEmptyLeaf(v, dropZeros));
    if (counter) counter.n += value.length - kept.length;
    return kept;
  }
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      // Simpro emits a misspelled Revized* twin beside each Revised*; drop it.
      if (/^Revized/.test(k) && `Revised${k.slice("Revized".length)}` in src) {
        if (counter) counter.n += 1;
        continue;
      }
      if (k === "SellPrice" && v && typeof v === "object" && !Array.isArray(v)) {
        const before = Object.keys(v as object).length;
        const slimmed = slimSellPrice(v as Record<string, unknown>);
        if (slimmed && typeof slimmed === "object") {
          out[k] = slimmed;
          if (counter) counter.n += before - Object.keys(slimmed).length;
          continue;
        }
      }
      const childDropZeros = dropZeros || ZERO_NOISE_BLOCKS.has(k);
      const cleaned = lean(v, childDropZeros, counter);
      if (isEmptyLeaf(cleaned, childDropZeros)) {
        if (counter) counter.n += 1;
      } else {
        out[k] = cleaned;
      }
    }
    return out;
  }
  return value;
}

// Central entry: lean a read result and attach one _lean disclosure. Arrays
// become { rows, _lean } so the marker appears once, not per row.
export function applyLean(value: unknown): unknown {
  if (value === undefined || value === null || typeof value !== "object") return value;
  const counter = { n: 0 };
  if (Array.isArray(value)) {
    const rows = lean(value, false, counter) as unknown[];
    return { rows, _lean: { dropped: counter.n, rule: LEAN_RULE } satisfies LeanMarker };
  }
  const cleaned = lean(value, false, counter) as Record<string, unknown>;
  return { ...cleaned, _lean: { dropped: counter.n, rule: LEAN_RULE } satisfies LeanMarker };
}

function isEmptyLeaf(v: unknown, dropZeros: boolean): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (typeof v === "number") return dropZeros && v === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

// Keep ExTax + ExDiscountExTax (only when a discount moved it); IncTax is
// derivable and the no-op ExDiscount twins are redundant.
function slimSellPrice(sp: Record<string, unknown>): unknown {
  const exTax = sp.ExTax;
  if (typeof exTax !== "number") return sp; // unexpected shape — leave intact
  const out: Record<string, unknown> = { ExTax: exTax };
  const exDisc = sp.ExDiscountExTax;
  if (typeof exDisc === "number" && exDisc !== exTax) out.ExDiscountExTax = exDisc;
  return out;
}
