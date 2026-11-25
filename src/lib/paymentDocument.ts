/**
 * One definition of "what a payment-receipt document is" — the HTML, the print
 * CSS, the tab title and the download filename.
 *
 * Mirrors {@link buildInvoiceDocument}: the portal payment-row actions render
 * through the same print/PDF pipeline, and keeping the assembly here means the
 * preview, print and download paths cannot drift from each other.
 */

import type { Company } from "@/hooks/useCompany";
import type { AllocationWithInvoice } from "@/hooks/usePaymentAllocations";
import type { Locale } from "@/i18n/dictionary";
import type { Tables } from "@/integrations/supabase/database.types";
import { buildPaymentReceiptHtml, type ReceiptIdentity } from "@/lib/paymentReceiptHtml";
import { printedDocumentExtraCss } from "@/lib/printedDocument";
import type { PartyNameTenant } from "@/lib/partyName";
import { receiptDocumentFilename } from "@/lib/receiptDocumentFilename";

export interface PaymentReceiptDocument {
  /** Full receipt HTML, ready for print / preview / PDF capture. */
  html: string;
  /** Browser tab title and the PDF's suggested name. */
  title: string;
  /** Download filename, including the .pdf extension. */
  filename: string;
  extraCss: string;
  dir: "rtl" | "ltr";
}

/**
 * @param payment The payment row.
 * @param allocations Loaded allocations (may be empty — the doc still renders
 *   a single total line).
 * @param company Company row, or null when not yet loaded.
 * @param locale Active UI locale; drives language + text direction.
 * @param fallbackTitle Tab/PDF title used when no company name is on record.
 * @param tenant Party printed on the receipt. Optional so existing callers
 *   that have not loaded the tenant still render the rest of the document.
 * @param receipt The issued `receipts` row. Both callers load it — the admin
 *   dialog and the portal row actions — so the document is titled and filed
 *   under the RECEIPT's code, the number a tenant quotes back. It is still
 *   optional because RLS hides receipts that are not `visible_to_tenant`, and
 *   the payment code stands in when nothing came back.
 * @param manualPaymentReason Already-resolved, reader-facing label for why an
 *   invoice was settled by hand. Only the notification path resolves it; the
 *   portal and admin rows pass nothing and the row is omitted, exactly as
 *   before this parameter existed.
 */
export function buildPaymentReceiptDocument(
  payment: Tables<"payments">,
  allocations: AllocationWithInvoice[],
  company: Company | null,
  locale: Locale,
  fallbackTitle: string,
  tenant?: PartyNameTenant | null,
  receipt?: ReceiptIdentity | null,
  manualPaymentReason?: string | null,
): PaymentReceiptDocument {
  const companyName = company?.name_ar || company?.name_en || "";
  const dir: "rtl" | "ltr" = locale === "ar" ? "rtl" : "ltr";
  const documentCode = receipt?.code ?? payment.code;

  return {
    html: buildPaymentReceiptHtml(payment, allocations, company, locale, {
      manualPaymentReason,
      tenant,
      receipt,
    }),
    title: `${documentCode} — ${companyName || fallbackTitle}`,
    filename: receiptDocumentFilename(receipt?.code, payment.code),
    extraCss: printedDocumentExtraCss,
    dir,
  };
}
