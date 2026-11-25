import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/fns/requirePermission";

const schema = z.object({ contractId: z.string().uuid() });

export type RegenerateContractInvoicesInput = z.infer<typeof schema>;

/** What the engine did to each invoice it considered. */
export type RegenerationAction =
  | "updated"
  | "inserted"
  | "cancelled"
  | "deleted"
  | "skipped"
  | "blocked";

export interface RegenerationSummary {
  updated: number;
  inserted: number;
  cancelled: number;
  deleted: number;
  skipped: number;
  blocked: number;
}

/**
 * Counts by action.
 *
 * Reported instead of a single total because the cancellations are exactly the
 * rows a human needs to look at — an invoice that left the contract's range
 * while still carrying money or a live payment link. A bare count would bury
 * them among routine updates.
 *
 * `blocked` (migration 139) is the same idea one step further: a month the
 * contract says is billable but which the engine refuses to touch — a
 * discounted invoice sitting inside a newly-free month, or a month whose only
 * invoice is cancelled and must not be resurrected automatically. Reporting a
 * clean result for those would claim a synchronisation that did not happen.
 */
export function summarizeRegeneration(
  rows: ReadonlyArray<{ action: string }> | null | undefined,
): RegenerationSummary {
  const summary: RegenerationSummary = {
    updated: 0,
    inserted: 0,
    cancelled: 0,
    deleted: 0,
    skipped: 0,
    blocked: 0,
  };
  for (const row of rows ?? []) {
    if (row.action in summary) summary[row.action as RegenerationAction] += 1;
  }
  return summary;
}

/**
 * Reconciles a contract's invoices after the contract itself changed.
 *
 * Called from the contract edit path, never from a database trigger. The
 * underlying function requires `invoices.create`, and an accountant holds
 * `contracts.update` without it — so a trigger would raise 42501 inside their
 * contract save and abort it. Keeping this at the server-fn boundary means the
 * save succeeds and only the reconciliation is refused.
 */
export const regenerateContractInvoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "invoices.create",
      attempted: "invoice.regenerate",
      refusal: "You do not have permission to regenerate contract invoices.",
    });
    const { data: rows, error } = await context.supabase.rpc("regenerate_contract_invoices", {
      p_contract_id: data.contractId,
    });
    if (error) throw new Error(error.message);
    return rows;
  });
