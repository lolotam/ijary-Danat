/**
 * الهيكل المشترك لكل مستند مطبوع: الترويسة، شبكة البيانات، جدول المبالغ والتذييل.
 *
 * The printed invoice (tenant detail → monthly invoices, and the admin invoices
 * page) is the reference document: it is the paper the office hands over and
 * the one the business signed off on. The payment receipt used to be drawn with
 * its own stylesheet — a filled dark-green table head, a grey rounded total
 * pill, a status badge — so the same tenant received two documents that looked
 * like they came from two different companies.
 *
 * Everything that decides how those two documents *look* now lives here, and
 * both builders compose it. A receipt and an invoice therefore cannot drift in
 * palette, spacing, table rules or footer treatment again: there is one
 * stylesheet, and changing it changes both. The close-out statement
 * (`closeoutStatement.ts`) and the company profile (`companyInfoDocument.ts`)
 * still carry their own, and are the obvious next callers.
 */

/** يحوّل الرموز الخاصة إلى كيانات HTML آمنة. */
export function esc(value: string | number | null | undefined): string {
  if (value == null) return "—";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * يعزل نصاً يُقرأ من اليسار إلى اليمين داخل مستند عربي.
 *
 * Phone numbers, IBANs, codes and dates are inherently LTR. Inside `dir="rtl"`
 * the bidirectional algorithm reorders the run and `+965 12345678` renders with
 * its country code on the wrong side.
 *
 * `<bdi>` rather than a styled span: the element's whole purpose is bidi
 * isolation and the UA stylesheet gives it `unicode-bidi: isolate`, so it is
 * still correct in a print/PDF context where the document CSS may not survive.
 * The `dir` attribute goes on this inner element only, never on the row that
 * contains it — `text-align: start` resolves against an element's *own*
 * direction, so an outer `dir="ltr"` would drag the value to the wrong edge of
 * an Arabic page. Same rule as `src/components/ui/ltr-text.tsx`.
 */
export function ltr(value: string | number | null | undefined): string {
  if (value == null || String(value).trim() === "") return "—";
  return `<bdi dir="ltr">${esc(value)}</bdi>`;
}

/**
 * ورقة الأنماط الوحيدة للمستندات المطبوعة.
 *
 * Lifted verbatim from the invoice sheet — the document the user pointed at as
 * correct — and renamed from `invoice-*` to `doc-*` because a receipt rendering
 * under a class called `invoice-row` is how the next person justifies forking
 * it again. The only additions are rules the invoice never needed: a table head
 * (a receipt lists line items, an invoice lists four fixed rows), a right-
 * aligned `.amount` cell for the columns that are not last, and the status
 * colours. Each follows the same palette, so they read as the same paper.
 */
export const PRINTED_DOCUMENT_CSS = `
  .doc-page {
    padding: 10mm 12mm;
    color: #0f172a;
  }
  .doc-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    border-bottom: 2px solid #065f46;
    padding-bottom: 12px;
    margin-bottom: 14px;
  }
  .doc-brand h1 {
    margin: 4px 0 0;
    font-size: 18px;
    font-weight: 800;
    color: #064e3b;
    line-height: 1.3;
  }
  .doc-brand .code {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: #047857;
  }
  .doc-brand .company {
    margin: 4px 0 0;
    font-size: 13px;
    color: #334155;
  }
  .doc-logo {
    width: 88px;
    height: 64px;
    object-fit: contain;
    flex-shrink: 0;
  }
  .doc-logo-fallback {
    width: 88px;
    height: 64px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: 800;
    color: #065f46;
    flex-shrink: 0;
  }
  .doc-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 20px;
    margin-bottom: 14px;
    font-size: 12px;
  }
  .doc-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid #e2e8f0;
    padding: 6px 0;
  }
  .doc-row .label { color: #64748b; }
  .doc-row .value { font-weight: 600; text-align: end; }
  .doc-row .value.confirmed { color: #065f46; }
  .doc-row .value.reversed { color: #b91c1c; }
  .doc-status { margin: 10px 0 0; font-size: 12px; color: #444; }
.doc-amounts {
    width: 100%;
    font-size: 12px;
    margin-top: 4px;
    border-collapse: collapse;
  }
  .doc-amounts thead th {
    padding: 7px 4px;
    border-bottom: 1px solid #e2e8f0;
    color: #64748b;
    font-weight: 700;
    text-align: start;
  }
  .doc-amounts td {
    padding: 7px 4px;
    border-bottom: 1px solid #e2e8f0;
  }
  .doc-amounts td:last-child {
    text-align: end;
    font-weight: 600;
    white-space: nowrap;
  }
  .doc-amounts th.amount { text-align: end; }
  .doc-amounts td.amount {
    text-align: end;
    font-weight: 600;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .doc-amounts td.amount .sub {
    display: block;
    font-size: 10px;
    font-weight: 500;
    color: #64748b;
  }
  .doc-amounts tr.total td {
    border-bottom: 2px solid #065f46;
    padding-top: 10px;
    padding-bottom: 10px;
    font-size: 14px;
    font-weight: 800;
  }
  .doc-note {
    margin-top: 14px;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 12px;
  }
  .doc-note h2 {
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 700;
    color: #334155;
  }
  .doc-note .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.5px;
  }
  .doc-footer {
    margin-top: 16px;
    padding-top: 10px;
    border-top: 1px solid #e2e8f0;
    font-size: 11px;
    line-height: 1.5;
    color: #64748b;
  }
  @media print {
    .doc-page { padding: 0; }
  }
`;

/**
 * يبني ترويسة المستند: الكود ثم العنوان ثم اسم الشركة، والشعار في الطرف الآخر.
 *
 * @param code The document's own number — the one the tenant quotes back.
 * @param title Document type, printed as the single `<h1>` on the page.
 * @param companyName Already-resolved company name for the active locale.
 * @param logoUrl Company logo; a two-letter block stands in when absent so the
 *   header never collapses to an empty corner.
 */
export function renderDocumentHeader({
  code,
  title,
  companyName,
  logoUrl,
}: {
  code: string;
  title: string;
  companyName: string;
  logoUrl?: string | null;
}): string {
  const logo = logoUrl
    ? `<img class="doc-logo" src="${esc(logoUrl)}" alt="${esc(companyName)}" />`
    : `<div class="doc-logo-fallback">${esc(companyName.slice(0, 2) || "—")}</div>`;

  return `
  <header class="doc-header">
    <div class="doc-brand">
      <p class="code">${esc(code)}</p>
      <h1>${esc(title)}</h1>
      <p class="company">${esc(companyName)}</p>
    </div>
    ${logo}
  </header>`;
}

/**
 * صف واحد في شبكة بيانات المستند.
 *
 * `html` carries markup the caller has already made safe — a `<bdi>` wrapper
 * from {@link ltr}, nothing else. `value` is escaped here. Exactly one of the
 * two is meaningful; `html` wins when both are given.
 */
export interface DocumentDetailRow {
  label: string;
  value?: string | number | null;
  html?: string;
  /** Extra class on the value cell; used for the receipt's status colouring. */
  valueClass?: string;
}

/** يبني شبكة البيانات المكوّنة من عمودين (المستأجر، التواريخ، الحالة…). */
export function renderDetailGrid(rows: DocumentDetailRow[]): string {
  return `
  <section class="doc-grid">
    ${rows
      .map(
        (row) => `
    <div class="doc-row">
      <span class="label">${esc(row.label)}</span>
      <span class="value${row.valueClass ? ` ${row.valueClass}` : ""}">${
        row.html ?? esc(row.value)
      }</span>
    </div>`,
      )
      .join("")}
  </section>`;
}

/**
 * يبني تذييل المستند: نص التذييل المخصص، وإلا اسم الشركة ورقم هاتفها.
 *
 * The company footer is admin-editable free text, so it is escaped like any
 * other untrusted field — the print window's CSP would stop a script, but the
 * document is also rasterized into a PDF and mailed out.
 */
export function renderDocumentFooter({
  footerText,
  companyName,
  phone,
}: {
  footerText?: string | null;
  companyName: string;
  phone?: string | null;
}): string {
  if (footerText) return `<footer class="doc-footer">${esc(footerText)}</footer>`;
  return `<footer class="doc-footer">${esc(companyName)}${phone ? ` · ${ltr(phone)}` : ""}</footer>`;
}

/**
 * أنماط الطباعة الإضافية المشتركة (مقاس A4 وهوامشه).
 *
 * Handed to `openPrintableDocument` / `downloadHtmlAsPdf` alongside the HTML.
 */
export const printedDocumentExtraCss = `
  @page { size: A4; margin: 10mm; }
  body { font-size: 12px; }
  .print-sheet { min-height: auto !important; box-shadow: none !important; }
`;
