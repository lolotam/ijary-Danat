import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requirePermission } from "@/fns/requirePermission";

const schema = z.object({ asOf: z.string().date().nullable().optional() });
export type EvaluateOverdueInput = z.infer<typeof schema>;

/**
 * Service-role entry point for the unattended cron run. Kept separate from the
 * server fn below, which stays user-scoped so RLS and has_permission still apply
 * to a human clicking the button. evaluate_overdue skips its own permission check
 * when auth.role() is service_role, so the two callers need different clients.
 */
export async function runEvaluateOverdueJob(asOf: string | null = null) {
  const { data, error } = await supabaseAdmin.rpc("evaluate_overdue", { p_as_of: asOf });
  if (error) throw new Error(error.message);
  return { count: data?.length ?? 0, transitions: data };
}

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
