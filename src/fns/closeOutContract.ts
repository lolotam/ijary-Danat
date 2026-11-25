import { createServerFn } from "@tanstack/react-start";

import { notifyContractCloseoutRecord } from "@/fns/notifyContractCloseout";
import { notifyRefundRecordedRecord } from "@/fns/notifyRefundRecorded";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { closeoutSchema } from "@/lib/closeoutSchemas";
import { isReportableSkip } from "@/fns/notificationSkip";
import { requirePermission } from "@/fns/requirePermission";

export type { CloseoutInput } from "@/lib/closeoutSchemas";

/**
 * Commits a contract close-out via close_out_contract (migration 87).
 *
 * Throws a plain Error on denial — NOT Response. A thrown Response resolves as
 * success on the x-tss-raw client path, which would fire success toasts after a
 * permission failure.
 *
 * Notifications run AFTER the RPC commits. A mail failure is logged and returned
 * as notificationWarning so the UI can toast — it must never fail a financially
 * committed close-out. Reuses the existing `refund-recorded` event when the RPC
 * issued a refund (no second refund event).
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

    let notificationWarning: string | null = null;
    const closeoutId =
      result && typeof result === "object" && result !== null && "closeout_id" in result
        ? String((result as { closeout_id: unknown }).closeout_id)
        : null;
    const refundId =
      result &&
      typeof result === "object" &&
      result !== null &&
      "refund_id" in result &&
      (result as { refund_id: unknown }).refund_id != null
        ? String((result as { refund_id: unknown }).refund_id)
        : null;
    if (closeoutId) {
      // Two independent notifications, two independent failures. Under one
      // `try`, a throw from the close-out notice — which `alreadyNotified()`
      // now does on a transient query error instead of re-sending — skipped
      // the refund notice entirely, with nothing recording that it was never
      // attempted (substitute review, PR #221).
      try {
        const notifyResult = await notifyContractCloseoutRecord(closeoutId);
        if (isReportableSkip(notifyResult)) {
          notificationWarning = notifyResult.reason;
        }
      } catch (notificationError) {
        console.error("notifyContractCloseout failed:", notificationError);
        notificationWarning =
          notificationError instanceof Error
            ? notificationError.message
            : "Close-out notification failed.";
      }
      // Close-out inserts the refunds row inside SQL; the client refund path
      // already fires refund-recorded, but this path never did.
      if (refundId) {
        try {
          const refundNotify = await notifyRefundRecordedRecord(refundId);
          if (!notificationWarning && isReportableSkip(refundNotify)) {
            notificationWarning = refundNotify.reason;
          }
        } catch (notificationError) {
          console.error("notifyRefundRecorded failed:", notificationError);
          notificationWarning ??=
            notificationError instanceof Error
              ? notificationError.message
              : "Refund notification failed.";
        }
      }
    }

    return { ok: true as const, result, notificationWarning };
  });
