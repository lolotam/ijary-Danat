import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { previewCloseoutSchema } from "@/lib/closeoutSchemas";
import { requirePermission } from "@/fns/requirePermission";

export type { PreviewCloseoutInput } from "@/lib/closeoutSchemas";

/**
 * Read-only settlement preview via get_contract_closeout_preview (migration 87).
 * Throws plain Error on denial — never Response (see closeOutContract).
 */
export const previewContractCloseout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(previewCloseoutSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "contracts.read",
      attempted: "contract.preview_closeout",
      refusal: "You do not have permission to read contracts.",
    });

    const { data: result, error } = await context.supabase.rpc("get_contract_closeout_preview", {
      p_contract_id: data.contractId,
      p_deductions: data.deductions,
      p_invoice_actions: data.invoiceActions,
      p_refund_amount: data.refundAmount ?? null,
    });
    if (error) throw new Error(error.message);
    return { ok: true as const, result };
  });
