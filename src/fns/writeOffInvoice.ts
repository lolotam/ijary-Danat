import { createServerFn } from "@tanstack/react-start";

import { notifyInvoiceWrittenOffRecord } from "@/fns/notifyInvoiceWrittenOff";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { writeOffSchema } from "@/lib/closeoutSchemas";
import { isReportableSkip } from "@/fns/notificationSkip";
import { requirePermission } from "@/fns/requirePermission";

export type { WriteOffInput } from "@/lib/closeoutSchemas";

/**
 * Writes off an invoice (state → waived) via write_off_invoice (migration 86).
 * Throws plain Error on denial — never Response (see closeOutContract).
 *
 * Notification runs AFTER the RPC commits. A mail failure is logged and
 * logged — it must never fail a committed write-off.
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

    // The notification runs after the RPC commits and must never fail it. Its
    // outcome is logged, not returned: this fn used to return a
    // `notificationWarning` that no caller ever read (audit M5).
    try {
      const notifyResult = await notifyInvoiceWrittenOffRecord(data.invoiceId, data.reason);
      if (isReportableSkip(notifyResult)) {
        console.warn("notifyInvoiceWrittenOff skipped:", notifyResult.reason);
      }
    } catch (notificationError) {
      console.error("notifyInvoiceWrittenOff failed:", notificationError);
    }

    return { ok: true as const };
  });
