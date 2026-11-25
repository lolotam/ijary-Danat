import { createServerFn } from "@tanstack/react-start";

import { notifyContractRestoredRecord } from "@/fns/notifyContractRestored";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { restoreSchema } from "@/lib/closeoutSchemas";
import { isReportableSkip } from "@/fns/notificationSkip";
import { requirePermission } from "@/fns/requirePermission";

export type { RestoreInput } from "@/lib/closeoutSchemas";

/**
 * Restores an archived/ended contract via restore_contract (migration 87).
 * Throws plain Error on denial — never Response (see closeOutContract).
 *
 * Notification runs AFTER the RPC. A mail failure is logged/swallowed and
 * returned as notificationWarning for a warning toast — restore must still
 * succeed.
 */
export const restoreContract = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(restoreSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "contracts.restore",
      attempted: "contract.restore",
      refusal: "You do not have permission to restore a contract.",
    });

    const { data: result, error } = await context.supabase.rpc("restore_contract", {
      p_contract_id: data.contractId,
      p_target_state: data.targetState,
      p_restore_tenant: data.restoreTenant,
      p_reason: data.reason,
    });
    if (error) throw new Error(error.message);

    let notificationWarning: string | null = null;
    try {
      const notifyResult = await notifyContractRestoredRecord(
        data.contractId,
        data.targetState,
        data.reason,
      );
      if (isReportableSkip(notifyResult)) {
        notificationWarning = notifyResult.reason;
      }
    } catch (notificationError) {
      console.error("notifyContractRestored failed:", notificationError);
      notificationWarning =
        notificationError instanceof Error
          ? notificationError.message
          : "Restore notification failed.";
    }

    return { ok: true as const, result, notificationWarning };
  });
