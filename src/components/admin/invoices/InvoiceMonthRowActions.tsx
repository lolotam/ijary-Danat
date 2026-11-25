import { BadgeCheck, Eye, Link2, Printer, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { InvoiceWithRelations } from "@/hooks/useInvoices";
import { useI18n } from "@/i18n/provider";
import { isBulkSettleable } from "@/lib/invoiceBulkSelection";
import { cn } from "@/lib/utils";

/**
 * أيقونات إجراءات صف فاتورة الشهر: التفاصيل، التعليم كمدفوعة، الطباعة، كي نت، الإرسال.
 */
export function InvoiceMonthRowActions({
  invoice,
  canUpdate,
  canCreatePayment,
  paidPending,
  knetPending,
  onDetails,
  onTogglePaid,
  onPrint,
  onKnet,
  onSend,
}: {
  invoice: InvoiceWithRelations;
  canUpdate: boolean;
  canCreatePayment: boolean;
  paidPending: boolean;
  knetPending: boolean;
  onDetails: () => void;
  onTogglePaid: (paid: boolean) => void;
  onPrint: () => void;
  onKnet: () => void;
  onSend: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        title={t("common.details")}
        aria-label={t("common.details")}
        onClick={onDetails}
      >
        <Eye className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title={invoice.state === "paid" ? t("invoices.markUnpaid") : t("invoices.markPaid")}
        aria-label={invoice.state === "paid" ? t("invoices.markUnpaid") : t("invoices.markPaid")}
        // Un-marking stays available on a paid row; marking is gated to the
        // settleable states. `set_invoice_paid` checks only the remaining
        // balance before writing `paid`, so offering this on a cancelled or
        // written-off invoice would resurrect it and book a real payment — the
        // same rule the bulk selection enforces, applied to the single-row path.
        disabled={
          !canUpdate || paidPending || (invoice.state !== "paid" && !isBulkSettleable(invoice))
        }
        onClick={() => onTogglePaid(invoice.state !== "paid")}
      >
        <BadgeCheck className={cn("size-4", invoice.state === "paid" && "text-emerald-600")} />
      </Button>
      {invoice.state === "paid" && (
        <Button
          variant="ghost"
          size="icon"
          title={t("invoices.printInvoice")}
          aria-label={t("invoices.printInvoice")}
          onClick={onPrint}
        >
          <Printer className="size-4" />
        </Button>
      )}
      {(invoice.state === "due" ||
        invoice.state === "overdue" ||
        invoice.state === "partially_paid") && (
        <Button
          variant="ghost"
          size="icon"
          title={t("invoices.knetLink")}
          aria-label={t("invoices.knetLink")}
          disabled={!canCreatePayment || knetPending}
          onClick={onKnet}
        >
          <Link2 className="size-4" />
        </Button>
      )}
      {invoice.state === "paid" && (
        <Button
          variant="ghost"
          size="icon"
          title={t("invoices.sendInvoice")}
          aria-label={t("invoices.sendInvoice")}
          disabled={!canUpdate}
          onClick={onSend}
        >
          <Send className="size-4" />
        </Button>
      )}
    </div>
  );
}
