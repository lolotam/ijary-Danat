import { describe, expect, it } from "vitest";

import { isContractEnded, tenantDisplayName } from "./tenantDisplayName";

describe("tenantDisplayName", () => {
  it("returns the Arabic name in Arabic regardless of name_en", () => {
    expect(tenantDisplayName({ name: "شركة الدانة", name_en: "Danat Co" }, "ar")).toBe(
      "شركة الدانة",
    );
  });

  it("returns name_en in English when present", () => {
    expect(tenantDisplayName({ name: "شركة الدانة", name_en: "Danat Co" }, "en")).toBe("Danat Co");
  });

  it("falls back to the Arabic name when name_en is missing or blank", () => {
    expect(tenantDisplayName({ name: "شركة الدانة", name_en: null }, "en")).toBe("شركة الدانة");
    expect(tenantDisplayName({ name: "شركة الدانة", name_en: "   " }, "en")).toBe("شركة الدانة");
    expect(tenantDisplayName({ name: "شركة الدانة" }, "en")).toBe("شركة الدانة");
  });
});

describe("isContractEnded", () => {
  it.each([
    { lifecycle: "active", expected: false },
    { lifecycle: "inactive", expected: false },
    { lifecycle: "blocked", expected: false },
    { lifecycle: "contract_ended", expected: true },
  ])("returns $expected for lifecycle $lifecycle", ({ lifecycle, expected }) => {
    expect(isContractEnded({ lifecycle })).toBe(expected);
  });
});
