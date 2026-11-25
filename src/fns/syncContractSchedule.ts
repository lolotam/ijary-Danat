import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/fns/requirePermission";

export const syncContractScheduleSchema = z.object({ contractId: z.string().uuid() });

export type SyncContractScheduleInput = z.infer<typeof syncContractScheduleSchema>;

/**
 * يزامن جدول فواتير العقد مع إعداداته الحالية بعد تعديل العقد أو تنازلاته.
 *
 * The counterpart to `regenerateContractInvoices`, and the one to reach for
 * whenever a change can move which months are billable — free months above all.
 * `regenerate` only ever reconciles invoices that already exist; this also
 * restores months that a previous configuration removed, up to the horizon the
 * contract has already been generated to (migration 139).
 *
 * Kept at the server-fn boundary rather than in a database trigger for the same
 * reason as `regenerateContractInvoices`: the underlying function requires
 * `invoices.create`, an accountant holds `contracts.update` without it, and a
 * trigger would abort their contract save with 42501 instead of merely refusing
 * the reconciliation.
 */
export const syncContractSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(syncContractScheduleSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "invoices.create",
      attempted: "contract.sync_schedule",
      refusal: "You do not have permission to create invoices.",
    });
    const { data: rows, error } = await context.supabase.rpc("sync_contract_invoice_schedule", {
      p_contract_id: data.contractId,
    });
    if (error) throw new Error(error.message);
    return rows;
  });
