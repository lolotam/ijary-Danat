import { describe, expect, it } from "vitest";

import { escapeHtml } from "@/lib/html";

describe("escapeHtml", () => {
  it.each([
    ["&", "&amp;"],
    ["<", "&lt;"],
    [">", "&gt;"],
    ['"', "&quot;"],
    // The one three of the six old copies missed: it is what keeps a
    // single-quoted attribute from being broken out of.
    ["'", "&#39;"],
  ])("escapes %s", (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  it("escapes an existing entity once, not twice", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("neutralises a single-quoted attribute breakout", () => {
    expect(escapeHtml("x' onmouseover='alert(1)")).toBe("x&#39; onmouseover=&#39;alert(1)");
  });

  it("leaves plain and Arabic text unchanged", () => {
    expect(escapeHtml("Invoice 42")).toBe("Invoice 42");
    expect(escapeHtml("دانة المستقبل العقارية")).toBe("دانة المستقبل العقارية");
  });
});
