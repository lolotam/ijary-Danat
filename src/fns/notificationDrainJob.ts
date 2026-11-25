import { dispatchNotificationRecord } from "@/fns/dispatchNotification";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { DELIVERY_INDETERMINATE } from "@/lib/providers/types";

/**
 * Sweeps notifications that inline dispatch left behind.
 *
 * Almost every notification is dispatched inline at enqueue time. Two kinds are
 * not, and nothing else picked them up:
 * - a manual send scheduled for a future time (`sendNotification`), which is
 *   inserted `queued` and returns;
 * - a row left `failed` by a transient provider or network error.
 *
 * Deliberately conservative, because every row here represents a real outbound
 * message to a real tenant:
 *
 * - **Stale rows are cancelled, never sent.** A reminder that is three days
 *   overdue is worse than no reminder, and a backlog that appears after an
 *   outage must not become a burst of surprise messages.
 * - **`channel: "both"` failures are not auto-retried.** On a `both` row the
 *   email leg can succeed and the WhatsApp leg then throw, and the catch in
 *   `dispatchNotificationRecord` discards the message ids — so the row reads
 *   `failed` with `provider_message_id` null even though the email went out.
 *   Retrying would send that email twice, and nothing on the row distinguishes
 *   that case. Single-channel failures are safe: had their one leg delivered,
 *   the row would be `sent`. `both` rows stay on the manual retry button.
 * - **Pointless-to-retry Postora codes are not auto-retried.** See
 *   `POSTORA_NEEDS_REVIEW` below — indeterminate delivery, exhausted quota,
 *   re-auth required, and idempotency body conflicts all park in `needs_review`
 *   rather than burning three silent retries. `idempotency_in_progress` is
 *   deliberately absent: a concurrent attempt is still in flight, so retry later.
 * - **A timeout on a provider without an idempotency key is not auto-retried.**
 *   See `PROVIDER_NEEDS_REVIEW` below: the provider may have delivered it.
 */

/** Past-due age beyond which a row is cancelled instead of delivered. */
export const STALE_AFTER_HOURS = 72;
/** Attempts before a failed row is parked in `needs_review` for a human. */
export const MAX_RETRIES = 3;
/** Upper bound on rows touched per run, so one tick cannot fan out unbounded. */
export const DRAIN_BATCH_LIMIT = 100;

/**
 * أكواد Postora التي لا فائدة من إعادة المحاولة فيها — تُحوَّل إلى `needs_review`
 * برسالة تفسيرية للإدارة (كل كود برسالته الخاصة).
 *
 * Map of partner error_code → actionable failure_reason. Intentionally omits
 * `rate_limited` (retryable after backoff) and `idempotency_in_progress`
 * (another attempt is still running — retry later is correct).
 */
export const POSTORA_NEEDS_REVIEW: Readonly<Record<string, string>> = {
  idempotency_indeterminate:
    "Postora could not confirm whether the tenant received this WhatsApp message. Retrying cannot resolve that uncertainty and would risk a duplicate send. Review delivery in Postora and decide whether to treat this as sent or send a replacement.",
  quota_exceeded:
    "Postora monthly partner quota is exhausted. Retrying cannot deliver until the quota resets or is raised. Top up or raise the quota in Postora, then re-queue if still needed.",
  account_needs_reauth:
    "Postora's WhatsApp connection needs an administrator to re-authorize. No retry can fix that. Re-authorize the WhatsApp account in Postora, then re-queue if still needed.",
  idempotency_conflict:
    "The same idempotency key was sent with a different request body. Because Danat uses the notification row id as the key, this row's content changed between attempts. Retrying would resend the same conflicting body. Inspect the row history and either cancel it or enqueue a fresh notification.",
};

/**
 * أكواد Evolution التي لا فائدة من إعادة المحاولة فيها — جلسة QR مفصولة تحتاج
 * إنساناً يعيد المسح، لا حلقةَ محاولات.
 *
 * `partial_send` is here for the same reason Postora's indeterminate code is:
 * some parts already reached the tenant, so a blind retry of the whole row
 * would duplicate them. `unknown_error` is deliberately absent (retryable).
 */
export const EVOLUTION_NEEDS_REVIEW: Readonly<Record<string, string>> = {
  session_disconnected:
    "The WhatsApp QR session is logged out or was never paired. Retrying cannot deliver. Re-scan the QR code in Settings → Integrations, then re-queue if still needed.",
  instance_missing:
    "The Evolution WhatsApp instance no longer exists on the gateway. Re-connect from Settings → Integrations (which recreates it), then re-queue if still needed.",
  number_not_on_whatsapp:
    "The recipient's number is not registered on WhatsApp. Retrying cannot fix the number. Correct the tenant's WhatsApp/mobile number, then re-queue if still needed.",
  partial_send:
    "Some parts of this WhatsApp message (text or attachments) were already delivered before the failure. Retrying would send the delivered parts again. Check the failure reason for how many parts landed and send only what is missing.",
};

/**
 * أكواد يرسلها أكثر من مزوّد وتعني أن الرسالة ربما وصلت — المراجعة البشرية لا إعادة المحاولة.
 *
 * `delivery_indeterminate` is a timeout on a provider with no idempotency key
 * (Twilio, Meta Cloud API, Evolution), or an SMTP timeout mid-send.
 */
export const PROVIDER_NEEDS_REVIEW: Readonly<Record<string, string>> = {
  [DELIVERY_INDETERMINATE]:
    "The provider (WhatsApp or SMTP) did not answer in time, and it cannot tell a retry apart from a new message, so the tenant may already have received this. Retrying risks a duplicate. Check the provider's message log, then either treat this as sent or send a replacement.",
};

/** Merged provider code → reason lookup used by the drain sweep. */
const NEEDS_REVIEW_CODES: Readonly<Record<string, string>> = {
  ...POSTORA_NEEDS_REVIEW,
  ...EVOLUTION_NEEDS_REVIEW,
  ...PROVIDER_NEEDS_REVIEW,
};

/**
 * يقدّر أقصى عدد صفوف يمكن تصريفها قبل إلغاء النافذة (72 ساعة).
 *
 * drain = 100 صف/تشغيل. مع cron يومي: floor(72/24)=3 تشغيلات → 300.
 * ما يبقى بعد النافذة يُلغى — bulk send يجب أن يحذّر فوق هذه السعة.
 */
export function estimatedDrainCapacityWithinStaleWindow(
  drainBatchLimit = DRAIN_BATCH_LIMIT,
  staleAfterHours = STALE_AFTER_HOURS,
  hoursPerCronTick = 24,
): number {
  const ticks = Math.max(1, Math.floor(staleAfterHours / hoursPerCronTick));
  return drainBatchLimit * ticks;
}

/**
 * يصرّف صفوف الإشعار المتبقية بعد الإرسال المباشر: يُرسل المستحق، يُلغي البالي، ويحوّل غموض Postora إلى مراجعة بشرية.
 *
 * `asOf` is accepted to match the cron registry signature; draining is always "now".
 */
export async function runNotificationDrainJob(_asOf: string | null = null) {
  const now = Date.now();
  const staleBefore = new Date(now - STALE_AFTER_HOURS * 60 * 60 * 1000);

  const pending = await supabaseAdmin
    .from("notifications")
    .select("id, state, channel, retry_count, scheduled_at, created_at, error_code, failure_reason")
    .in("state", ["queued", "failed"])
    .order("created_at", { ascending: true })
    .limit(DRAIN_BATCH_LIMIT);
  if (pending.error) throw new Error(pending.error.message);

  const dispatched: string[] = [];
  const retried: string[] = [];
  const cancelled: string[] = [];
  let notYetDue = 0;
  let heldForReview = 0;

  for (const row of pending.data ?? []) {
    // Rows predating the scheduled_at column carry null; fall back to creation.
    const dueAt = new Date(row.scheduled_at ?? row.created_at);

    if (dueAt.getTime() > now) {
      notYetDue += 1;
      continue;
    }

    // Checked BEFORE the stale-cancel branch, deliberately. Age is a reason to
    // stop trying; it is not a reason to conclude the message never arrived.
    // Cancelling a possibly-delivered (or permanently blocked) row would file
    // it as "we gave up" and discard the one fact that matters — that a human
    // must act. Needs-review codes outrank staleness, so they are resolved first.
    // `Object.hasOwn`, not a bare index: error_code arrives from provider JSON,
    // so a code of "constructor" or "toString" would otherwise resolve to an
    // inherited function, read as truthy, and park the row with a failure_reason
    // that JSON.stringify silently drops.
    const reviewReason =
      row.state === "failed" && row.error_code && Object.hasOwn(NEEDS_REVIEW_CODES, row.error_code)
        ? NEEDS_REVIEW_CODES[row.error_code]
        : undefined;
    if (reviewReason) {
      const reviewResult = await supabaseAdmin
        .from("notifications")
        .update({
          state: "needs_review",
          failure_reason: reviewReason,
        })
        .eq("id", row.id)
        .eq("state", row.state);
      if (!reviewResult.error) heldForReview += 1;
      continue;
    }

    if (dueAt < staleBefore) {
      const cancelResult = await supabaseAdmin
        .from("notifications")
        .update({
          state: "cancelled",
          failure_reason: `Cancelled by notification-drain: more than ${STALE_AFTER_HOURS}h past due.`,
        })
        .eq("id", row.id)
        .eq("state", row.state);
      if (!cancelResult.error) cancelled.push(row.id);
      continue;
    }

    if (row.state === "failed") {
      if (row.channel === "both") {
        heldForReview += 1;
        continue;
      }
      if (row.retry_count >= MAX_RETRIES) {
        // Exhaustion is itself the signal. Left as `failed`, the row is
        // indistinguishable from one the next tick will retry — nine overdue
        // reminders sat that way for a day on 2026-09-02 with "transiently
        // (500)" as their reason and nothing telling an admin the gateway had
        // lost its session. Conditional on the state read, like every other
        // transition here.
        const exhausted = await supabaseAdmin
          .from("notifications")
          .update({
            state: "needs_review",
            failure_reason:
              `Gave up after ${MAX_RETRIES} attempts. Last error: ${row.failure_reason ?? "unknown."} ` +
              "Check the provider's status in Settings → Integrations, fix the cause, then re-queue if still needed.",
          })
          .eq("id", row.id)
          .eq("state", "failed");
        if (!exhausted.error) heldForReview += 1;
        continue;
      }
      const result = await dispatchNotificationRecord(row.id);
      if (result.state === "sent") retried.push(row.id);
      continue;
    }

    const result = await dispatchNotificationRecord(row.id);
    if (result.state === "sent") dispatched.push(row.id);
  }

  await supabaseAdmin.rpc("write_audit", {
    p_action: "job.notification_drain",
    p_entity_type: "notification",
    p_entity_id: null,
    p_before: null,
    p_after: {
      scanned: pending.data?.length ?? 0,
      dispatched: dispatched.length,
      retried: retried.length,
      cancelled: cancelled.length,
      not_yet_due: notYetDue,
      held_for_review: heldForReview,
    },
    p_result: "success",
    p_error_code: null,
  });

  return {
    count: dispatched.length + retried.length,
    dispatched,
    retried,
    cancelled,
    notYetDue,
    heldForReview,
  };
}
