import { useMutation, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { PERMISSIONS } from "@/lib/permissions";
import { reversePaymentForCurrentSession } from "@/lib/reversePayment";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";

/** يعيد رصيد تأمين البوابة عند عكس دفعة تسوية ناتجة عن الإغلاق. */
export function useReversePayment() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (input: { paymentId: string; reason: string }) => {
      if (!permissions.can(PERMISSIONS.PAYMENTS_REVERSE)) throw new Error("Permission denied.");
      // The audit row is written by `reversePayment` itself. Review finding on
      // PR #206: writing one here too gave every reversal made through the UI
      // two entries for one action, and a browser-written row is forgeable and
      // absent when the server function is called directly — so the server owns
      // it, and this hook only moves the money.
      return reversePaymentForCurrentSession(input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["insurance_payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      void invalidatePortalViews(queryClient);
      queryClient.invalidateQueries({ queryKey: ["invoice-month-summary"] });
      queryClient.invalidateQueries({ queryKey: ["payment-allocations"] });
    },
  });
}
