import { describe, it, expect } from "vitest";

import { normalizePostgrestSearch } from "./querySearch";

describe("normalizePostgrestSearch", () => {
  // Payment references are stored as `AUTO-INV:<invoice code>` by
  // set_invoice_paid. Rewriting the colon to a space produced
  // `reference.ilike.%AUTO-INV INV-0000286%`, which matches nothing — searching
  // for a reference you can read on screen returned no rows.
  it("keeps the colon in a payment reference", () => {
    expect(normalizePostgrestSearch("AUTO-INV:INV-0000286")).toBe("AUTO-INV:INV-0000286");
  });

  it("still strips PostgREST filter syntax", () => {
    // `,` `.` `(` `)` and quotes break out of an or=(...) filter list.
    expect(normalizePostgrestSearch('a,b(c)"d')).toBe("a b c d");
  });

  it("strips the % wildcard so a term cannot widen its own pattern", () => {
    // `_` is ilike's single-character wildcard and is deliberately left alone:
    // it predates this change and is needed for codes that contain it.
    expect(normalizePostgrestSearch("a%b_c")).toBe("a b_c");
  });

  it("keeps the characters that identify tenants and invoices", () => {
    expect(normalizePostgrestSearch("INV-0000286")).toBe("INV-0000286");
    expect(normalizePostgrestSearch("a.b@example.com")).toBe("a.b@example.com");
  });

  // Not a test of \p{L} itself: this pins the requirement that narrowing the
  // class to something ASCII-shaped (a tempting "simplification") would break
  // every search in the Arabic UI silently, returning zero rows rather than an
  // error.
  it("preserves Arabic text", () => {
    expect(normalizePostgrestSearch("دانة المستقبل")).toBe("دانة المستقبل");
  });

  it("collapses whitespace, trims, and caps length", () => {
    expect(normalizePostgrestSearch("  a   b  ")).toBe("a b");
    expect(normalizePostgrestSearch("x".repeat(150))).toHaveLength(100);
  });
});
