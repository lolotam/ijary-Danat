import { createServerFn } from "@tanstack/react-start";

import { notifyInvoiceDisputedRecord } from "@/fns/notifyInvoiceDisputed";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { disputeSchema } from "@/lib/closeoutSchemas";
import { isReportableSkip } from "@/fns/notificationSkip";
import { requirePermission } from "@/fns/requirePermission";

export type { DisputeInput } from "@/lib/closeoutSchemas";

/**
 * Sets or clears an invoice dispute flag (migration 86).
 * Throws plain Error on denial — never Response (see closeOutContract).
 *
 * Notification fires only on set (not clear), after the RPC commits. A mail
 * failure is logged — it must never fail a committed dispute flag.
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

    // The notification runs after the RPC commits and must never fail it. Its
    // outcome is logged, not returned: this fn used to return a
    // `notificationWarning` that no caller ever read (audit M5).
    try {
      const notifyResult = await notifyInvoiceDisputedRecord(data.invoiceId);
      if (isReportableSkip(notifyResult)) {
        console.warn("notifyInvoiceDisputed skipped:", notifyResult.reason);
      }
    } catch (notificationError) {
      console.error("notifyInvoiceDisputed failed:", notificationError);
    }

    return { ok: true as const };
  });
