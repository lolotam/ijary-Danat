import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { cancelCloseoutSchema } from "@/lib/closeoutSchemas";
import { requirePermission } from "@/fns/requirePermission";

export type { CancelCloseoutInput } from "@/lib/closeoutSchemas";

/**
 * Cancels a draft close-out via cancel_contract_closeout (migration 87).
 * Throws plain Error on denial — never Response (see closeOutContract).
 */
export const cancelContractCloseout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(cancelCloseoutSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "contracts.close_out",
      attempted: "contract.cancel_closeout",
      refusal: "You do not have permission to cancel a contract close-out.",
    });

    const { data: result, error } = await context.supabase.rpc("cancel_contract_closeout", {
      p_closeout_id: data.closeoutId,
      p_reason: data.reason,
    });
    if (error) throw new Error(error.message);
    return { ok: true as const, result };
  });
