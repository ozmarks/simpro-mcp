import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, cleanRichText, lean, applyLean, LEAN_RULE } from "../src/format.js";

// ---- htmlToText -------------------------------------------------------------

test("htmlToText returns input unchanged when it has no tags or entities", () => {
  assert.equal(htmlToText("plain text"), "plain text");
  assert.equal(htmlToText(""), "");
});

test("htmlToText converts table rows to pipe-delimited lines", () => {
  assert.equal(htmlToText("<tr><td>A</td><td>B</td></tr>"), "| A | B |");
  assert.equal(
    htmlToText("<tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr>"),
    "| A | B |\n| C | D |",
  );
});

test("htmlToText emits nothing for a row with no cells", () => {
  assert.equal(htmlToText("<tr></tr>"), "");
});

test("htmlToText turns block close tags into newlines", () => {
  assert.equal(htmlToText("<p>one</p><p>two</p>"), "one\ntwo");
  assert.equal(htmlToText("a<br>b"), "a\nb");
  assert.equal(htmlToText("<h1>title</h1><div>body</div><li>item</li>"), "title\nbody\nitem");
});

test("htmlToText decodes named entities case-insensitively", () => {
  assert.equal(htmlToText("a&nbsp;b"), "a b");
  assert.equal(htmlToText("a&amp;b &AMP; c"), "a&b & c");
  assert.equal(htmlToText("&lt;tag&gt;"), "<tag>");
  assert.equal(htmlToText("say &quot;hi&quot;"), 'say "hi"');
  assert.equal(htmlToText("it&#39;s &apos;ok&apos;"), "it's 'ok'");
});

test("htmlToText collapses runaway whitespace and trims", () => {
  assert.equal(htmlToText("<p>a</p><p></p><p></p><p></p>b"), "a\n\nb");
});

test("htmlToText strips unknown tags", () => {
  assert.equal(htmlToText('<span style="color:red">x</span>'), "x");
});

// ---- cleanRichText ----------------------------------------------------------

test("cleanRichText rewrites only Description and Notes string values", () => {
  const out = cleanRichText({
    Description: "<p>hi</p>",
    Notes: "<b>n</b>",
    Other: "<p>keep</p>",
  }) as Record<string, unknown>;
  assert.equal(out.Description, "hi");
  assert.equal(out.Notes, "n");
  assert.equal(out.Other, "<p>keep</p>");
});

test("cleanRichText recurses into arrays and nested objects", () => {
  const out = cleanRichText({
    a: { Description: "<p>x</p>" },
    list: [{ Notes: "<b>y</b>" }],
  }) as { a: { Description: string }; list: Array<{ Notes: string }> };
  assert.equal(out.a.Description, "x");
  assert.equal(out.list[0].Notes, "y");
});

test("cleanRichText passes scalars and a non-string Description through", () => {
  assert.equal(cleanRichText(5), 5);
  assert.equal(cleanRichText(null), null);
  const out = cleanRichText({ Description: 5 }) as Record<string, unknown>;
  assert.equal(out.Description, 5);
});

// ---- lean -------------------------------------------------------------------

test("lean drops null, empty string, empty array, and empty object", () => {
  const out = lean({ a: 1, b: null, c: "", d: [], e: {} }) as Record<string, unknown>;
  assert.deepEqual(Object.keys(out), ["a"]);
});

test("lean keeps numeric zero outside a Totals subtree", () => {
  const out = lean({ BalanceDue: 0, Qty: 0 }) as Record<string, unknown>;
  assert.deepEqual(out, { BalanceDue: 0, Qty: 0 });
});

test("lean drops numeric zero inside a Totals subtree", () => {
  const out = lean({ Totals: { Amount: 0, Tax: 5 } }) as { Totals: Record<string, unknown> };
  assert.deepEqual(out.Totals, { Tax: 5 });
});

test("lean collapses an all-zero Totals block away entirely", () => {
  const out = lean({ Totals: { Amount: 0, Tax: 0 }, keep: 1 }) as Record<string, unknown>;
  assert.deepEqual(out, { keep: 1 });
});

test("lean keeps boolean false", () => {
  const out = lean({ flag: false }) as Record<string, unknown>;
  assert.deepEqual(out, { flag: false });
});

test("lean drops the Revized twin when the Revised sibling is present", () => {
  const out = lean({ RevisedTotal: 1, RevizedTotal: 1 }) as Record<string, unknown>;
  assert.deepEqual(out, { RevisedTotal: 1 });
});

test("lean keeps a lone Revized field with no Revised sibling", () => {
  const out = lean({ RevizedFoo: 7 }) as Record<string, unknown>;
  assert.deepEqual(out, { RevizedFoo: 7 });
});

test("lean slims SellPrice to ExTax when no discount moved it", () => {
  const out = lean({
    SellPrice: { ExTax: 10, IncTax: 11, ExDiscountExTax: 10, ExDiscountIncTax: 11 },
  }) as { SellPrice: Record<string, unknown> };
  assert.deepEqual(out.SellPrice, { ExTax: 10 });
});

test("lean surfaces ExDiscountExTax only when it differs from ExTax", () => {
  const out = lean({ SellPrice: { ExTax: 10, ExDiscountExTax: 8 } }) as {
    SellPrice: Record<string, unknown>;
  };
  assert.deepEqual(out.SellPrice, { ExTax: 10, ExDiscountExTax: 8 });
});

test("lean leaves a SellPrice with non-numeric ExTax intact", () => {
  const out = lean({ SellPrice: { ExTax: "x", IncTax: 1 } }) as {
    SellPrice: Record<string, unknown>;
  };
  assert.deepEqual(out.SellPrice, { ExTax: "x", IncTax: 1 });
});

test("lean counter accumulates the true drop count", () => {
  const counter = { n: 0 };
  lean(
    {
      keep: 1,
      drop1: null,
      drop2: "",
      arr: [1, null, ""],
      RevisedX: 1,
      RevizedX: 1,
      SellPrice: { ExTax: 10, IncTax: 11, ExDiscountExTax: 10 },
    },
    false,
    counter,
  );
  // drop1, drop2, two array elements, the Revized twin, and two slimmed SellPrice keys.
  assert.equal(counter.n, 7);
});

// ---- applyLean --------------------------------------------------------------

test("applyLean passes scalars, null, and undefined through untouched", () => {
  assert.equal(applyLean(5), 5);
  assert.equal(applyLean(null), null);
  assert.equal(applyLean(undefined), undefined);
});

test("applyLean wraps arrays as { rows, _lean }", () => {
  const out = applyLean([{ a: 1, b: null }, { c: "" }]) as {
    rows: unknown[];
    _lean: { dropped: number; rule: string };
  };
  // The second element leans to {} and is then filtered out of the array.
  assert.deepEqual(out.rows, [{ a: 1 }]);
  assert.equal(out._lean.rule, LEAN_RULE);
  assert.equal(out._lean.dropped, 3); // b, c, and the now-empty element

});

test("applyLean adds a _lean sibling to objects", () => {
  const out = applyLean({ a: 1, empty: null }) as Record<string, unknown> & {
    _lean: { dropped: number; rule: string };
  };
  assert.equal(out.a, 1);
  assert.equal("empty" in out, false);
  assert.equal(out._lean.rule, LEAN_RULE);
  assert.equal(out._lean.dropped, 1);
});
