import { useMutation, useQueryClient } from "@tanstack/react-query";

import { confirmPaymentForCurrentSession } from "@/lib/myfatoorah";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";

/**
 * Wraps `confirmPaymentForCurrentSession` and, when the gateway reports the
 * payment as settled, invalidates every portal query that depends on the
 * tenant's invoices, payments, receipts, and dashboard summary so the
 * newly-paid month disappears from the portal immediately.
 *
 * The settled payment is also created as a confirmed `payments` row by the
 * server, so the `admin` dashboard's `useRecentPayments` / `useDashboardKpis`
 * queries pick it up on the admin's next visit.
 */
export function useConfirmPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: confirmPaymentForCurrentSession,
    onSuccess: async (result) => {
      if (result.status === "paid") {
        // Every portal key, by prefix — broader than the confirmed tenant's own
        // keys, which is the point: the one shared list is how a new portal
        // query cannot be missed here (audit M22).
        await invalidatePortalViews(queryClient);
      }
    },
  });
}
