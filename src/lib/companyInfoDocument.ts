/**
 * Company information letterhead — a stylish single-page document carrying the
 * full set of company contact / bank details.
 *
 * Sole consumer: the "Export company information (PDF)" button on
 * /admin/settings, which renders this through the client-side
 * `downloadHtmlAsPdf` (html2canvas) pipeline.
 *
 * NOT used by the `sendCompanyInfo` server fn. That path cannot reuse this
 * HTML: it has no DOM to rasterise, so it builds a plain-table email body
 * inline and renders its attachment with pdfkit (`src/lib/companyInfoPdf.ts`).
 * The two therefore differ by design — this is the rich letterhead, that is a
 * plain summary. If you change branding here, change it there too.
 */

import type { Company } from "@/hooks/useCompany";
import type { Locale } from "@/i18n/dictionary";
import { safeFilename } from "@/lib/safeFilename";
import { ARABIC_FONT_STACK } from "@/lib/documentFonts";

export interface CompanyInfoDocument {
  /** Full letterhead HTML, ready for print / preview / PDF capture. */
  html: string;
  /** Browser tab title and the PDF's suggested name. */
  title: string;
  /** Download filename, including the .pdf extension. */
  filename: string;
  extraCss: string;
  dir: "rtl" | "ltr";
}

function esc(value: string | number | null | undefined): string {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const companyInfoExtraCss = `
  @page { size: A4; margin: 12mm; }
  body { font-size: 12px; }
  .print-sheet { min-height: auto !important; box-shadow: none !important; }
`;

const COMPANY_INFO_CSS = `
  .ci-doc {
    padding: 14mm 14mm 12mm;
    color: #0f172a;
    font-family: ${ARABIC_FONT_STACK};
  }
  .ci-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    border-bottom: 3px solid #d4af37;
    padding-bottom: 14px;
    margin-bottom: 16px;
  }
  .ci-brand {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }
  .ci-logo {
    width: 92px;
    height: 92px;
    object-fit: contain;
    flex-shrink: 0;
    border-radius: 10px;
  }
  .ci-logo-fallback {
    width: 92px;
    height: 92px;
    border: 1.5px solid #d4af37;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 26px;
    font-weight: 800;
    color: #d4af37;
    background: #fffbeb;
    flex-shrink: 0;
  }
  .ci-brand-text h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 900;
    color: #0f172a;
    line-height: 1.25;
  }
  .ci-brand-text .sub {
    margin: 4px 0 0;
    font-size: 13px;
    color: #64748b;
  }
  .ci-stamp {
    text-align: end;
    font-size: 11px;
    color: #94a3b8;
    white-space: nowrap;
  }
  .ci-stamp .doc-title {
    font-size: 14px;
    font-weight: 800;
    color: #d4af37;
    margin-bottom: 2px;
  }
  .ci-section {
    margin-top: 14px;
  }
  .ci-section h2 {
    margin: 0 0 8px;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: #ffffff;
    background: linear-gradient(90deg, #d4af37, #b8941f);
    display: inline-block;
    padding: 4px 12px;
    border-radius: 6px;
  }
  .ci-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 22px;
    font-size: 12.5px;
  }
  .ci-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px dashed #e2e8f0;
    padding: 6px 0;
  }
  .ci-row .label { color: #64748b; }
  .ci-row .value { font-weight: 600; text-align: end; }
  .ci-row .value a { color: #0369a1; text-decoration: none; }
  .ci-bank {
    margin-top: 14px;
    border: 1.5px solid #d4af37;
    border-radius: 10px;
    padding: 12px 14px;
    background: #fffbeb;
  }
  .ci-bank-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
  }
  .ci-bank-logo {
    height: 40px;
    width: auto;
    max-width: 140px;
    object-fit: contain;
  }
  .ci-bank h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 800;
    color: #92400e;
  }
  .ci-iban {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 1px;
    color: #0f172a;
    direction: ltr;
    text-align: start;
  }
  .ci-footer {
    margin-top: 22px;
    padding-top: 10px;
    border-top: 1px solid #e2e8f0;
    font-size: 10.5px;
    line-height: 1.6;
    color: #94a3b8;
    text-align: center;
  }
  @media print {
    .ci-doc { padding: 0; }
  }
`;

/**
 * Build the company-information letterhead HTML.
 *
 * @param company The company row. Tolerates null (renders placeholders) so a
 *   half-loaded page never throws.
 * @param locale Active UI locale; drives labels + text direction.
 * @param labels Caller-supplied label strings (kept out of this module so the
 *   lib has no dependency on the i18n dictionary; the caller passes the
 *   already-translated strings). All keys are optional with sensible fallbacks.
 */
export function buildCompanyInfoHtml(
  company: Company | null,
  locale: Locale,
  labels: {
    docTitle: string;
    contactTitle: string;
    bankTitle: string;
    issuedOn: string;
    address: string;
    email: string;
    whatsapp: string;
    phone: string;
    facebook: string;
    instagram: string;
    bankName: string;
    iban: string;
    website: string;
  },
): string {
  const c = company;
  const namePrimary = (locale === "ar" ? c?.name_ar : (c?.name_en ?? c?.name_ar)) || "—";
  const nameSecondary = locale === "ar" ? (c?.name_en ?? "") : (c?.name_ar ?? "");

  const logo = c?.logo_url
    ? `<img class="ci-logo" src="${esc(c.logo_url)}" alt="${esc(namePrimary)}" />`
    : `<div class="ci-logo-fallback">${esc(namePrimary.slice(0, 2) || "—")}</div>`;

  const today = new Date();
  const dateStr = new Intl.DateTimeFormat(locale === "ar" ? "ar-KW-u-nu-latn" : "en-KW", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(today);

  const contactRows: Array<{ label: string; value: string; href?: string; ltr?: boolean }> = [];
  if (c?.address_ar || c?.address_en) {
    contactRows.push({
      label: labels.address,
      value:
        locale === "ar"
          ? (c?.address_ar ?? c?.address_en ?? "")
          : (c?.address_en ?? c?.address_ar ?? ""),
    });
  }
  if (c?.email)
    contactRows.push({ label: labels.email, value: c.email, href: `mailto:${c.email}`, ltr: true });
  if (c?.whatsapp || c?.phone) {
    contactRows.push({
      label: labels.whatsapp,
      value: c.whatsapp ?? c.phone ?? "",
      ltr: true,
    });
  }
  if (c?.phone && c?.whatsapp) {
    contactRows.push({ label: labels.phone, value: c.phone, ltr: true });
  }
  if (c?.facebook_url)
    contactRows.push({
      label: labels.facebook,
      value: c.facebook_url,
      href: c.facebook_url,
      ltr: true,
    });
  if (c?.instagram_url)
    contactRows.push({
      label: labels.instagram,
      value: c.instagram_url,
      href: c.instagram_url,
      ltr: true,
    });
  if (c?.map_url)
    contactRows.push({ label: labels.website, value: c.map_url, href: c.map_url, ltr: true });

  const bankLogo = c?.bank_logo_url
    ? `<img class="ci-bank-logo" src="${esc(c.bank_logo_url)}" alt="${esc(c.bank_name ?? "bank")}" />`
    : "";

  const bankBlock =
    c && (c.iban || c.bank_name)
      ? `
      <div class="ci-section">
        <div class="ci-bank">
          <div class="ci-bank-header">
            ${bankLogo}
            <h3>${esc(labels.bankTitle)}</h3>
          </div>
          ${c.bank_name ? `<div class="ci-row"><span class="label">${esc(labels.bankName)}</span><span class="value">${esc(c.bank_name)}</span></div>` : ""}
          ${c.iban ? `<div class="ci-row"><span class="label">${esc(labels.iban)}</span><span class="value ci-iban">${esc(c.iban)}</span></div>` : ""}
        </div>
      </div>`
      : "";

  return `
<style>${COMPANY_INFO_CSS}</style>
<article class="ci-doc" dir="${locale === "ar" ? "rtl" : "ltr"}" lang="${locale}">
  <header class="ci-header">
    <div class="ci-brand">
      ${logo}
      <div class="ci-brand-text">
        <h1>${esc(namePrimary)}</h1>
        ${nameSecondary ? `<p class="sub">${esc(nameSecondary)}</p>` : ""}
      </div>
    </div>
    <div class="ci-stamp">
      <div class="doc-title">${esc(labels.docTitle)}</div>
      <div>${esc(labels.issuedOn)}: ${esc(dateStr)}</div>
    </div>
  </header>

  ${
    contactRows.length
      ? `<div class="ci-section">
        <h2>${esc(labels.contactTitle)}</h2>
        <div class="ci-grid">
          ${contactRows
            .map(
              (row) => `
            <div class="ci-row">
              <span class="label">${esc(row.label)}</span>
              <span class="value"${row.ltr ? ' dir="ltr"' : ""}>${
                row.href ? `<a href="${esc(row.href)}">${esc(row.value)}</a>` : esc(row.value)
              }</span>
            </div>`,
            )
            .join("")}
        </div>
      </div>`
      : ""
  }

  ${bankBlock}

  <footer class="ci-footer">
    ${
      locale === "ar"
        ? (c?.invoice_footer_ar ?? c?.invoice_footer_en ?? esc(namePrimary))
        : (c?.invoice_footer_en ?? c?.invoice_footer_ar ?? esc(namePrimary))
    }
  </footer>
</article>
`;
}

/** Compose the full document descriptor (HTML + title + filename + CSS). */
export function buildCompanyInfoDocument(
  company: Company | null,
  locale: Locale,
  labels: {
    docTitle: string;
    contactTitle: string;
    bankTitle: string;
    issuedOn: string;
    address: string;
    email: string;
    whatsapp: string;
    phone: string;
    facebook: string;
    instagram: string;
    bankName: string;
    iban: string;
    website: string;
  },
): CompanyInfoDocument {
  const companyName = company?.name_ar || company?.name_en || "";
  const dir: "rtl" | "ltr" = locale === "ar" ? "rtl" : "ltr";

  return {
    html: buildCompanyInfoHtml(company, locale, labels),
    title: `${labels.docTitle} — ${companyName}`,
    filename: `${safeFilename(companyName || labels.docTitle)}.pdf`,
    extraCss: companyInfoExtraCss,
    dir,
  };
}
