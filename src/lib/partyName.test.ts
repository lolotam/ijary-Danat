import { describe, expect, it } from "vitest";

import { resolvePartyName } from "@/lib/partyName";

describe("resolvePartyName", () => {
  it("prints the commercial name in the document's own language", () => {
    const tenant = {
      commercial_name_ar: "مقهى الدانة",
      commercial_name_en: "Danat Cafe",
      name_ar: "شركة x",
      name_en: "Company X",
    };
    expect(resolvePartyName(tenant, "ar")).toBe("مقهى الدانة");
    expect(resolvePartyName(tenant, "en")).toBe("Danat Cafe");
  });

  it("falls back to the other language's commercial name, not to the personal name", () => {
    // A commercial party stays a commercial party. Dropping to `name` would put
    // a different legal entity on the invoice.
    const arabicOnly = {
      commercial_name_ar: "مقهى الدانة",
      commercial_name_en: null,
      name_ar: "شركة x",
      name_en: "Company X",
    };
    expect(resolvePartyName(arabicOnly, "en")).toBe("مقهى الدانة");

    const englishOnly = {
      commercial_name_ar: null,
      commercial_name_en: "Danat Cafe",
      name_ar: "شركة x",
      name_en: "Company X",
    };
    expect(resolvePartyName(englishOnly, "ar")).toBe("Danat Cafe");
  });

  it("still reads the pre-140 column for rows loaded by a narrow select", () => {
    const legacy = { commercial_name: "Danat Cafe", name_ar: "شركة x", name_en: "Company X" };
    expect(resolvePartyName(legacy, "ar")).toBe("Danat Cafe");
    expect(resolvePartyName(legacy, "en")).toBe("Danat Cafe");
  });

  it("prefers a bilingual column over the legacy mirror", () => {
    const both = {
      commercial_name: "Stale Mirror",
      commercial_name_en: "Danat Cafe",
      name_en: "Company X",
    };
    expect(resolvePartyName(both, "en")).toBe("Danat Cafe");
  });

  it("falls back to the tenant name when there is no commercial name at all", () => {
    const tenant = {
      commercial_name_ar: null,
      commercial_name_en: null,
      name: "شركة الدانة",
      name_en: "Danat Co",
    };
    expect(resolvePartyName(tenant, "ar")).toBe("شركة الدانة");
    expect(resolvePartyName(tenant, "en")).toBe("Danat Co");
  });

  it("treats a whitespace-only commercial name as missing", () => {
    // "   " is truthy in JS and would otherwise print a blank party.
    expect(
      resolvePartyName({ commercial_name_ar: "   ", name_ar: null, name_en: "Company X" }, "ar"),
    ).toBe("Company X");
    expect(
      resolvePartyName(
        { commercial_name_en: "  ", commercial_name_ar: "مقهى", name_en: "X" },
        "en",
      ),
    ).toBe("مقهى");
  });

  it("reads tenants.name as the Arabic name, as the live schema stores it", () => {
    const row = { commercial_name_ar: null, name: "شركة الدانة", name_en: "Danat Co" };
    expect(resolvePartyName(row, "ar")).toBe("شركة الدانة");
  });
});
