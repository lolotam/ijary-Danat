/**
 * إيصال استلام دفعة مطبوع — نفس ورقة الفاتورة تماماً، بمحتوى الدفعة.
 *
 * The receipt used to carry its own stylesheet: a filled dark-green table head,
 * a grey rounded total pill floated to one side, and a green status badge. Put
 * next to the printed invoice — the paper the office actually hands over — the
 * two looked like documents from two different companies, which is what a
 * tenant comparing their portal download to the office copy reported.
 *
 * It now composes `printedDocument.ts`, the same shell the invoice renders
 * through: same header order (code, title, company), same two-column detail
 * grid, same hairline amounts table ending in the green-underlined total row,
 * same footer. The only thing this file still decides is *what* a receipt says.
 *
 * Kept in `src/lib` (not a component) so the same bytes are reused server-side
 * for the receipt PDF attached to the "payment received" email.
 */

import type { Company } from "@/hooks/useCompany";
import type { AllocationWithInvoice } from "@/hooks/usePaymentAllocations";
import { type Locale, translatorFor } from "@/i18n/dictionary";
import type { Tables } from "@/integrations/supabase/database.types";
import { formatMonthYear } from "@/lib/dateDisplay";
import { hasDiscount } from "@/lib/invoiceDiscountBadge";
import { summarizeExtraCharges, type ExtraChargeSummary } from "@/lib/invoiceExtraCharges";
import { formatKwd } from "@/lib/money";
import { paymentMethodLabel } from "@/lib/paymentMethodLabels";
import { resolvePartyName, type PartyNameTenant } from "@/lib/partyName";
import {
  esc,
  ltr,
  PRINTED_DOCUMENT_CSS,
  renderDetailGrid,
  renderDocumentFooter,
  renderDocumentHeader,
  type DocumentDetailRow,
} from "@/lib/printedDocument";

type Payment = Tables<"payments">;

/** The issued receipt's own identity, as printed at the head of the document. */
export type ReceiptIdentity = Pick<Tables<"receipts">, "code" | "issue_date">;

/** يترجم طريقة الدفع المخزّنة إلى تسمية يقرأها المستأجر. */

/**
 * يبني صفوف بيانات الإيصال: المستأجر، طريقة الدفع، المرجع، الحالة والتواريخ.
 *
 * Reference and manual-payment reason are conditional rows rather than dashed
 * placeholders: a gateway payment has neither, and printing an empty "reason"
 * on a card receipt makes a payer ask what went wrong when nothing did.
 */
function receiptDetailRows(
  payment: Payment,
  locale: Locale,
  options: {
    manualPaymentReason?: string | null;
    receipt?: ReceiptIdentity | null;
    tenant?: PartyNameTenant | null;
  },
): DocumentDetailRow[] {
  const t = translatorFor(locale);
  const reversed = payment.status === "reversed";
  const rows: DocumentDetailRow[] = [];

  if (options.tenant) {
    rows.push({
      label: t("receipts.tenant"),
      value: resolvePartyName(options.tenant, locale),
    });
  }
  rows.push({
    label: t("payments.method"),
    value: paymentMethodLabel(payment.method, locale),
  });
  if (payment.reference) {
    rows.push({ label: t("payments.reference"), value: payment.reference });
  }
  if (options.manualPaymentReason) {
    // Same wording as the email body's row (`manualReasonListItem` in
    // emailTemplates.ts) so the message and its attachment do not name the same
    // field two different ways.
    rows.push({
      label: t("invoices.manualPaymentReason"),
      value: options.manualPaymentReason,
    });
  }
  rows.push({
    label: t("common.status"),
    value: reversed ? t("dashboardCards.reversed") : t("paymentStatus.confirmed"),
    valueClass: reversed ? "reversed" : "confirmed",
  });
  if (options.receipt) {
    rows.push({
      label: t("receipts.issueDate"),
      html: ltr(options.receipt.issue_date.slice(0, 10)),
    });
  }
  rows.push({
    label: t("payments.date"),
    html: ltr(payment.payment_date),
  });

  return rows;
}

/**
 * يبني خلية المصروفات الإضافية: المبلغ، وتحته التصنيف بين قوسين.
 *
 * The category is the field's reason for existing — an unexplained 20 on a
 * receipt is what makes a tenant ring the office — but it belongs under the
 * figure, not beside it: the amount cells are `white-space: nowrap`, and a
 * category name sharing the line would push a seven-column receipt off the
 * page. A month with no charge prints a plain zero and no brackets.
 */
function extraChargeCell(
  extras: ExtraChargeSummary,
  locale: Locale,
  money: (value: number) => string,
): string {
  const amount = money(extras.total);
  if (!extras.categories.length) return amount;
  const categories = extras.categories.join(locale === "ar" ? "، " : ", ");
  return `${amount}<span class="sub">(${esc(categories)})</span>`;
}

/**
 * يبني جدول المبالغ: سطر لكل فاتورة سدّدتها الدفعة، ثم سطر الإجمالي.
 *
 * The discount and invoice-total columns appear only when something on this
 * receipt is actually discounted — a column of dashes on every ordinary receipt
 * would be worse than the omission it replaces. The service-charge column
 * follows the same rule, and for the same reason. Since the shared
 * `hasDiscount` predicate landed, the printed INVOICE sheet follows the same
 * rule for its own discount row: the office and the receipt no longer disagree
 * about whether "0" is worth printing.
 *
 * The receipt deliberately has no rent column beside the charges.
 * `allocation.amount` is what this payment covered, not what the invoice was
 * for, so a "contract amount" next to it would be wrong on every partial
 * payment.
 *
 * With no allocations loaded the table collapses to the total alone, which is
 * the invoice's own shape.
 *
 * The total closes the same table the lines are in, exactly as the invoice's
 * "الإجمالي المستحق" row does, rather than a box floated beside it.
 */
function receiptAmountsTable(
  payment: Payment,
  allocations: AllocationWithInvoice[],
  locale: Locale,
): string {
  const t = translatorFor(locale);
  const totalLabel = esc(t("common.total"));
  const money = (value: number) => esc(formatKwd(value, locale, payment.currency));
  const showDiscount = allocations.some((allocation) => hasDiscount(allocation.invoice?.discount));
  // One summary per allocation, computed once: the column's presence, each
  // cell's amount and each cell's category all read the same numbers.
  const extrasFor = allocations.map((allocation) =>
    summarizeExtraCharges(allocation.extraCharges, locale),
  );
  const hasExtras = extrasFor.some((extras) => extras.total > 0);
  /** #, invoice code, period, [extra expense], [discount, invoice total], paid. */
  const columnCount = 4 + (showDiscount ? 2 : 0) + (hasExtras ? 1 : 0);

  const head = allocations.length
    ? `
    <thead>
      <tr>
        <th>#</th>
        <th>${esc(t("receipts.invoiceCode"))}</th>
        <th>${esc(t("invoicePrint.period"))}</th>
        ${hasExtras ? `<th class="amount">${esc(t("invoiceDocument.extraExpense"))}</th>` : ""}
        ${
          showDiscount
            ? `<th class="amount">${esc(t("invoicePrint.discount"))}</th>
        <th class="amount">${esc(t("invoiceDocument.invoiceTotal"))}</th>`
            : ""
        }
        <th class="amount">${esc(t("receipts.paidAmount"))}</th>
      </tr>
    </thead>`
    : "";

  const lines = allocations
    .map(
      (allocation, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${esc(allocation.invoice?.code ?? "—")}</td>
        <td>${
          allocation.invoice
            ? esc(
                formatMonthYear(
                  allocation.invoice.period_month,
                  allocation.invoice.period_year,
                  locale,
                ),
              )
            : "—"
        }</td>
        ${hasExtras ? `<td class="amount">${extraChargeCell(extrasFor[index], locale, money)}</td>` : ""}
        ${
          showDiscount
            ? `<td class="amount">${
                allocation.invoice ? money(Number(allocation.invoice.discount ?? 0)) : "—"
              }</td>
        <td class="amount">${
          allocation.invoice ? money(Number(allocation.invoice.total ?? 0)) : "—"
        }</td>`
            : ""
        }
        <td class="amount">${money(Number(allocation.amount))}</td>
      </tr>`,
    )
    .join("");

  const totalLabelCell = allocations.length
    ? `<td colspan="${columnCount - 1}">${totalLabel}</td>`
    : `<td>${totalLabel}</td>`;

  return `
  <table class="doc-amounts">
    ${head}
    <tbody>
      ${lines}
      <tr class="total">
        ${totalLabelCell}
        <td class="amount">${money(Number(payment.amount))}</td>
      </tr>
    </tbody>
  </table>`;
}

/**
 * يبني كتلة التفاصيل البنكية، ولا تظهر إن لم تُسجَّل بيانات البنك.
 *
 * Kept on the receipt because the office copy has always carried it and a
 * tenant forwarding the document to their accountant relies on it being there.
 */
function receiptBankBlock(company: Company | null, locale: Locale): string {
  if (!company || !(company.iban || company.bank_name)) return "";
  const t = translatorFor(locale);
  return `
  <section class="doc-note">
    <h2>${esc(t("settings.bankDetails"))}</h2>
    ${company.bank_name ? `<div>${esc(t("receipts.bank"))}: ${esc(company.bank_name)}</div>` : ""}
    ${
      company.iban ? `<div class="mono">${esc(t("settings.iban"))}: ${ltr(company.iban)}</div>` : ""
    }
  </section>`;
}

/**
 * يبني HTML الإيصال الجاهز للمعاينة والطباعة وحفظ PDF.
 *
 * @param payment The payment row (portal already loads all columns).
 * @param allocations Payment's allocations; empty array is fine — the table
 *   collapses to a single total line, the same shape as the invoice's.
 * @param company Company row for logo/name/footer/bank details. `null` is
 *   tolerated so a half-loaded page still renders.
 * @param locale Document locale; the portal passes the active UI locale.
 * @param options.manualPaymentReason Already-resolved, reader-facing label for
 *   why an invoice was settled by hand. Pass the **label**, never the
 *   `manual_payment_reasons` catalog slug — showing a tenant `audit_adjustment`
 *   is worse than showing nothing.
 * @param options.tenant Party printed on the receipt. Commercial name wins;
 *   omit (or pass null) and the party row is skipped so callers that have not
 *   loaded the tenant yet still render.
 * @param options.receipt The issued `receipts` row. A payment code and a
 *   payment date are NOT interchangeable with the receipt's own identity — the
 *   receipt is the document the tenant files, and it is the number the office
 *   copy is headed with, so the portal must print the same one. Optional, and
 *   the payment code stands in when the tenant is not allowed to see the
 *   receipt row (`visible_to_tenant`).
 */
export function buildPaymentReceiptHtml(
  payment: Payment,
  allocations: AllocationWithInvoice[],
  company: Company | null,
  locale: Locale,
  options: {
    manualPaymentReason?: string | null;
    tenant?: PartyNameTenant | null;
    receipt?: ReceiptIdentity | null;
  } = {},
): string {
  const isArabic = locale === "ar";
  const t = translatorFor(locale);
  const companyName = company?.name_ar || company?.name_en || "—";
  const footer = isArabic
    ? (company?.invoice_footer_ar ?? company?.invoice_footer_en ?? "")
    : (company?.invoice_footer_en ?? company?.invoice_footer_ar ?? "");

  return `
<style>${PRINTED_DOCUMENT_CSS}</style>
<article class="doc-page" dir="${isArabic ? "rtl" : "ltr"}" lang="${locale}">
  ${renderDocumentHeader({
    code: options.receipt?.code ?? payment.code,
    title: t("receipts.documentTitle"),
    companyName,
    logoUrl: company?.logo_url,
  })}

  ${renderDetailGrid(receiptDetailRows(payment, locale, options))}

  ${receiptAmountsTable(payment, allocations, locale)}

  ${receiptBankBlock(company, locale)}

  ${renderDocumentFooter({ footerText: footer, companyName, phone: company?.phone })}
</article>
`;
}
