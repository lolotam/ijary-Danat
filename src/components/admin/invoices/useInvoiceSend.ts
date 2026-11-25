import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { sendInvoiceToTenant } from "@/fns/sendInvoiceToTenant";
import type { InvoiceWithRelations } from "@/hooks/useInvoices";
import { useI18n } from "@/i18n/provider";
import { invoiceSendToast } from "@/lib/invoiceSendOutcome";

/** قنوات إرسال الفاتورة المختارة في نافذة الإرسال. */
export interface SendChannels {
  email: boolean;
  whatsapp: boolean;
}

/**
 * حالة وإجراءات إرسال فاتورة للمستأجر، لكل جداول الفواتير.
 *
 * Shared so a failed row cannot toast success on one screen while the other
 * reports it honestly — the monthly and tenant tables had identical copies
 * whose comments already said as much (review round 4 on PR #214; audit M29).
 * The outcome shown is the row's actual state: a notification id alone used to
 * count as a successful send.
 */
export function useInvoiceSend() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const sendInvoiceFn = useServerFn(sendInvoiceToTenant);
  const [sendInvoice, setSendInvoice] = useState<InvoiceWithRelations | null>(null);
  const [sendChannels, setSendChannels] = useState<SendChannels>({ email: true, whatsapp: false });
  const [sendPending, setSendPending] = useState(false);

  /** يفتح نافذة الإرسال، ويختار البريد افتراضياً إن كان للمستأجر بريد. */
  const openSend = (invoice: InvoiceWithRelations) => {
    setSendChannels({ email: Boolean(invoice.tenant?.email), whatsapp: false });
    setSendInvoice(invoice);
  };

  /** يغلق نافذة الإرسال دون إرسال. */
  const closeSend = () => setSendInvoice(null);

  /** يرسل الفاتورة عبر القنوات المختارة ويعرض النتيجة الفعلية للصف. */
  const runSend = async () => {
    if (!sendInvoice) return;
    const channels = [
      ...(sendChannels.email ? (["email"] as const) : []),
      ...(sendChannels.whatsapp ? (["whatsapp"] as const) : []),
    ];
    if (!channels.length) {
      toast.error(t("invoices.selectChannel"));
      return;
    }
    setSendPending(true);
    try {
      const outcome = await sendInvoiceFn({
        data: { invoiceId: sendInvoice.id, channels: [...channels] },
      });
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
      const feedback = invoiceSendToast(outcome);
      toast[feedback.kind](t(feedback.key));
      setSendInvoice(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    } finally {
      setSendPending(false);
    }
  };

  return {
    sendInvoice,
    sendChannels,
    setSendChannels,
    sendPending,
    openSend,
    closeSend,
    runSend,
  };
}
