import { useMutation, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/database.types";
import { PERMISSIONS } from "@/lib/permissions";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";

/**
 * مفاتيح استعلامات البوابة التي تتأثر بإخفاء العقد.
 *
 * Listed once, beside the mutation, so a new portal query cannot be added
 * without the list that must be invalidated sitting right next to it. `/portal?tenant=` is
 * the same React Query cache as the admin screens, so a staff preview left
 * open would otherwise keep serving the contract this switch just hid.
 */
const PORTAL_VISIBILITY_QUERY_KEYS = [
  ["contracts"],
  ["contract-units"],
  // Hiding a contract changes the portal's insurance total without touching
  // `insurance_payments` itself, so that table's own mutations never fire here.
  ["insurance_payments"],
] as const;

/**
 * يبدّل إخفاء العقد وفواتيره عن بوابة المستأجر.
 *
 * Goes through `update_contract_portal_visibility` (migration 210) rather than
 * a plain table update: the RPC checks `contracts.update` and writes its audit
 * row inside the same statement, so "who hid this contract from the tenant, and
 * when" is a question the trail can answer months later. It deliberately does
 * not reuse `save_contract_with_units` — that function takes the whole contract
 * plus its units, and a switch in one row should not require replaying a save.
 */
export function useSetContractPortalVisibility() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (input: {
      contractId: string;
      hideFromPortal: boolean;
    }): Promise<Tables<"contracts">> => {
      if (!permissions.can(PERMISSIONS.CONTRACTS_UPDATE)) throw new Error("Permission denied.");
      const { data, error } = await supabase.rpc("update_contract_portal_visibility", {
        p_contract_id: input.contractId,
        p_hide_from_portal: input.hideFromPortal,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      for (const queryKey of PORTAL_VISIBILITY_QUERY_KEYS) {
        queryClient.invalidateQueries({ queryKey });
      }
      // The portal's own keys come from the one shared list (audit M22).
      void invalidatePortalViews(queryClient);
    },
  });
}
