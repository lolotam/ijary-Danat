/**
 * Server-side company-information PDF renderer.
 *
 * Used by `src/fns/sendCompanyInfo.ts` to attach a real PDF to the
 * "Send Company Information" email (the client-side Export button uses the
 * HTML+html2canvas path instead — see `companyInfoDocument.ts`).
 *
 * Why a separate PDF path (not html2canvas): the server has no DOM, so the
 * client pipeline cannot run. `pdfkit` is pure-JS and runs in the nitro
 * serverless runtime with no native deps.
 *
 * Font note — why this PDF is Latin-only:
 * pdfkit's built-in fonts (Helvetica/Courier) are WinAnsi-encoded, which has
 * no Arabic range at all. Passing Arabic through them does not merely render
 * "disconnected" glyphs: pdfkit emits the raw codepoint hex digits as
 * single-byte codes, so "معلومات الشركة" comes out of the content stream as
 * `<645639644648...>` and the reader paints mojibake. Embedding an Arabic TTF
 * would fix the encoding but still not the *shaping* — pdfkit has no
 * harfbuzz, so letters would not join and the run would not be reordered RTL.
 *
 * So the PDF attachment is deliberately an English-labelled summary that
 * prefers the English fields (`name_en`, `address_en`), and callers must pass
 * Latin labels — see `PDF_LABELS` in `src/fns/sendCompanyInfo.ts`. The fully
 * styled, correctly-shaped Arabic letterhead still reaches the tenant as the
 * HTML email body and via the client-side Export button, both of which render
 * in a real text engine. This mirrors how the deposit-confirmation flow pairs
 * an HTML body with a file attachment.
 */

import type PDFKit from "pdfkit";

import type { Company } from "@/hooks/useCompany";

const BRAND = "#0f766e";
const INK = "#0f172a";
const MUTED = "#64748b";

export interface CompanyInfoPdfLabels {
  docTitle: string;
  contactTitle: string;
  bankTitle: string;
  issuedOn: string;
  address: string;
  email: string;
  whatsapp: string;
  facebook: string;
  instagram: string;
  bankName: string;
  iban: string;
  website: string;
  phone: string;
}

/**
 * Fetch a remote image (logo / bank logo) into a Buffer for embedding.
 * Returns null on any failure so the caller can fall back to a text monogram.
 */
export async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.startsWith("image/")) return null;
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch {
    return null;
  }
}

/**
 * Lay out and write one company-info PDF page onto `doc` (a pdfkit document).
 * Caller is responsible for ending the document and collecting the bytes.
 */
export function layoutCompanyInfoPdf(
  doc: InstanceType<typeof PDFKit>,
  pageWidth: number,
  margin: number,
  company: Company,
  labels: CompanyInfoPdfLabels,
  logos: { company: Buffer | null; bank: Buffer | null },
): void {
  const contentW = pageWidth - margin * 2;

  // ---- Header: logo + name (left), title + date (right) ----
  let cursorY = margin;
  const headerBottom = margin + 90;

  if (logos.company) {
    try {
      doc.image(logos.company, margin, cursorY, { width: 70, height: 70 });
    } catch {
      /* unsupported image format — skip silently */
    }
  }

  doc
    .fillColor(BRAND)
    .fontSize(11)
    .font("Helvetica-Bold")
    .text(labels.docTitle.toUpperCase(), margin + 84, cursorY, { width: contentW - 84 });
  doc
    .fillColor(INK)
    .fontSize(20)
    .font("Helvetica-Bold")
    .text(company.name_en || company.name_ar || "—", margin + 84, cursorY + 16, {
      width: contentW - 84,
    });
  const dateStr = new Intl.DateTimeFormat("en-KW", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());
  doc
    .fillColor(MUTED)
    .fontSize(10)
    .font("Helvetica")
    .text(`${labels.issuedOn}: ${dateStr}`, margin + 84, cursorY + 44, {
      width: contentW - 84,
    });

  // Gold rule under the header
  cursorY = headerBottom + 6;
  doc.rect(margin, cursorY, contentW, 1.5).fillColor(BRAND).fill();
  cursorY += 18;

  // ---- Contact section ----
  doc
    .fillColor(INK)
    .fontSize(12)
    .font("Helvetica-Bold")
    .text(labels.contactTitle, margin, cursorY, {
      width: contentW,
    });
  cursorY += 18;

  const rows: Array<[string, string | null | undefined]> = [];
  if (company.address_en || company.address_ar)
    rows.push([labels.address, company.address_en || company.address_ar]);
  if (company.email) rows.push([labels.email, company.email]);
  if (company.whatsapp) rows.push([labels.whatsapp, company.whatsapp]);
  if (company.phone) rows.push([labels.phone, company.phone]);
  if (company.facebook_url) rows.push([labels.facebook, company.facebook_url]);
  if (company.instagram_url) rows.push([labels.instagram, company.instagram_url]);
  if (company.map_url) rows.push([labels.website, company.map_url]);

  for (const [label, value] of rows) {
    doc.fillColor(MUTED).font("Helvetica").text(label, margin, cursorY, { width: 160 });
    doc
      .fillColor(INK)
      .font("Helvetica-Bold")
      .text(String(value), margin + 170, cursorY, { width: contentW - 170 });
    cursorY += 16;
  }
  cursorY += 10;

  // ---- Bank section (boxed) ----
  if (company.bank_name || company.iban) {
    const boxH = 70;
    doc.rect(margin, cursorY, contentW, boxH).fillColor("#fffbeb").fill();
    doc.lineWidth(1).strokeColor(BRAND).rect(margin, cursorY, contentW, boxH).stroke();

    let bankCursorX = margin + 14;
    if (logos.bank) {
      try {
        doc.image(logos.bank, bankCursorX, cursorY + 15, { height: 40 });
        bankCursorX += 120;
      } catch {
        /* skip */
      }
    }
    doc
      .fillColor("#92400e")
      .fontSize(12)
      .font("Helvetica-Bold")
      .text(labels.bankTitle, bankCursorX, cursorY + 12, { width: contentW - 28 });
    let bankY = cursorY + 30;
    if (company.bank_name) {
      doc.fillColor(MUTED).font("Helvetica").text(labels.bankName, bankCursorX, bankY, {
        width: 120,
      });
      doc
        .fillColor(INK)
        .font("Helvetica-Bold")
        .text(company.bank_name, bankCursorX + 130, bankY, { width: contentW - 158 });
      bankY += 16;
    }
    if (company.iban) {
      doc.fillColor(MUTED).font("Helvetica").text(labels.iban, bankCursorX, bankY, { width: 120 });
      doc
        .fillColor(INK)
        .font("Courier-Bold")
        .fontSize(11)
        .text(company.iban, bankCursorX + 130, bankY, { width: contentW - 158 });
    }
    cursorY += boxH + 16;
  }

  // ---- Footer ----
  doc
    .fillColor(MUTED)
    .fontSize(9)
    .font("Helvetica")
    .text(
      company.invoice_footer_en ||
        company.invoice_footer_ar ||
        company.name_en ||
        company.name_ar ||
        "",
      margin,
      cursorY,
      { width: contentW, align: "center" },
    );
}
