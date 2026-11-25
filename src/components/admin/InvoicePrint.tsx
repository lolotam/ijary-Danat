import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Printer } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { Company } from "@/hooks/useCompany";
import { fetchInvoicePaymentBreakdown } from "@/hooks/useInvoicePaymentBreakdown";
import type { InvoiceWithRelations } from "@/hooks/useInvoices";
import { fetchInvoiceReceiptCode } from "@/hooks/useReceipts";
import { useI18n } from "@/i18n/provider";
import { buildInvoiceDocument } from "@/lib/invoiceDocument";
import { receiptDocumentFilename } from "@/lib/receiptDocumentFilename";
import { downloadHtmlAsPdf, openPrintableDocument, printHtmlDocument } from "@/lib/printDocument";
import { cn } from "@/lib/utils";

/**
 * ورقة الفاتورة في لوحة الإدارة — معاينة، طباعة، وحفظ PDF.
 *
 * The on-screen sheet used to be a second renderer: its own JSX table, its own
 * header, its own money formatting, hard-coded Arabic labels. It drifted from
 * the printed document the moment either changed — the service-charge row added
 * here would have appeared on the paper the office hands over and not in the
 * preview the operator checks it against, which is precisely the failure that
 * made `ReceiptPrint` stop drawing its own receipt.
 *
 * It now shows `buildInvoiceDocument`'s own bytes in a sandboxed `<iframe
 * srcDoc>`, the treatment every other built-HTML preview in this admin gets.
 * There is one invoice document in this codebase; this is a view of it.
 */
export function InvoicePrint({
  className,
  company,
  invoice,
}: {
  className?: string;
  company: Company | null;
  invoice: InvoiceWithRelations;
}) {
  const { locale, t } = useI18n();
  const documentLocale = locale === "ar" ? "ar" : "en";

  // Only the snapshot is cached. The paper is built from the current props at
  // render time, so a company that loads after the dialog opened, or an
  // invoice prop that changes under the same id, is never printed stale.
  //
  // `staleTime: 0`: the mutations that move money (toggle paid, reverse,
  // partial edit) invalidate `invoices`, not this key, and the 30-second
  // default would hand a reopened preview the pre-mutation paid and remaining
  // next to a freshly refetched invoice. One RPC per open is the price of a
  // document that never contradicts the row it sits on.
  const breakdownQuery = useQuery({
    queryKey: ["invoice-payment-breakdown", invoice.id],
    queryFn: () => fetchInvoicePaymentBreakdown(invoice.id),
    staleTime: 0,
  });

  const invoiceDocument = useMemo(() => {
    const breakdown = breakdownQuery.data;
    if (!breakdown) return undefined;
    return {
      ...buildInvoiceDocument(
        invoice,
        company,
        documentLocale,
        t("invoices.printInvoice"),
        breakdown,
      ),
      breakdown,
    };
  }, [breakdownQuery.data, company, documentLocale, invoice, t]);
  const unreconciled = Boolean(invoiceDocument && !invoiceDocument.breakdown.reconciled);

  useEffect(() => {
    if (!invoiceDocument || invoiceDocument.breakdown.reconciled) return;
    console.warn("invoice payment breakdown is not reconciled", {
      invoiceId: invoice.id,
      paid: invoiceDocument.breakdown.invoice.paid,
      paidFromAllocations: invoiceDocument.breakdown.paid_from_allocations,
    });
  }, [invoice.id, invoiceDocument]);

  // `isFetching`, not `isLoading`: a remount with a cached snapshot refetches
  // in the background while React Query keeps the old data, and `isLoading`
  // is false then. The paper must not be offered from the previous snapshot.
  if (breakdownQuery.isFetching) {
    return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  }
  if (breakdownQuery.isError || !invoiceDocument) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">{t("common.error")}</p>
        <Button type="button" variant="outline" onClick={() => void breakdownQuery.refetch()}>
          {t("partialPayments.retryLoad")}
        </Button>
      </div>
    );
  }

  const runPrint = async () => {
    const { html, filename: _filename, breakdown: _breakdown, ...options } = invoiceDocument;
    const ok = await printHtmlDocument(html, options);
    if (!ok) toast.error(t("common.popupBlocked"));
  };

  const runPreview = async () => {
    const { html, filename: _filename, breakdown: _breakdown, ...options } = invoiceDocument;
    const win = await openPrintableDocument(html, { ...options, autoPrint: false });
    if (!win) toast.error(t("common.popupBlocked"));
  };

  /**
   * ينزّل الفاتورة كـ PDF باسم رمز الإيصال حين تكون مسدَّدة.
   *
   * The lookup sits inside the click and not beside the render: a sheet that is
   * only ever previewed must not spend a query on a name nobody will read.
   */
  const runPdf = async () => {
    try {
      const receiptCode =
        invoice.state === "paid" ? await fetchInvoiceReceiptCode(invoice.id) : null;
      const { html, filename, breakdown: _breakdown, ...options } = invoiceDocument;
      const ok = await downloadHtmlAsPdf(
        html,
        receiptCode ? receiptDocumentFilename(receiptCode, invoice.code) : filename,
        options,
      );
      if (ok) toast.success(t("common.pdfReady"));
      else toast.error(t("common.popupBlocked"));
    } catch (error) {
      console.error("[invoice-pdf] failed:", error);
      toast.error(t("common.pdfFailed"));
    }
  };

  return (
    <div className={cn("space-y-4", className)}>
      {unreconciled ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {t("invoiceDocument.reconciliationWarning")
            .replace("{paid}", String(invoiceDocument.breakdown.invoice.paid))
            .replace("{allocations}", String(invoiceDocument.breakdown.paid_from_allocations))}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => void runPreview()}>
          <Printer className="size-4" />
          {t("common.preview")}
        </Button>
        <Button type="button" variant="outline" onClick={() => void runPrint()}>
          <Printer className="size-4" />
          {t("invoices.printInvoice")}
        </Button>
        <Button type="button" onClick={() => void runPdf()}>
          <Download className="size-4" />
          {t("common.downloadPdf")}
        </Button>
      </div>

      {/*
        `sandbox=""` for the same reason `ReceiptPrint` uses it: the document
        carries company-editable footer text, and the house rule is that built
        HTML never enters the admin's own DOM.
      */}
      <div className="min-h-0 overflow-auto rounded-lg border bg-slate-50">
        <iframe
          title={invoiceDocument.title}
          className="h-[min(70vh,720px)] w-full border-0 bg-white"
          sandbox=""
          srcDoc={invoiceDocument.html}
        />
      </div>
    </div>
  );
}
