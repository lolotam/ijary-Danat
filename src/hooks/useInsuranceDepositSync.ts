import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/i18n/provider";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";

/**
 * يكتب مبلغ التأمين إلى `contracts.deposit` بعد حفظ سجل التأمين، دون التراجع عن السجل.
 *
 * Reverse sync is a follow-up write: the insurance row is already durable, so
 * a refused or failed write must warn rather than undo the payment. It goes
 * through `sync_contract_deposit_from_insurance` (migration 220), which reads
 * the contract and amount from the saved insurance row, checks insurance
 * rights — not contracts.update — and audits the change in SQL.
 * Delete is intentionally omitted — deposit is the contractual amount.
 */
export function useInsuranceDepositSync() {
  const queryClient = useQueryClient();
  const { t } = useI18n();

  /**
   * يحدّث وديعة العقد بالمبلغ المحفوظ، ويُظهر تحذيراً إن غاب الصف أو فشل التحديث.
   *
   * The RPC raises on a missing contract or a refused permission, so an
   * error or an empty result is the whole failure signal.
   */
  const sync = useCallback(
    async (insuranceId: string): Promise<void> => {
      try {
        const { data, error } = await supabase.rpc("sync_contract_deposit_from_insurance", {
          p_insurance_id: insuranceId,
        });
        if (error || data == null) {
          console.error("contract deposit sync failed", error?.message ?? "no row updated");
          toast.warning(t("insurance.depositSyncFailed"));
          return;
        }
        // The portal reads `deposit` from the same query cache (portal preview).
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["contracts"] }),
          invalidatePortalViews(queryClient),
        ]);
      } catch (thrown) {
        // The insurance row is already saved; a thrown client error must not
        // look like the whole submit failed or the admin will retry and duplicate.
        console.error("contract deposit sync threw", thrown);
        toast.warning(t("insurance.depositSyncFailed"));
      }
    },
    [queryClient, t],
  );

  return { sync };
}
