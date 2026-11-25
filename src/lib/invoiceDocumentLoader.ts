import type { Company } from "@/hooks/useCompany";
import type { InvoiceWithRelations } from "@/hooks/useInvoices";
import type { Locale } from "@/i18n/dictionary";
import type { InvoicePaymentBreakdown } from "@/lib/invoicePaymentBreakdown";
import {
  buildInvoiceDocument,
  buildInvoicesDocument,
  type InvoiceDocument,
} from "@/lib/invoiceDocument";

export type InvoiceDocumentFetchBreakdown = (invoiceId: string) => Promise<InvoicePaymentBreakdown>;

export type LoadedInvoiceDocument = InvoiceDocument & {
  breakdown: InvoicePaymentBreakdown;
};

/**
 * يجلب لقطة السداد ويبني مستند فاتورة واحدة؛ يفشل إن غابت اللقطة.
 *
 * Every print/PDF entry point goes through here so a forgotten fetch cannot
 * compile: `buildInvoicePrintHtml` requires the snapshot, and this helper
 * throws instead of rendering an empty payments section.
 */
export async function loadInvoiceDocument(deps: {
  breakdown?: InvoicePaymentBreakdown;
  company: Company | null;
  fallbackTitle: string;
  fetchBreakdown: InvoiceDocumentFetchBreakdown;
  invoice: InvoiceWithRelations;
  locale: Locale;
  receiptCode?: string | null;
}): Promise<LoadedInvoiceDocument> {
  const breakdown = deps.breakdown ?? (await deps.fetchBreakdown(deps.invoice.id));
  return {
    ...buildInvoiceDocument(
      deps.invoice,
      deps.company,
      deps.locale,
      deps.fallbackTitle,
      breakdown,
      deps.receiptCode,
    ),
    breakdown,
  };
}

/**
 * يجلب لقطة كل فاتورة ويبني المستند متعدّد الصفحات؛ يفشل عند أول غياب.
 *
 * A payment that settled several months must not print one page with a
 * snapshot and another without — the missing map entry is a caller bug.
 */
export async function loadInvoicesDocument(
  invoices: InvoiceWithRelations[],
  deps: {
    breakdowns?: Map<string, InvoicePaymentBreakdown>;
    company: Company | null;
    fallbackTitle: string;
    fetchBreakdown: InvoiceDocumentFetchBreakdown;
    locale: Locale;
    receiptCode?: string | null;
  },
): Promise<InvoiceDocument> {
  const breakdowns = new Map(deps.breakdowns);
  for (const invoice of invoices) {
    if (!breakdowns.has(invoice.id)) {
      breakdowns.set(invoice.id, await deps.fetchBreakdown(invoice.id));
    }
  }
  for (const invoice of invoices) {
    if (!breakdowns.has(invoice.id)) {
      throw new Error(`Missing payment breakdown for invoice ${invoice.id}`);
    }
  }
  return buildInvoicesDocument(
    invoices,
    deps.company,
    deps.locale,
    deps.fallbackTitle,
    breakdowns,
    deps.receiptCode,
  );
}
