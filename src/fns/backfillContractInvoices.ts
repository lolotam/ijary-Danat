import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/fns/requirePermission";

const schema = z.object({ contractId: z.string().uuid() });

export type BackfillContractInvoicesInput = z.infer<typeof schema>;

/**
 * Generate every invoice from a contract's start month through the current
 * month. Periods already past their due date land as `overdue`.
 *
 * Idempotent: the underlying generator relies on the
 * (contract, period_year, period_month) unique constraint, so re-running adds
 * only the periods that are missing.
 */
export const backfillContractInvoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "invoices.create",
      attempted: "invoice.backfill",
      refusal: "You do not have permission to backfill contract invoices.",
    });
    const { data: rows, error } = await context.supabase.rpc("backfill_contract_invoices", {
      p_contract_id: data.contractId,
    });
    if (error) throw new Error(error.message);
    return rows;
  });
