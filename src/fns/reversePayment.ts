import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/fns/requirePermission";

const schema = z.object({
  paymentId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
});
export type ReversePaymentInput = z.infer<typeof schema>;

export const reversePayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "payments.reverse",
      attempted: "payment.reverse",
      refusal: "You do not have permission to reverse a payment.",
    });
    const { data: rows, error } = await context.supabase.rpc("reverse_payment", {
      p_payment_id: data.paymentId,
      p_reason: data.reason,
    });
    if (error) throw new Error(error.message);

    // No audit write here. Review finding on PR #206: `reverse_payment` is
    // granted directly to `authenticated` and does its own permission check, so
    // a call straight to PostgREST reverses the payment without this handler
    // ever running — and a trail that is empty exactly when someone went around
    // the UI is worse than no trail at all. Migration 213 moved the row inside
    // the RPC, where it commits with the money.
    return rows;
  });
