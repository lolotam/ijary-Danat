import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { writeOffSchema } from "@/lib/closeoutSchemas";
import { requirePermission } from "@/fns/requirePermission";

export type { WriteOffInput } from "@/lib/closeoutSchemas";

/**
 * يشطب الفاتورة (الحالة إلى مُعفاة) عبر write_off_invoice (migration 86).
 *
 * Throws plain Error on denial — never Response (see closeOutContract).
 *
 * No notification runs here any more: `write_off_invoice` enqueues
 * `invoice.written_off` in the same transaction as the write-off (migration
 * 309, FR-018) and the money event handler runs the send from the worker —
 * carrying the reason from the operational event this RPC writes.
 */
export const writeOffInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(writeOffSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "invoices.write_off",
      attempted: "invoice.write_off",
      refusal: "You do not have permission to write off an invoice.",
    });

    const { error } = await context.supabase.rpc("write_off_invoice", {
      p_invoice_id: data.invoiceId,
      p_reason: data.reason,
    });
    if (error) throw new Error(error.message);

    return { ok: true as const };
  });
