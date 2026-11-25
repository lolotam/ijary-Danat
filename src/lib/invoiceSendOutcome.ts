import type { NotificationState } from "@/integrations/supabase/database.types";

export type InvoiceSendOutcome = {
  failed: string[];
  /**
   * القنوات التي تخطّاها صفها لأن إشعارات المستأجر موقوفة.
   *
   * Paused channels are not failures — nobody was meant to be reached — so
   * they are counted apart and the toast says why instead of reporting a
   * broken send.
   *
   * Optional like `pdfMissing`: the senders that predate the tenant's pause
   * switch still build this outcome, and the switch is the sender's business.
   */
  paused?: string[];
  queued: string[];
  refused: string[];
  sent: string[];
  /** The invoice PDF could not be rendered, so every channel went out text-only. */
  pdfMissing?: boolean;
};

export type InvoiceSendFeedback = {
  kind: "success" | "warning" | "error";
  key: string;
};

/**
 * يصنّف صف الإشعار حسب حالته المكتوبة، لا حسب وجود المعرّف.
 *
 * `enqueueNotification` returns the row after `dispatchNotificationRecord` has
 * already written `sent`, `queued`, or a non-delivery state. Counting a non-null
 * id as success toasted "Invoice sent" for a row that never completed (PR #214).
 *
 * Notification `queued` means the dispatcher has not handed the message to a
 * provider yet. A Twilio/Meta accept that those APIs themselves call "queued"
 * is recorded on our row as `sent`.
 */
export function invoiceSendRowBucket(state: NotificationState): "sent" | "queued" | "failed" {
  switch (state) {
    case "sent":
      return "sent";
    case "queued":
      return "queued";
    case "failed":
    case "skipped":
    case "cancelled":
    case "needs_review":
      return "failed";
  }
}

/**
 * يترجم حصيلة الإرسال إلى إشعار واحد يطابق ما فعله المرسل فعلاً.
 *
 * Both invoice tables share this so a third caller cannot toast unconditional
 * success. `sentPartly` requires at least one accepted row; a still-queued send
 * with unavailable channels is pending, not "partly sent".
 *
 * A tenant whose notifications are paused is neither a success nor a failure:
 * nothing was meant to reach them, so the toast names the pause instead of
 * sending the admin after a send that was never meant to happen.
 */
export function invoiceSendToast(outcome: InvoiceSendOutcome): InvoiceSendFeedback {
  // First: the pause wins only when nothing failed or refused — a real failure must not hide.
  if (
    (outcome.paused?.length ?? 0) > 0 &&
    outcome.sent.length === 0 &&
    outcome.queued.length === 0 &&
    outcome.failed.length === 0 &&
    outcome.refused.length === 0
  ) {
    return { kind: "warning", key: "invoices.sendTenantPaused" };
  }
  const hasSent = outcome.sent.length > 0;
  const hasQueued = outcome.queued.length > 0;
  const someUnavailable = outcome.failed.length > 0 || outcome.refused.length > 0;
  if (hasSent && !hasQueued && !someUnavailable) {
    // Delivered, but not what the admin asked for: a clean "Invoice sent" here
    // is how a text-only send passed for a complete one.
    return outcome.pdfMissing
      ? { kind: "warning", key: "invoices.sentWithoutPdf" }
      : { kind: "success", key: "invoices.sent" };
  }
  if (hasSent) {
    // A delivered channel still went out text-only; "partly sent" alone would
    // hide that the one message that did arrive lacks its PDF.
    return outcome.pdfMissing
      ? { kind: "warning", key: "invoices.sentPartlyWithoutPdf" }
      : { kind: "warning", key: "invoices.sentPartly" };
  }
  if (hasQueued && someUnavailable) {
    return { kind: "warning", key: "invoices.sendQueuedPartly" };
  }
  if (hasQueued) return { kind: "warning", key: "invoices.sendQueued" };
  if (outcome.failed.length > 0) return { kind: "error", key: "invoices.sendFailed" };
  return { kind: "error", key: "invoices.sendRefused" };
}
