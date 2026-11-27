import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { disputeSchema } from "@/lib/closeoutSchemas";
import { requirePermission } from "@/fns/requirePermission";

export type { DisputeInput } from "@/lib/closeoutSchemas";

/**
 * يضع أو يزيل علامة النزاع على الفاتورة عبر set_invoice_dispute (migration 86).
 *
 * Throws plain Error on denial — never Response (see closeOutContract).
 *
 * No notification runs here any more: `set_invoice_dispute` enqueues
 * `invoice.disputed` in the same transaction as the flag (migration 309,
 * FR-018) and the money event handler runs the send from the worker. Clearing
 * a dispute still sends nothing — it is not a money event.
 */
export const setInvoiceDispute = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(disputeSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "invoices.dispute",
      attempted: "invoice.dispute",
      refusal: "You do not have permission to dispute an invoice.",
    });

    if (data.clear) {
      const { error } = await context.supabase.rpc("clear_invoice_dispute", {
        p_invoice_id: data.invoiceId,
      });
      if (error) throw new Error(error.message);
      return { ok: true as const };
    }

    const { error } = await context.supabase.rpc("set_invoice_dispute", {
      p_invoice_id: data.invoiceId,
      p_reason: data.reason!,
    });
    if (error) throw new Error(error.message);

    return { ok: true as const };
  });
