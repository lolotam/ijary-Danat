import { describe, expect, test } from "vitest";

import { contractIssuerFromCompany } from "./issuer";

describe("contractIssuerFromCompany", () => {
  test("takes the Arabic name and address first, trimmed, with the company's logo", () => {
    expect(
      contractIssuerFromCompany({
        name_ar: "  شركة النخبة ",
        name_en: "Elite Co",
        address_ar: "حولي – مكتب 3",
        address_en: "Hawalli office 3",
        phone: " 25550000 ",
        logo_url: " https://cdn.example.test/logo.png ",
      }),
    ).toEqual({
      name: "شركة النخبة",
      address: "حولي – مكتب 3",
      phone: "25550000",
      logoUrl: "https://cdn.example.test/logo.png",
    });
  });

  test("falls back to the English fields when the Arabic ones are blank", () => {
    expect(
      contractIssuerFromCompany({
        name_ar: " ",
        name_en: "Elite Co",
        address_ar: null,
        address_en: "Hawalli office 3",
        phone: null,
        logo_url: null,
      }),
    ).toEqual({ name: "Elite Co", address: "Hawalli office 3", phone: "", logoUrl: null });
  });

  test.each(["javascript:alert(1)", "data:image/png;base64,AAAA", "not a url", "  "])(
    "a logo setting that is not a web URL (%s) prints no logo",
    (logo_url) => {
      const issuer = contractIssuerFromCompany({
        name_ar: "شركة النخبة",
        name_en: null,
        address_ar: null,
        address_en: null,
        phone: null,
        logo_url,
      });
      expect(issuer.logoUrl).toBeNull();
    },
  );

  test("a company not loaded yet yields blank fields, never another company's", () => {
    expect(contractIssuerFromCompany(null)).toEqual({
      name: "",
      address: "",
      phone: "",
      logoUrl: null,
    });
  });
});
