import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { restoreSchema } from "@/lib/closeoutSchemas";
import { requirePermission } from "@/fns/requirePermission";

export type { RestoreInput } from "@/lib/closeoutSchemas";

/**
 * يستعيد العقد المؤرشف عبر restore_contract (migration 87).
 *
 * Throws plain Error on denial — never Response (see closeOutContract).
 *
 * No notification runs here any more: `restore_contract` enqueues
 * `contract.restored` in the same transaction as the change (migration 310,
 * FR-018) and the money event handler runs the send from the worker.
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

    return { ok: true as const, result };
  });
