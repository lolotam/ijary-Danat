import { describe, expect, test } from "vitest";

import { safeFilename } from "@/lib/safeFilename";

describe("safeFilename", () => {
  test("passes a normal English value through", () => {
    expect(safeFilename("Monthly Report")).toBe("Monthly_Report");
  });

  test("keeps Arabic letters and Arabic-Indic digits, replaces spaces with _", () => {
    // U+0661–0663 (١٢٣) fall inside ؀-ۿ; spaces become underscores.
    expect(safeFilename("فاتورة رقم ١٢٣")).toBe("فاتورة_رقم_١٢٣");
  });

  test("replaces spaces, slashes, and unsupported punctuation with _", () => {
    expect(safeFilename("a b/c\\d.e!f")).toBe("a_b_c_d_e_f");
  });

  test("collapses consecutive separators to a single _", () => {
    expect(safeFilename("a   b///c")).toBe("a_b_c");
  });

  test("strips leading and trailing underscores", () => {
    expect(safeFilename("  __hello__  ")).toBe("hello");
  });

  test('returns "document" for empty or whitespace-only input', () => {
    expect(safeFilename("")).toBe("document");
    expect(safeFilename("   ")).toBe("document");
    expect(safeFilename("___")).toBe("document");
  });

  test("keeps hyphens so invoice codes pass through unchanged", () => {
    expect(safeFilename("INV-2026-0001")).toBe("INV-2026-0001");
  });

  test("truncates to 80 characters after strip (result may end in _)", () => {
    // .slice(0, 80) runs AFTER leading/trailing _ strip, so a truncated
    // result can legitimately end in an underscore.
    const input = `${"a".repeat(79)} ${"b".repeat(20)}`;
    const result = safeFilename(input);
    expect(result).toBe(`${"a".repeat(79)}_`);
    expect(result).toHaveLength(80);
  });
});
