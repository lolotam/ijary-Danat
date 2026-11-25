import { describe, expect, test } from "vitest";

import { escapeVariables, renderTemplate, stripMarkup } from "@/lib/templateRender";

describe("renderTemplate", () => {
  test("substitutes known keys, with or without inner spaces", () => {
    expect(renderTemplate("Hi {{name}} / {{ name }}", { name: "Aya" })).toBe("Hi Aya / Aya");
  });

  test("leaves an unknown key verbatim so a typo is visible, not a silent gap", () => {
    expect(renderTemplate("Hi {{recipent_name}}", { recipient_name: "Aya" })).toBe(
      "Hi {{recipent_name}}",
    );
  });

  test("passes null through", () => {
    expect(renderTemplate(null, { name: "Aya" })).toBeNull();
  });

  test("does not escape — the admin-authored template keeps its markup", () => {
    expect(renderTemplate("<p>{{name}}</p>", { name: "Aya" })).toBe("<p>Aya</p>");
  });

  test("an inherited property is not treated as a variable", () => {
    // Object.hasOwn, not `in`: {{toString}} must not resolve to Object.prototype.
    expect(renderTemplate("{{toString}}", {})).toBe("{{toString}}");
  });

  test("a substituted value containing a placeholder is not re-expanded", () => {
    // Single-pass replace: the injected {{b}} stays literal rather than
    // resolving, so a value can never reach another variable's content.
    expect(renderTemplate("{{a}}", { a: "{{b}}", b: "secret" })).toBe("{{b}}");
  });
});

describe("renderTemplate sections", () => {
  test("a section renders only when its variable is non-empty", () => {
    expect(renderTemplate("A{{#d}} [{{d}}]{{/d}} Z", { d: "5 KWD" })).toBe("A [5 KWD] Z");
    expect(renderTemplate("A{{#d}} [{{d}}]{{/d}} Z", { d: "" })).toBe("A Z");
    expect(renderTemplate("A{{#d}} [{{d}}]{{/d}} Z", {})).toBe("A Z");
  });

  test("an inverted section renders only when the variable is empty", () => {
    expect(renderTemplate("{{^d}}none{{/d}}{{#d}}{{d}}{{/d}}", { d: "" })).toBe("none");
    expect(renderTemplate("{{^d}}none{{/d}}{{#d}}{{d}}{{/d}}", { d: "x" })).toBe("x");
  });

  test("sections nest and span lines", () => {
    expect(renderTemplate("{{#a}}1\n{{#b}}2{{/b}}\n3{{/a}}", { a: "y", b: "" })).toBe("1\n\n3");
  });

  test("an unmatched section tag is left verbatim, like an unknown variable", () => {
    expect(renderTemplate("x {{#d}} y", { d: "1" })).toBe("x {{#d}} y");
  });

  test("a crossed closer leaves every tag verbatim", () => {
    // A section body may contain no other section tag, opener OR closer, so
    // {{/b}} inside {{#a}}…{{/a}} matches nothing and nothing is swallowed.
    expect(renderTemplate("{{#a}}A{{/b}}B{{/a}}", { a: "1" })).toBe("{{#a}}A{{/b}}B{{/a}}");
  });

  test("$& is inserted literally and the call terminates", () => {
    // Splice-by-index, never a String.replace replacement string: authored
    // text containing $& must survive and must not loop the renderer.
    expect(renderTemplate("{{#a}}$&{{/a}}", { a: "y" })).toBe("$&");
  });
});

describe("escapeVariables", () => {
  test("escapes the values that go into HTML", () => {
    expect(escapeVariables({ name: `<script>alert("x")</script>` })).toEqual({
      name: "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    });
  });

  test("escapes the ampersand first, so entities are not double-escaped wrongly", () => {
    expect(escapeVariables({ v: "a & b < c" })).toEqual({ v: "a &amp; b &lt; c" });
  });

  test("leaves keys alone", () => {
    expect(Object.keys(escapeVariables({ display_name: "x" }))).toEqual(["display_name"]);
  });

  test("a display name with markup cannot inject through a placeholder", () => {
    const rendered = renderTemplate(
      "<p>Hello {{display_name}}</p>",
      escapeVariables({ display_name: "<img src=x onerror=alert(1)>" }),
    );
    expect(rendered).not.toContain("<img");
    expect(rendered).toContain("&lt;img");
  });
});

describe("stripMarkup", () => {
  test("block tags become newlines and entities are decoded", () => {
    // WhatsApp is plain text and would otherwise show a literal &amp;.
    expect(stripMarkup("<p>A &amp; B</p><p>C</p>")).toBe("A & B\nC");
  });

  test("null is empty, not the string 'null'", () => {
    expect(stripMarkup(null)).toBe("");
  });

  test("collapses runaway blank lines", () => {
    expect(stripMarkup("<p>a</p><br/><br/><br/><p>b</p>")).toBe("a\n\nb");
  });

  test("drops the indentation the HTML editor leaves at the start of lines", () => {
    // Seen verbatim in a tenant's WhatsApp on 2026-09-02: the authored body was
    // pretty-printed, and every paragraph arrived with seven leading spaces.
    expect(stripMarkup("<p>Dear Ahmed,</p>\n       <p>Your balance is due.</p>")).toBe(
      "Dear Ahmed,\nYour balance is due.",
    );
  });

  test("cells are separated by a space and rows by a newline", () => {
    // The WhatsApp text of an invoice send arrived as
    // "رقم الفاتورةINV-0003154المستأجر…" — no separator between <td> cells.
    const html =
      "<table><tr><td>رقم الفاتورة</td><td>INV-1</td></tr><tr><td>الفترة</td><td>8/2026</td></tr></table>";
    expect(stripMarkup(html)).toBe("رقم الفاتورة INV-1\nالفترة 8/2026");
  });

  test("a full two-by-two grid reads one row per line with no trailing space", () => {
    expect(
      stripMarkup("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>"),
    ).toBe("a b\nc d");
  });
});

describe("the seeded invoice-document body over WhatsApp", () => {
  test("cells are separated in the real indented body, and no discount rows appear at zero", async () => {
    const { SEEDED_BODIES } = await import("@/lib/__fixtures__/seededBodies");
    const rendered = renderTemplate(SEEDED_BODIES["invoice-document"].ar, {
      tenant_name: "شركة",
      invoice_number: "INV-0003154",
      unit_name: "محل - 2",
      property_name: "مجمع",
      period: "8/2026",
      issue_date: "2026-08-19",
      due_date: "2026-08-15",
      subtotal: "3,030 KWD",
      discount: "0 KWD",
      has_discount: "",
      paid: "3,030 KWD",
      total: "3,030 KWD",
    });
    const text = stripMarkup(rendered);
    expect(text).toContain("رقم الفاتورة INV-0003154");
    expect(text).not.toContain("الخصم");
    expect(text).not.toContain("رقم الفاتورةINV");
  });
});
