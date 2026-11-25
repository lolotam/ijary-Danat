import type { Company } from "@/hooks/useCompany";
import type { AllocationWithInvoice } from "@/hooks/usePaymentAllocations";
import type { InvoiceWithRelations } from "@/hooks/useInvoices";
import type { Locale } from "@/i18n/dictionary";
import type { Tables } from "@/integrations/supabase/database.types";
import type { InvoicePaymentBreakdown } from "@/lib/invoicePaymentBreakdown";
import { buildInvoicesDocument, type InvoiceDocument } from "@/lib/invoiceDocument";
import { buildPaymentReceiptDocument, type PaymentReceiptDocument } from "@/lib/paymentDocument";
import type { PartyNameTenant } from "@/lib/partyName";

/**
 * الفواتير التي سدّدتها دفعة، بلا تكرار وبترتيب التخصيص.
 *
 * An allocation row carries its invoice inline; a payment that settles the same
 * invoice twice (a correction, then the balance) yields it twice, so the Map
 * de-duplicates by id while keeping first-seen order.
 */
export function settledInvoicesOf(allocations: AllocationWithInvoice[]): Tables<"invoices">[] {
  return [
    ...new Map(
      allocations
        .map((allocation) => allocation.invoice)
        .filter((invoice): invoice is Tables<"invoices"> => invoice != null)
        .map((invoice) => [invoice.id, invoice] as const),
    ).values(),
  ];
}

/**
 * هل تحمل الدفعة تخصيصات لا يمكن للمستأجر قراءة فواتيرها أصلاً؟
 *
 * A tenant may read every one of their own `payment_allocations` rows — that
 * policy keys off `payments.tenant_id` — while RLS withholds the invoices
 * behind them: a contract hidden from the portal (migration 212), or an invoice
 * an admin flagged `is_visible_to_tenant = false`.
 *
 * True only when NOTHING resolved, which is the case that leaks: with no
 * invoice to print, `buildPaymentDocument` falls back to a generated receipt
 * built from the allocation amounts — the very figures being withheld. A
 * payment settling one readable invoice and one hidden one prints the readable
 * half, which is the per-invoice filtering migration 173 deliberately chose.
 */
export function hasWithheldAllocations(allocations: AllocationWithInvoice[]): boolean {
  return allocations.length > 0 && settledInvoicesOf(allocations).length === 0;
}

export type PaymentDocumentInput = {
  allocations: AllocationWithInvoice[];
  company: Company | null;
  /** Settled invoices enriched with tenant/unit/property, already filtered by the caller. */
  invoices: InvoiceWithRelations[];
  /** Required whenever `invoices` is non-empty — the invoice paper prints from the snapshot. */
  breakdowns: Map<string, InvoicePaymentBreakdown>;
  invoiceFallbackTitle: string;
  locale: Locale;
  /**
   * Reader-facing label for why an invoice was settled by hand, printed on the
   * receipt sheet only. Optional because only the notification path resolves it
   * — the portal and admin rows never loaded it — and the invoice sheet shows
   * the payment breakdown instead.
   */
  manualPaymentReason?: string | null;
  payment: Tables<"payments">;
  receipt: Pick<Tables<"receipts">, "code" | "id" | "issue_date" | "amount" | "currency"> | null;
  receiptFallbackTitle: string;
  tenant?: PartyNameTenant | null;
};

/**
 * ورقة قابلة للطباعة: صفحة فاتورة أو إيصال دفع.
 *
 * The two builders return the same shape apart from `dir` — the invoice sheet is
 * always RTL, the receipt follows the locale — so callers read the field rather
 * than assuming either.
 */
export type PrintablePaymentDocument = InvoiceDocument | PaymentReceiptDocument;

/**
 * يختار ورقة الدفعة: صفحة الفاتورة إن سدّدت فواتير، وإلا إيصال الدفع.
 *
 * The rule lived only in the portal's payment row. The admin's own dialog always
 * built the receipt, so one paid invoice printed as an invoice sheet for the
 * tenant and as a receipt for the office — the two copies of one document that
 * this codebase keeps re-growing whenever the choice is written twice. Both
 * callers now read the choice from here.
 *
 * `invoices` is what the caller decided may be printed, not everything the
 * payment settled: the portal removes contracts flagged
 * `suppress_tenant_billing_docs` before calling, and passing an empty list with
 * a non-empty settlement is how it says "suppressed — print nothing", which is
 * why that case returns null rather than falling through to the receipt. The
 * admin copy is never suppressed, matching `/admin/invoices` and the tenant's
 * Monthly Invoices section, so it passes the settled set through untouched.
 */
export function buildPaymentDocument(input: PaymentDocumentInput): PrintablePaymentDocument | null {
  if (input.invoices.length) {
    return buildInvoicesDocument(
      input.invoices,
      input.company,
      input.locale === "ar" ? "ar" : "en",
      input.invoiceFallbackTitle,
      input.breakdowns,
      // Named after the receipt, not the invoice codes it settled: one payment
      // is one number for the tenant, and a multi-invoice settlement would
      // otherwise download as a joined list of codes.
      input.receipt?.code ?? null,
    );
  }

  if (settledInvoicesOf(input.allocations).length) return null;

  return buildPaymentReceiptDocument(
    input.payment,
    input.allocations,
    input.company,
    input.locale,
    input.receiptFallbackTitle,
    input.tenant,
    input.receipt,
    input.manualPaymentReason,
  );
}
