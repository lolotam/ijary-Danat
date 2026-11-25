import { describe, expect, it } from "vitest";

import { buildCompanyInfoDocument, buildCompanyInfoHtml } from "@/lib/companyInfoDocument";
import type { Company } from "@/hooks/useCompany";

const LABELS = {
  docTitle: "Company information",
  contactTitle: "Contact information",
  bankTitle: "Bank details",
  issuedOn: "Issued on",
  address: "Address",
  email: "Email",
  whatsapp: "WhatsApp",
  phone: "Phone",
  facebook: "Facebook",
  instagram: "Instagram",
  bankName: "Bank",
  iban: "IBAN",
  website: "Website",
};

const company = {
  name_ar: "دانة المستقبل العقارية",
  name_en: "Danat Al Mustaqbal",
  address_ar: "الكويت، حولي",
  address_en: "Hawally, Kuwait",
  email: "info@example.com",
  whatsapp: "+96512345678",
  phone: "+96587654321",
  facebook_url: "https://facebook.com/example",
  instagram_url: "https://instagram.com/example",
  bank_name: "NBK",
  iban: "KW81CBKU0000000000001234560101",
  logo_url: "https://cdn.example.com/logo.png",
  bank_logo_url: "https://cdn.example.com/nbk.png",
} as unknown as Company;

/**
 * The builder inlines its stylesheet, so every class name appears in the
 * output as a CSS selector whether or not the block is rendered. Assertions
 * about presence/absence of a block must look at the markup only.
 */
function markup(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/g, "");
}

describe("buildCompanyInfoHtml", () => {
  it("leads with the locale's own name and direction", () => {
    const ar = buildCompanyInfoHtml(company, "ar", LABELS);
    expect(ar).toContain('dir="rtl"');
    expect(ar).toContain('lang="ar"');
    expect(ar.indexOf("دانة المستقبل العقارية")).toBeLessThan(ar.indexOf("Danat Al Mustaqbal"));

    const en = buildCompanyInfoHtml(company, "en", LABELS);
    expect(en).toContain('dir="ltr"');
    expect(en.indexOf("Danat Al Mustaqbal")).toBeLessThan(en.indexOf("دانة المستقبل العقارية"));
  });

  it("picks the address matching the locale", () => {
    expect(buildCompanyInfoHtml(company, "ar", LABELS)).toContain("الكويت، حولي");
    expect(buildCompanyInfoHtml(company, "en", LABELS)).toContain("Hawally, Kuwait");
  });

  it("renders the logo when present and a monogram fallback when not", () => {
    expect(buildCompanyInfoHtml(company, "en", LABELS)).toContain(
      'src="https://cdn.example.com/logo.png"',
    );
    const noLogo = { ...company, logo_url: null } as Company;
    expect(buildCompanyInfoHtml(noLogo, "en", LABELS)).toContain("ci-logo-fallback");
  });

  it("renders the bank block with an LTR IBAN, and drops it without bank details", () => {
    const html = buildCompanyInfoHtml(company, "ar", LABELS);
    expect(html).toContain("KW81CBKU0000000000001234560101");
    expect(html).toContain("ci-iban");
    expect(html).toContain('src="https://cdn.example.com/nbk.png"');

    const noBank = { ...company, bank_name: null, iban: null } as Company;
    expect(markup(buildCompanyInfoHtml(noBank, "ar", LABELS))).not.toContain("ci-bank");
  });

  it("links email and social handles", () => {
    const html = buildCompanyInfoHtml(company, "en", LABELS);
    expect(html).toContain('href="mailto:info@example.com"');
    expect(html).toContain('href="https://facebook.com/example"');
    expect(html).toContain('href="https://instagram.com/example"');
  });

  it("renders a placeholder rather than throwing on a null company", () => {
    const html = buildCompanyInfoHtml(null, "ar", LABELS);
    expect(html).toContain("—");
    expect(markup(html)).not.toContain("ci-bank");
  });

  it("escapes HTML in company fields", () => {
    const hostile = { ...company, name_en: "<script>alert(1)</script>" } as Company;
    const html = buildCompanyInfoHtml(hostile, "en", LABELS);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("omits the contact section when there is nothing to show", () => {
    const bare = { name_en: "Acme" } as unknown as Company;
    expect(markup(buildCompanyInfoHtml(bare, "en", LABELS))).not.toContain("ci-grid");
  });
});

describe("buildCompanyInfoDocument", () => {
  it("returns a descriptor with direction, title and a safe filename", () => {
    const doc = buildCompanyInfoDocument(company, "ar", LABELS);
    expect(doc.dir).toBe("rtl");
    expect(doc.title).toContain(LABELS.docTitle);
    expect(doc.filename).toMatch(/\.pdf$/);
    expect(doc.filename).not.toMatch(/[/\\:*?"<>|]/);
    expect(doc.extraCss).toContain("@page");
  });

  it("falls back to the doc title for the filename when no company name exists", () => {
    const doc = buildCompanyInfoDocument(null, "en", LABELS);
    expect(doc.dir).toBe("ltr");
    expect(doc.filename).toMatch(/\.pdf$/);
  });

  it("carries the same HTML as the direct builder", () => {
    const doc = buildCompanyInfoDocument(company, "en", LABELS);
    expect(doc.html).toBe(buildCompanyInfoHtml(company, "en", LABELS));
  });
});
