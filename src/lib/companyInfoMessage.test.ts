import { describe, expect, it } from "vitest";

import {
  AR_MESSAGE,
  EN_MESSAGE,
  buildEmailBody,
  buildWhatsappBody,
  messageLabelsFor,
  resolveCompanyInfoBodies,
} from "@/lib/companyInfoMessage";
import type { Company } from "@/hooks/useCompany";

const company = {
  name_ar: "دانة المستقبل العقارية",
  name_en: "Danat Al Mustaqbal",
  email: "info@example.com",
  whatsapp: "+96512345678",
  bank_name: "NBK",
  iban: "KW81CBKU0000000000001234560101",
} as unknown as Company;

const PORTAL = "https://danat-future.com/portal";

describe("messageLabelsFor", () => {
  it("selects Arabic wording for ar and English for en", () => {
    expect(messageLabelsFor("ar")).toBe(AR_MESSAGE);
    expect(messageLabelsFor("en")).toBe(EN_MESSAGE);
  });
});

describe("buildEmailBody", () => {
  it("marks an Arabic body RTL", () => {
    // Regression: the body was hardcoded dir="ltr", which mis-ordered
    // punctuation and phone numbers inside Arabic text.
    expect(buildEmailBody(AR_MESSAGE, company, PORTAL, "ar")).toContain('dir="rtl"');
  });

  it("marks an English body LTR", () => {
    expect(buildEmailBody(EN_MESSAGE, company, PORTAL, "en")).toContain('dir="ltr"');
  });

  it("pins the IBAN LTR even inside an RTL body", () => {
    const html = buildEmailBody(AR_MESSAGE, company, PORTAL, "ar");
    const ibanCell = html.slice(html.indexOf(AR_MESSAGE.iban));
    expect(ibanCell).toContain('dir="ltr"');
    expect(ibanCell).toContain("KW81CBKU0000000000001234560101");
  });

  it("uses the Arabic company name in Arabic and the English one in English", () => {
    expect(buildEmailBody(AR_MESSAGE, company, PORTAL, "ar")).toContain("دانة المستقبل العقارية");
    expect(buildEmailBody(EN_MESSAGE, company, PORTAL, "en")).toContain("Danat Al Mustaqbal");
  });

  it("falls back to the other script when the preferred name is missing", () => {
    const arOnly = { ...company, name_en: null } as unknown as Company;
    expect(buildEmailBody(EN_MESSAGE, arOnly, PORTAL, "en")).toContain("دانة المستقبل العقارية");
  });

  it("escapes HTML in company fields", () => {
    const hostile = { ...company, bank_name: '<script>alert("x")</script>' } as Company;
    const html = buildEmailBody(EN_MESSAGE, hostile, PORTAL, "en");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
  });

  it("omits rows for absent fields and the link when there is no portal URL", () => {
    const bare = { name_en: "Acme" } as unknown as Company;
    const html = buildEmailBody(EN_MESSAGE, bare, undefined, "en");
    expect(html).toContain("Acme");
    expect(html).not.toContain("IBAN");
    expect(html).not.toContain("<a href");
  });

  it("labels the subject heading, not the PDF doc title", () => {
    expect(buildEmailBody(AR_MESSAGE, company, PORTAL, "ar")).toContain(AR_MESSAGE.subject);
  });
});

describe("resolveCompanyInfoBodies", () => {
  it("keeps WhatsApp on the generated details even when the email seed mentions an attachment", () => {
    const resolved = resolveCompanyInfoBodies(
      {
        subject: "Company information",
        body: "<p>Dear Ahmed, please find attached our company contact and bank details.</p>",
      },
      EN_MESSAGE,
      company,
      PORTAL,
      "en",
    );
    expect(resolved.emailInnerBody).toContain("please find attached");
    expect(resolved.waBody).toContain("IBAN: KW81CBKU0000000000001234560101");
    expect(resolved.waBody).toContain(PORTAL);
    expect(resolved.waBody).not.toMatch(/attached|مرفق/i);
  });
});

describe("buildWhatsappBody", () => {
  it("produces a newline-separated plain-text summary", () => {
    const text = buildWhatsappBody(EN_MESSAGE, company, PORTAL, "en");
    const lines = text.split("\n");
    expect(lines[0]).toBe(EN_MESSAGE.waBody);
    expect(lines).toContain("Company: Danat Al Mustaqbal");
    expect(lines).toContain("IBAN: KW81CBKU0000000000001234560101");
    expect(lines.at(-1)).toBe(PORTAL);
  });

  it("uses Arabic labels for an Arabic send", () => {
    const text = buildWhatsappBody(AR_MESSAGE, company, PORTAL, "ar");
    expect(text).toContain("الشركة: دانة المستقبل العقارية");
    expect(text).toContain(`${AR_MESSAGE.iban}: KW81CBKU0000000000001234560101`);
  });

  it("carries no HTML markup", () => {
    expect(buildWhatsappBody(EN_MESSAGE, company, PORTAL, "en")).not.toMatch(/<[a-z/]/i);
  });

  it("skips absent fields", () => {
    const bare = { name_en: "Acme" } as unknown as Company;
    const text = buildWhatsappBody(EN_MESSAGE, bare, undefined, "en");
    expect(text).toBe(`${EN_MESSAGE.waBody}\nCompany: Acme`);
  });
});
