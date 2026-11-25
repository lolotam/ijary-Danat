import { describe, expect, it } from "vitest";
import PDFDocument from "pdfkit";
import zlib from "node:zlib";

import { layoutCompanyInfoPdf, type CompanyInfoPdfLabels } from "@/lib/companyInfoPdf";
import type { Company } from "@/hooks/useCompany";

/**
 * Regression cover for the pdfkit attachment path.
 *
 * The bug these guard against: pdfkit's built-in fonts are WinAnsi-encoded and
 * have no Arabic range. Passing Arabic through them does not degrade
 * gracefully — pdfkit writes the raw codepoint hex digits as single-byte
 * codes, so "معلومات الشركة" left the content stream as `<645639644648...>`
 * and every reader painted mojibake. The contract is therefore: the PDF is
 * Latin-only, and these tests fail if Arabic labels are reintroduced.
 */

const LATIN_LABELS: CompanyInfoPdfLabels = {
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
  bank_name: "National Bank of Kuwait",
  iban: "KW81CBKU0000000000001234560101",
  invoice_footer_en: "Thank you for your business",
  logo_url: null,
  bank_logo_url: null,
} as unknown as Company;

/** Render one page and return its raw bytes. */
async function render(c: Company, labels: CompanyInfoPdfLabels): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
  layoutCompanyInfoPdf(doc, doc.page.width, doc.page.margins.left, c, labels, {
    company: null,
    bank: null,
  });
  doc.end();
  const chunks: Buffer[] = [];
  for await (const chunk of doc as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Inflate the page content streams and return every hex string shown via TJ. */
function textHexRuns(pdf: Buffer): string[] {
  const raw = pdf.toString("latin1");
  const runs: string[] = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    let body: string;
    try {
      body = zlib.inflateSync(Buffer.from(match[1], "latin1")).toString("latin1");
    } catch {
      continue;
    }
    for (const show of body.matchAll(/<([0-9a-fA-F]+)>/g)) runs.push(show[1]);
  }
  return runs;
}

/** Decode a WinAnsi hex run back to the string a PDF reader would paint. */
function decodeRun(hex: string): string {
  const even = hex.length % 2 === 0 ? hex : `${hex}0`;
  return Buffer.from(even, "hex").toString("latin1");
}

/**
 * All text the page paints, as one string.
 *
 * Concatenated with no separator on purpose: pdfkit splits a single label into
 * several hex runs wherever it applies kerning, so "Contact information"
 * legitimately arrives as "Contact inf" + "ormation".
 */
function paintedText(pdf: Buffer): string {
  return textHexRuns(pdf).map(decodeRun).join("");
}

describe("layoutCompanyInfoPdf", () => {
  it("produces a valid PDF", async () => {
    const pdf = await render(company, LATIN_LABELS);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(500);
  });

  it("paints Latin labels as readable text", async () => {
    const pdf = await render(company, LATIN_LABELS);
    const painted = paintedText(pdf);

    expect(painted).toContain("Contact information");
    expect(painted).toContain("Bank details");
    expect(painted).toContain("IBAN");
    // English company name is preferred over the Arabic one.
    expect(painted).toContain("Danat Al Mustaqbal");
    expect(painted).toContain("KW81CBKU0000000000001234560101");
  });

  it("prefers the English address and never paints the Arabic one", async () => {
    const pdf = await render(company, LATIN_LABELS);
    const painted = paintedText(pdf);

    expect(painted).toContain("Hawally, Kuwait");
    expect(painted).not.toContain("الكويت");
  });

  it("emits only single-byte-decodable runs for Latin input (no mojibake)", async () => {
    const pdf = await render(company, LATIN_LABELS);
    // Every run must be an even number of hex digits. An odd-length run is the
    // signature of the Arabic bug: pdfkit concatenating 3-digit codepoints
    // like `645` + `639` instead of emitting real character codes.
    for (const run of textHexRuns(pdf)) {
      expect(run.length % 2, `odd-length text run <${run}>`).toBe(0);
    }
  });

  it("demonstrates why Arabic labels are rejected: they do NOT survive the encoder", async () => {
    // This documents the failure mode rather than asserting good behaviour —
    // if pdfkit ever gains Arabic support this test is the one to revisit.
    const pdf = await render(company, { ...LATIN_LABELS, contactTitle: "معلومات التواصل" });
    const painted = paintedText(pdf);
    expect(painted).not.toContain("معلومات التواصل");
  });

  it("omits the bank box entirely when there are no bank details", async () => {
    const pdf = await render({ ...company, bank_name: null, iban: null } as Company, LATIN_LABELS);
    const painted = paintedText(pdf);
    expect(painted).not.toContain("Bank details");
    expect(painted).toContain("Contact information");
  });

  it("renders with every optional field absent", async () => {
    const bare = { name_en: "Acme" } as unknown as Company;
    const pdf = await render(bare, LATIN_LABELS);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
