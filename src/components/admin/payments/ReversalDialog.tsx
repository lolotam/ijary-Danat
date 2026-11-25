import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import type { PaymentWithTenant } from "@/hooks/usePayments";
import { useReversePayment } from "@/hooks/useReversePayment";
import { useI18n } from "@/i18n/provider";

export interface ReversalDialogProps {
  payment: PaymentWithTenant | null;
  onClose: () => void;
}

/**
 * حوار عكس دفعة مؤكدة بسبب مكتوب — لا يُرسل الطلب بلا سبب.
 *
 * Extracted from `FullPaymentsPanel` (audit M13, plan row 6.5). Stays mounted
 * between openings, as the reason field always did: a reason typed and then
 * cancelled is still there on the next open, and is cleared only by a
 * successful reversal.
 */
export function ReversalDialog({ payment, onClose }: ReversalDialogProps) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  const reversePayment = useReversePayment();

  /**
   * يعكس الدفعة بالسبب المكتوب بعد تشذيبه، ويمسح السبب عند النجاح فقط.
   *
   * On failure the reason stays, so a refused reversal (a missing
   * `payments.reverse`, say) does not cost the admin what they typed.
   */
  const confirmReverse = async () => {
    if (!payment || !reason.trim()) return;
    try {
      await reversePayment.mutateAsync({
        paymentId: payment.id,
        reason: reason.trim(),
      });
      toast.success(t("payments.reversed"));
      onClose();
      setReason("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  };

  return (
    <AlertDialog open={Boolean(payment)} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("payments.reverseTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("payments.reverseDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        <Textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t("payments.reverseReason")}
        />
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={!reason.trim() || reversePayment.isPending}
            onClick={confirmReverse}
          >
            {t("payments.reverse")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
