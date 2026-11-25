import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Printer } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { Company } from "@/hooks/useCompany";
import { fetchInvoicesWithRelations } from "@/hooks/useInvoices";
import { fetchInvoicePaymentBreakdown } from "@/hooks/useInvoicePaymentBreakdown";
import type { AllocationWithInvoice } from "@/hooks/usePaymentAllocations";
import type { Locale } from "@/i18n/dictionary";
import type { Tables } from "@/integrations/supabase/database.types";
import { useI18n } from "@/i18n/provider";
import { buildPaymentDocument, settledInvoicesOf } from "@/lib/paymentPrintDocument";
import type { InvoicePaymentBreakdown } from "@/lib/invoicePaymentBreakdown";
import { downloadHtmlAsPdf, printHtmlDocument } from "@/lib/printDocument";
import { cn } from "@/lib/utils";

/**
 * ورقة الدفعة في لوحة الإدارة — نفس المستند الذي يطبعه المستأجر من البوابة.
 *
 * Formerly `ReceiptPrint`, and the name was the bug. It always built the
 * payment *receipt*, while the portal's payment row prints the *invoice* sheet
 * whenever the payment settled invoices. So one paid invoice came out as an
 * invoice page for the tenant and as a receipt for the office, and the office
 * copy matched neither `/admin/invoices` nor the tenant's Monthly Invoices
 * section. Its own doc comment claimed parity with the portal; that was only
 * ever true for a payment with no allocations.
 *
 * `buildPaymentDocument` now makes the choice for both callers. The invoice
 * branch needs tenant/unit/property rows the allocation does not carry, so it
 * is fetched here rather than computed — which is why the buttons wait on
 * `documentQuery` instead of rendering against a half-built page.
 *
 * The admin copy is deliberately NOT filtered by `suppress_tenant_billing_docs`.
 * That flag governs what reaches the tenant, and no other admin surface applies
 * it: `/admin/invoices` and the Monthly Invoices section both print suppressed
 * contracts. Only the portal filters, and it does so before calling.
 *
 * The preview renders into a sandboxed `<iframe srcDoc>`, the same treatment
 * every other built-HTML preview in this admin gets. The builder escapes what
 * it interpolates, but the document carries company-editable footer HTML, and
 * the house rule is that built HTML never enters the admin's own DOM.
 */
export function PaymentDocumentPrint({
  allocations,
  className,
  company,
  payment,
  receipt,
  tenant,
}: {
  allocations: AllocationWithInvoice[];
  className?: string;
  company: Company | null;
  payment: Tables<"payments">;
  receipt: Pick<Tables<"receipts">, "code" | "id" | "issue_date" | "amount" | "currency"> | null;
  tenant: Tables<"tenants"> | null;
}) {
  const { locale, t } = useI18n();
  const [busy, setBusy] = useState(false);

  const settledInvoices = settledInvoicesOf(allocations);
  const settledIds = settledInvoices.map((invoice) => invoice.id);

  // Only the fetched data is cached. The paper itself is built at render time
  // so a receipt that arrives after the first render (the parent renders with
  // receipt=null while useReceipts loads), a company edit or a locale switch
  // all change the document without needing to be part of the query key.
  const dataQuery = useQuery({
    // Keyed on the settled ids, not the payment alone: reversing an allocation
    // changes which invoices this paper contains without changing the payment.
    queryKey: ["payment-document-invoices", payment.id, settledIds],
    queryFn: async () => {
      const invoices = await fetchInvoicesWithRelations(settledInvoices);
      const breakdowns = new Map<string, InvoicePaymentBreakdown>();
      for (const invoice of invoices) {
        breakdowns.set(invoice.id, await fetchInvoicePaymentBreakdown(invoice.id));
      }
      return { invoices, breakdowns };
    },
    // The breakdowns are money snapshots no mutation invalidates by key;
    // refetch on every open rather than serve a 30-second-old paid amount.
    staleTime: 0,
  });

  const paymentDocument = useMemo(() => {
    if (!dataQuery.data) return null;
    const { invoices, breakdowns } = dataQuery.data;
    return buildPaymentDocument({
      allocations,
      company,
      invoices,
      breakdowns,
      invoiceFallbackTitle: t("invoices.printInvoice"),
      locale: locale as Locale,
      payment,
      receipt,
      receiptFallbackTitle: t("receipts.title"),
      tenant,
    });
  }, [allocations, company, dataQuery.data, locale, payment, receipt, t, tenant]);

  const runPrint = async () => {
    if (!paymentDocument) return;
    setBusy(true);
    try {
      const ok = await printHtmlDocument(paymentDocument.html, {
        dir: paymentDocument.dir,
        extraCss: paymentDocument.extraCss,
        title: paymentDocument.title,
      });
      if (!ok) toast.error(t("common.popupBlocked"));
    } catch (error) {
      console.error("[payment-print] failed:", error);
      toast.error(t("common.error"));
    } finally {
      setBusy(false);
    }
  };

  const runPdf = async () => {
    if (!paymentDocument) return;
    setBusy(true);
    try {
      const ok = await downloadHtmlAsPdf(paymentDocument.html, paymentDocument.filename, {
        dir: paymentDocument.dir,
        extraCss: paymentDocument.extraCss,
      });
      if (ok) toast.success(t("common.pdfReady"));
      else toast.error(t("common.pdfFailed"));
    } catch (error) {
      console.error("[payment-pdf] failed:", error);
      toast.error(t("common.pdfFailed"));
    } finally {
      setBusy(false);
    }
  };

  // `isFetching`: a cached remount refetches in the background with the old
  // data still in place, and `isLoading` stays false for that.
  if (dataQuery.isFetching) {
    return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  }
  if (dataQuery.isError || !paymentDocument) {
    return <p className="text-sm text-destructive">{t("common.error")}</p>;
  }

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={() => void runPdf()}>
          <Download className="size-4" />
          {t("common.downloadPdf")}
        </Button>
        <Button type="button" disabled={busy} onClick={() => void runPrint()}>
          <Printer className="size-4" />
          {t("payments.printDocument")}
        </Button>
      </div>
      {/*
        Printing opens the document in its own window via `printHtmlDocument`.
        This iframe shows the same bytes so the admin can read the page without
        leaving the dialog — a preview, not a second print path. The old
        `@media print` block that hid the rest of the page and promoted a
        hand-written article WAS that second path, and it is what let the admin
        and portal documents drift apart in the first place.
      */}
      <div className="min-h-0 overflow-auto rounded-lg border bg-slate-50">
        <iframe
          title={paymentDocument.title}
          className="h-[min(70vh,720px)] w-full border-0 bg-white"
          sandbox=""
          srcDoc={paymentDocument.html}
        />
      </div>
    </div>
  );
}
