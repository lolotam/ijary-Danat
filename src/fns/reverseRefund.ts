import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { reverseRefundSchema } from "@/lib/closeoutSchemas";
import { requirePermission } from "@/fns/requirePermission";

export type { ReverseRefundInput } from "@/lib/closeoutSchemas";

/**
 * Reverses a posted refund via reverse_refund (migration 85).
 * Throws plain Error on denial — never Response (see closeOutContract).
 */
export const reverseRefund = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(reverseRefundSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "refunds.reverse",
      attempted: "refund.reverse",
      refusal: "You do not have permission to reverse a refund.",
    });

    const { data: rows, error } = await context.supabase.rpc("reverse_refund", {
      p_refund_id: data.refundId,
      p_reason: data.reason,
    });
    if (error) throw new Error(error.message);
    return { ok: true as const, rows };
  });
