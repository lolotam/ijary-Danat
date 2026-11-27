import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { closeoutSchema } from "@/lib/closeoutSchemas";
import { requirePermission } from "@/fns/requirePermission";

export type { CloseoutInput } from "@/lib/closeoutSchemas";

/**
 * ينفّذ تصفية العقد ذرّياً عبر close_out_contract (migration 87).
 *
 * Throws a plain Error on denial — NOT Response. A thrown Response resolves as
 * success on the x-tss-raw client path, which would fire success toasts after a
 * permission failure.
 *
 * No notification runs here any more: `close_out_contract` enqueues
 * `contract.closed_out` — and `refund.recorded` when it issued a refund — in
 * the same transaction as the money (migration 310, FR-018), and the money
 * event handlers run the sends from the worker. A notification failure can no
 * longer surface from this request.
 */
export const closeOutContract = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(closeoutSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "contracts.close_out",
      attempted: "contract.close_out",
      refusal: "You do not have permission to close out a contract.",
    });

    const { data: result, error } = await context.supabase.rpc("close_out_contract", {
      p_contract_id: data.contractId,
      p_move_out_date: data.moveOutDate,
      p_outcome: data.outcome,
      p_final_contract_state: data.finalContractState,
      p_archive_tenant: data.archiveTenant,
      p_deductions: data.deductions,
      p_invoice_actions: data.invoiceActions,
      p_refund_amount: data.refundAmount ?? null,
      p_note: data.note ?? null,
      p_idempotency_key: data.idempotencyKey,
      p_expected_contract_updated_at: data.expectedContractUpdatedAt ?? null,
    });
    if (error) throw new Error(error.message);

    return { ok: true as const, result };
  });
