/**
 * فاتورة مطبوعة بمقاس A4 على صفحة واحدة.
 *
 * This is the reference document for everything the company prints: the layout,
 * palette and spacing all live in `printedDocument.ts` now, and the payment
 * receipt composes the same shell. Changing the look here changes the receipt
 * with it — which is the point, and the reason the CSS moved out of this file.
 */

import type { Company } from "@/hooks/useCompany";
import type { InvoiceWithRelations } from "@/hooks/useInvoices";
import { type Locale, translatorFor } from "@/i18n/dictionary";
import { hasDiscount } from "@/lib/invoiceDiscountBadge";
import { extraChargeLabel, summarizeExtraCharges } from "@/lib/invoiceExtraCharges";
import { formatIsoMonthYear, formatMonthYear } from "@/lib/dateDisplay";
import {
  describeBreakdown,
  documentCopy,
  invoicePaidOn,
  type InvoicePaymentBreakdown,
} from "@/lib/invoicePaymentBreakdown";
import { formatKwd } from "@/lib/money";
import { resolvePartyName } from "@/lib/partyName";
import {
  esc,
  PRINTED_DOCUMENT_CSS,
  renderDetailGrid,
  renderDocumentFooter,
  renderDocumentHeader,
} from "@/lib/printedDocument";

/**
 * يبني HTML الفاتورة الجاهزة للمعاينة والطباعة وحفظ PDF.
 *
 * Money rows come from the snapshot, not from the list row: a stale `paid` on
 * the invoice object is exactly how a remaining balance used to vanish from
 * the paper. Extras still come from the invoice's own immutable items.
 */
export function buildInvoicePrintHtml(
  invoice: InvoiceWithRelations,
  company: Company | null,
  locale: Locale,
  breakdown: InvoicePaymentBreakdown,
): string {
  const t = translatorFor(locale);
  // No fixed fallback name: a company row not loaded yet prints blank rather
  // than another company's name on this company's invoice.
  const companyName = company?.name_ar || company?.name_en || "";
  const footer =
    locale === "ar"
      ? (company?.invoice_footer_ar ?? company?.invoice_footer_en ?? "")
      : (company?.invoice_footer_en ?? company?.invoice_footer_ar ?? "");

  const rows = [
    {
      label: t("invoicePrint.tenant"),
      value: invoice.tenant ? resolvePartyName(invoice.tenant, locale) : "—",
    },
    // Every unit and building the invoice bills for. A consolidated multi-unit
    // invoice has no single one (migration 112) and printed a bare dash where
    // the tenant expected to see what they are being charged for.
    {
      label: t("invoicePrint.unit"),
      value: invoice.units.map((unit) => unit.name ?? unit.code).join("، ") || "—",
    },
    {
      label: t("invoicePrint.property"),
      value:
        invoice.properties
          .map((property) =>
            locale === "ar" ? property.name_ar : (property.name_en ?? property.name_ar),
          )
          .join("، ") || "—",
    },
    {
      label: t("invoicePrint.period"),
      value: formatMonthYear(invoice.period_month, invoice.period_year, locale),
    },
    // When the tenant paid, not when the platform generated the invoice: the
    // generation date is bookkeeping, and the paper is what the tenant keeps
    // as proof of payment (owner request 2026-09-24).
    { label: t("invoicePrint.paymentDate"), value: invoicePaidOn(breakdown) ?? "—" },
    // Due dates are always the 1st (Group B), so the month is the information.
    { label: t("invoicePrint.dueDate"), value: formatIsoMonthYear(invoice.due_date, locale) },
  ];

  // The rent the contract is for, and the service charges billed on top of it.
  // `subtotal` is the sum of the two (`contract_period_amounts`), so splitting
  // it here presents one stored number rather than computing a second one.
  const extras = summarizeExtraCharges(invoice.extraCharges, locale);
  const rent = breakdown.invoice.subtotal - extras.total;
  const described = describeBreakdown(breakdown, locale);
  const paidRows = described.showBreakdown
    ? [
        ...described.groupRows.map(
          (group) =>
            `<tr>
        <td>${esc(group.label)}</td>
        <td>${esc(formatKwd(group.amount, locale))}</td>
      </tr>`,
        ),
        `<tr>
        <td>${esc(documentCopy(locale, "invoiceDocument.paidTotal"))}</td>
        <td>${esc(formatKwd(breakdown.invoice.paid, locale))}</td>
      </tr>`,
      ].join("\n")
    : `<tr>
        <td>${t("invoicePrint.paid")}</td>
        <td>${esc(formatKwd(breakdown.invoice.paid, locale))}</td>
      </tr>`;

  return `
<style>${PRINTED_DOCUMENT_CSS}</style>
<article class="doc-page" dir="rtl" lang="ar">
  ${renderDocumentHeader({
    code: invoice.code,
    title: "قيمة استثمار",
    companyName,
    logoUrl: company?.logo_url,
  })}

  ${renderDetailGrid(rows)}

  <table class="doc-amounts">
    <tbody>
      <tr>
        <td>${t("invoicePrint.contractAmount")}</td>
        <td>${esc(formatKwd(rent, locale))}</td>
      </tr>
      <tr>
        <td>${esc(extraChargeLabel(extras, locale))}</td>
        <td>${esc(formatKwd(extras.total, locale))}</td>
      </tr>
      ${
        // The row is withheld at zero, the same rule as the receipt sheet and
        // the tenant badge: a tenant reading "الخصم 0 KWD" assumes another
        // tenant got one.
        hasDiscount(breakdown.invoice.discount)
          ? `<tr>
        <td>${t("invoicePrint.discount")}</td>
        <td>${esc(formatKwd(breakdown.invoice.discount, locale))}</td>
      </tr>`
          : ""
      }
      <tr>
        <td>${esc(documentCopy(locale, "invoiceDocument.invoiceTotal"))}</td>
        <td>${esc(formatKwd(breakdown.invoice.total, locale))}</td>
      </tr>
      ${paidRows}
      <tr class="total">
        <td>${esc(documentCopy(locale, "invoiceDocument.remaining"))}</td>
        <td>${esc(formatKwd(breakdown.invoice.balance, locale))}</td>
      </tr>
    </tbody>
  </table>

  <p class="doc-status">${esc(described.statusLine)}</p>

  ${renderDocumentFooter({ footerText: footer, companyName, phone: company?.phone })}
</article>
`;
}
