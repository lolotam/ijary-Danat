import { describe, expect, test } from "vitest";

import { LEGACY_TEMPLATE_CODES, LEGACY_TEMPLATE_STEMS } from "@/lib/legacyTemplateCodes";

describe("legacy template codes", () => {
  test("derives both suffixed codes from every stem", () => {
    expect(LEGACY_TEMPLATE_STEMS).toContain("receipt");
    expect(LEGACY_TEMPLATE_CODES).toContain("receipt-ar");
    expect(LEGACY_TEMPLATE_CODES).toContain("receipt-en");
    expect(LEGACY_TEMPLATE_CODES).toHaveLength(LEGACY_TEMPLATE_STEMS.length * 2);
  });

  // The list must not accidentally cover an admin-created code.
  test("does not include an arbitrary -ar code", () => {
    expect(LEGACY_TEMPLATE_CODES).not.toContain("lease-renewal-ar");
  });
});
