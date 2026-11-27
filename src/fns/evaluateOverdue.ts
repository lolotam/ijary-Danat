import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/fns/requirePermission";

const schema = z.object({ asOf: z.string().date().nullable().optional() });
export type EvaluateOverdueInput = z.infer<typeof schema>;

/** نقطة دخول المستخدم لتقييم الفواتير المتأخرة بعد التحقق من الصلاحية. */
export const evaluateOverdue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "invoices.update",
      attempted: "invoice.evaluate_overdue",
      refusal: "You do not have permission to evaluate overdue invoices.",
    });
    const { data: rows, error } = await context.supabase.rpc("evaluate_overdue", {
      p_as_of: data.asOf ?? null,
    });
    if (error) throw new Error(error.message);
    return rows;
  });
