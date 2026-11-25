import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { voidRefundSchema } from "@/lib/closeoutSchemas";
import { requirePermission } from "@/fns/requirePermission";

export type { VoidRefundInput } from "@/lib/closeoutSchemas";

/**
 * Voids a posted refund via void_refund (migration 85). No mirror row.
 * Throws plain Error on denial — never Response (see closeOutContract).
 */
export const voidRefund = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(voidRefundSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "refunds.void",
      attempted: "refund.void",
      refusal: "You do not have permission to void a refund.",
    });

    const { error } = await context.supabase.rpc("void_refund", {
      p_refund_id: data.refundId,
      p_reason: data.reason,
    });
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
