import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { InvoicePrint } from "@/components/admin/InvoicePrint";
import { KnetLinkDialog, type KnetLinkInfo } from "@/components/admin/invoices/KnetLinkDialog";
import { TableState } from "@/components/admin/Phase2Ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LtrText } from "@/components/ui/ltr-text";
import type { Company } from "@/hooks/useCompany";
import type { InvoiceWithRelations } from "@/hooks/useInvoices";
import { useI18n } from "@/i18n/provider";
import { formatAmount, formatKwd } from "@/lib/money";

import { copyToClipboard } from "@/components/admin/invoices/copyToClipboard";

export interface InvoiceDialogsProps {
  sendInvoice: InvoiceWithRelations | null;
  sendChannels: { email: boolean; whatsapp: boolean };
  sendPending: boolean;
  onSendChannelsChange: (channels: { email: boolean; whatsapp: boolean }) => void;
  onSend: () => void;
  onCloseSend: () => void;
  knetLink: KnetLinkInfo | null;
  onCloseKnet: () => void;
  printInvoice: InvoiceWithRelations | null;
  company: Company | null;
  onClosePrint: () => void;
  detailInvoice: InvoiceWithRelations | null;
  detail: {
    isLoading: boolean;
    isError: boolean;
    data?: {
      items: Array<{
        amount: number;
        description_ar: string | null;
        description_en: string | null;
        id: string;
      }>;
      allocations: Array<{ amount: number; id: string; payment_id: string }>;
      payments: Array<{ code: string; id: string }>;
      receipts: Array<{ code: string; payment_id: string }>;
    };
  };
  onCloseDetail: () => void;
}

/**
 * نوافذ الإرسال ورابط كي نت والطباعة وتفاصيل الفاتورة لصفحة الفواتير الشهرية.
 *
 * Kept beside the table rather than inside a row so Radix portals are not
 * unmounted with a parent dialog.
 */
export function InvoiceDialogs({
  sendInvoice,
  sendChannels,
  sendPending,
  onSendChannelsChange,
  onSend,
  onCloseSend,
  knetLink,
  onCloseKnet,
  printInvoice,
  company,
  onClosePrint,
  detailInvoice,
  detail,
  onCloseDetail,
}: InvoiceDialogsProps) {
  const { locale, t } = useI18n();

  return (
    <>
      <Dialog open={Boolean(sendInvoice)} onOpenChange={(open) => !open && onCloseSend()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("invoices.sendTitle").replace("{code}", sendInvoice?.code ?? "")}
            </DialogTitle>
            <DialogDescription>{t("invoices.sendDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="flex items-center gap-3 rounded-lg border p-3">
              <Checkbox
                checked={sendChannels.email}
                disabled={!sendInvoice?.tenant?.email}
                onCheckedChange={(checked) =>
                  onSendChannelsChange({ ...sendChannels, email: checked === true })
                }
              />
              <div className="min-w-0">
                <Label className="font-medium">{t("invoices.channelEmail")}</Label>
                <p className="truncate text-base text-muted-foreground">
                  {sendInvoice?.tenant?.email ?? t("invoices.noEmail")}
                </p>
              </div>
            </label>
            <label className="flex items-center gap-3 rounded-lg border p-3">
              <Checkbox
                checked={sendChannels.whatsapp}
                disabled={!(sendInvoice?.tenant?.whatsapp ?? sendInvoice?.tenant?.mobile)}
                onCheckedChange={(checked) =>
                  onSendChannelsChange({ ...sendChannels, whatsapp: checked === true })
                }
              />
              <div className="min-w-0">
                <Label className="font-medium">{t("invoices.channelWhatsapp")}</Label>
                <LtrText as="p" className="truncate text-base text-muted-foreground">
                  {sendInvoice?.tenant?.whatsapp ??
                    sendInvoice?.tenant?.mobile ??
                    t("invoices.noWhatsapp")}
                </LtrText>
              </div>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onCloseSend}>
              {t("common.cancel")}
            </Button>
            <Button disabled={sendPending} onClick={onSend}>
              {sendPending ? <RefreshCw className="size-4 animate-spin" /> : t("invoices.send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <KnetLinkDialog link={knetLink} onClose={onCloseKnet} />

      <Dialog open={Boolean(printInvoice)} onOpenChange={(open) => !open && onClosePrint()}>
        <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{printInvoice?.code}</DialogTitle>
            <DialogDescription>{t("invoices.printInvoice")}</DialogDescription>
          </DialogHeader>
          {printInvoice && <InvoicePrint invoice={printInvoice} company={company} />}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(detailInvoice)} onOpenChange={(open) => !open && onCloseDetail()}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{detailInvoice?.code}</DialogTitle>
            <DialogDescription>{t("invoices.detailDescription")}</DialogDescription>
          </DialogHeader>
          <TableState loading={detail.isLoading} error={detail.isError} empty={false}>
            <div className="space-y-6">
              <section>
                <h3 className="mb-2 font-bold">{t("invoices.items")}</h3>
                <div className="rounded-lg border">
                  {(detail.data?.items ?? []).map((item) => (
                    <div
                      key={item.id}
                      className="flex justify-between gap-4 border-b p-3 last:border-0"
                    >
                      <span>{locale === "ar" ? item.description_ar : item.description_en}</span>
                      <span className="font-mono">{formatAmount(item.amount, locale)}</span>
                    </div>
                  ))}
                </div>
              </section>
              <section>
                <h3 className="mb-2 font-bold">{t("invoices.allocations")}</h3>
                <div className="rounded-lg border">
                  {(detail.data?.allocations ?? []).map((allocation) => {
                    const payment = detail.data?.payments.find(
                      (row) => row.id === allocation.payment_id,
                    );
                    const receipt = detail.data?.receipts.find(
                      (row) => row.payment_id === allocation.payment_id,
                    );
                    return (
                      <div
                        key={allocation.id}
                        className="flex justify-between gap-4 border-b p-3 last:border-0"
                      >
                        <span>{payment?.code ?? allocation.payment_id}</span>
                        <span>{formatKwd(allocation.amount, locale)}</span>
                        {receipt ? (
                          <a
                            className="text-primary underline-offset-4 hover:underline"
                            href="/admin/payments"
                          >
                            {receipt.code}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">
                            {t("receipts.notAvailable")}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </TableState>
        </DialogContent>
      </Dialog>
    </>
  );
}
