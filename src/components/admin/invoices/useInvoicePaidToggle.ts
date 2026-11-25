import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { setInvoicePaid } from "@/fns/setInvoicePaid";
import type { InvoiceWithRelations } from "@/hooks/useInvoices";
import { useI18n } from "@/i18n/provider";
import { markPaidToastKey } from "@/lib/paymentErrors";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";

/** حالة تعليم الفاتورة كمدفوعة وإجراءاته، كما يعيدها `useInvoicePaidToggle`. */
export type InvoicePaidToggle = ReturnType<typeof useInvoicePaidToggle>;

/**
 * حالة وإجراءات تعليم فاتورة كمدفوعة أو التراجع عنه، لكل جداول الفواتير.
 *
 * The monthly invoices table and the tenant's invoice table each carried an
 * identical copy of this — and the tenant copy had already drifted once:
 * written before the payment method became mandatory, it kept calling the
 * server function directly and every mark-as-paid there failed validation
 * while the same icon on /admin/invoices worked (audit M29). One home now.
 *
 * Marking paid creates the matching payment (reverting deletes it) through
 * `set_invoice_paid`, and it always goes through `MarkInvoicePaidDialog` first
 * because `setInvoicePaidSchema` refuses `paid: true` without a method.
 * Un-marking stays direct: the schema only requires a method when `paid` is
 * true, and asking for one to undo a mistake would imply the reversal is
 * itself an accounting event.
 */
export function useInvoicePaidToggle() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const togglePaid = useServerFn(setInvoicePaid);
  const [paidPending, setPaidPending] = useState<string | null>(null);
  const [markPaidInvoice, setMarkPaidInvoice] = useState<InvoiceWithRelations | null>(null);

  /** ينفّذ التعليم كمدفوعة أو التراجع عنه، ويرجّع هل نجح. */
  const runTogglePaid = async (
    invoice: InvoiceWithRelations,
    paid: boolean,
    paymentMethod: string | null = null,
  ): Promise<boolean> => {
    setPaidPending(invoice.id);
    try {
      const paidToggle = await togglePaid({
        data: { invoiceId: invoice.id, paymentMethod, paid },
      });
      if (!paidToggle?.updated) throw new Error(t("common.error"));
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      // A staff preview of the tenant portal shares this cache (audit M22).
      await invalidatePortalViews(queryClient);
      toast.success(t("invoices.paidSynced"));
      return true;
    } catch (error) {
      toast.error(t(markPaidToastKey(error)));
      return false;
    } finally {
      setPaidPending(null);
    }
  };

  /** يوجّه التعليم كمدفوعة إلى نافذة اختيار الطريقة، ويُبقي التراجع مباشرًا. */
  const requestTogglePaid = (invoice: InvoiceWithRelations, paid: boolean) => {
    if (paid) setMarkPaidInvoice(invoice);
    else void runTogglePaid(invoice, false);
  };

  /** يعلّم فاتورة واحدة دون إشعار منفصل — الشريط الجماعي هو من يبلّغ النتيجة. */
  const markOneSelected = async (invoice: InvoiceWithRelations, method: string) => {
    setPaidPending(invoice.id);
    try {
      const paidToggle = await togglePaid({
        data: { invoiceId: invoice.id, paymentMethod: method, paid: true },
      });
      // Neither the refetch nor the error handling belongs here: BulkMarkPaidBar
      // refreshes once for the whole batch, and it needs the rejection to tell
      // the admin *why* nothing settled. Swallowing it here left the toast with
      // a list of codes and no cause.
      return Boolean(paidToggle?.updated);
    } finally {
      setPaidPending(null);
    }
  };

  /** يغلق نافذة الطريقة دون تعليم شيء. */
  const cancelMarkPaid = () => setMarkPaidInvoice(null);

  /** يعلّم الفاتورة المعلّقة بالطريقة المختارة، ويغلق النافذة عند النجاح فقط. */
  const confirmMarkPaid = async (method: string) => {
    const invoice = markPaidInvoice;
    if (!invoice) return;
    const marked = await runTogglePaid(invoice, true, method);
    if (marked) setMarkPaidInvoice(null);
  };

  return {
    paidPending,
    markPaidInvoice,
    requestTogglePaid,
    markOneSelected,
    cancelMarkPaid,
    confirmMarkPaid,
  };
}
