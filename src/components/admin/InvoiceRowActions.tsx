import { useState } from "react";
import { BadgeCheck, Download, Eye, Link2, Printer, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { Company } from "@/hooks/useCompany";
import type { InvoiceWithRelations } from "@/hooks/useInvoices";
import { fetchInvoiceReceiptCode } from "@/hooks/useReceipts";
import { fetchInvoicePaymentBreakdown } from "@/hooks/useInvoicePaymentBreakdown";
import { useI18n } from "@/i18n/provider";
import type { InvoiceState } from "@/integrations/supabase/database.types";
import { loadInvoiceDocument } from "@/lib/invoiceDocumentLoader";
import { downloadHtmlAsPdf, openLoadedDocument } from "@/lib/printDocument";
import { cn } from "@/lib/utils";

/** States that still need collection — KNET link is only meaningful here. */
const PAYABLE_STATES: ReadonlySet<InvoiceState> = new Set(["due", "overdue", "partially_paid"]);

function isPayable(state: InvoiceState): boolean {
  return PAYABLE_STATES.has(state);
}

export interface InvoiceRowActionHandlers {
  canSend: boolean;
  canGenerateLink: boolean;
  canTogglePaid: boolean;
  knetPending?: boolean;
  paidPending?: boolean;
  onSend: (invoice: InvoiceWithRelations) => void;
  onGenerateLink: (invoice: InvoiceWithRelations) => void;
  /** Same toggle as the main Monthly Invoices page (`set_invoice_paid`). */
  onTogglePaid: (invoice: InvoiceWithRelations, paid: boolean) => void;
}

/**
 * Status-gated action icons for one invoice row.
 *
 * Always: Preview, Mark paid/unpaid (same as main invoices).
 * Paid: Download PDF, Print, Send.
 * Due / overdue / partially paid: Generate KNET link — Print is hidden.
 * Cancelled / waived: Preview + mark toggle only (no formal print / KNET).
 *
 * Document actions (preview / print / PDF) use the shared invoice document so
 * admin and portal copies stay identical. Send, KNET, and paid toggle stay as
 * callbacks because they need parent-owned dialogs or list invalidation.
 */
export function InvoiceRowActions({
  invoice,
  company,
  handlers,
}: {
  invoice: InvoiceWithRelations;
  company: Company | null;
  handlers: InvoiceRowActionHandlers;
}) {
  const {
    canSend,
    canGenerateLink,
    canTogglePaid,
    knetPending,
    paidPending,
    onSend,
    onGenerateLink,
    onTogglePaid,
  } = handlers;
  const { locale, t } = useI18n();
  const [busy, setBusy] = useState(false);
  const paid = invoice.state === "paid";
  const payable = isPayable(invoice.state);

  /** يبني ورقة الفاتورة للعرض والطباعة عبر المُحمِّل المختبَر. */
  const doc = () =>
    loadInvoiceDocument({
      invoice,
      company,
      locale: locale === "ar" ? "ar" : "en",
      fallbackTitle: t("invoices.printInvoice"),
      fetchBreakdown: fetchInvoicePaymentBreakdown,
    });

  /**
   * نفس الورقة، لكن باسم ملف مأخوذ من رمز الإيصال حين تكون الفاتورة مسدَّدة.
   *
   * Separate from {@link doc} because only this path puts a filename in front
   * of anyone: preview and print would pay for a lookup nobody reads.
   */
  const downloadDoc = async () => {
    const receiptCode = paid ? await fetchInvoiceReceiptCode(invoice.id) : null;
    return loadInvoiceDocument({
      invoice,
      company,
      locale: locale === "ar" ? "ar" : "en",
      fallbackTitle: t("invoices.printInvoice"),
      fetchBreakdown: fetchInvoicePaymentBreakdown,
      receiptCode,
    });
  };

  // The breakdown RPC runs before the paper exists, so the window is claimed
  // inside the click and filled afterwards (see `openLoadedDocument`).
  const runPreview = async () => {
    setBusy(true);
    try {
      const outcome = await openLoadedDocument(doc, { autoPrint: false });
      if (outcome === "blocked") toast.error(t("common.popupBlocked"));
    } catch (error) {
      console.error("[invoice-preview] failed:", error);
      toast.error(t("common.error"));
    } finally {
      setBusy(false);
    }
  };

  const runPrint = async () => {
    setBusy(true);
    try {
      const outcome = await openLoadedDocument(doc, { autoPrint: true });
      if (outcome === "blocked") toast.error(t("common.popupBlocked"));
    } catch (error) {
      console.error("[invoice-print] failed:", error);
      toast.error(t("common.error"));
    } finally {
      setBusy(false);
    }
  };

  const runPdf = async () => {
    setBusy(true);
    try {
      const built = await downloadDoc();
      const ok = await downloadHtmlAsPdf(built.html, built.filename, {
        title: built.title,
        dir: built.dir,
        extraCss: built.extraCss,
      });
      if (ok) toast.success(t("common.pdfReady"));
      else toast.error(t("common.popupBlocked"));
    } catch (error) {
      console.error("[invoice-pdf] failed:", error);
      toast.error(t("common.pdfFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title={t("common.preview")}
        aria-label={t("common.preview")}
        disabled={busy}
        onClick={() => void runPreview()}
      >
        <Eye className="size-4" />
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        title={paid ? t("invoices.markUnpaid") : t("invoices.markPaid")}
        aria-label={paid ? t("invoices.markUnpaid") : t("invoices.markPaid")}
        // Mark is offered only where money is still owed; unmark only on a paid
        // row. A waived or cancelled invoice gets neither: set_invoice_paid
        // (migration 194) refuses them, and offering the button would invite
        // the click that laundered INV-0007120 out of its write-off.
        disabled={!canTogglePaid || paidPending || busy || (!paid && !payable)}
        onClick={() => onTogglePaid(invoice, !paid)}
      >
        <BadgeCheck className={cn("size-4", paid && "text-emerald-600")} />
      </Button>

      {paid ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title={t("common.downloadPdf")}
            aria-label={t("common.downloadPdf")}
            disabled={busy}
            onClick={() => void runPdf()}
          >
            <Download className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title={t("invoices.printInvoice")}
            aria-label={t("invoices.printInvoice")}
            disabled={busy}
            onClick={() => void runPrint()}
          >
            <Printer className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title={t("invoices.sendInvoice")}
            aria-label={t("invoices.sendInvoice")}
            disabled={!canSend}
            onClick={() => onSend(invoice)}
          >
            <Send className="size-4" />
          </Button>
        </>
      ) : null}

      {payable ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={t("invoices.knetLink")}
          aria-label={t("invoices.knetLink")}
          disabled={!canGenerateLink || knetPending || busy}
          onClick={() => onGenerateLink(invoice)}
        >
          <Link2 className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}
