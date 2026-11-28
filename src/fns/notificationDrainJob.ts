import type { SupabaseClient } from "@supabase/supabase-js";

import { companyClient } from "@/company/companyClient.server";
import {
  getRequestCompany,
  requireRequestCompany,
  runWithRequestCompany,
} from "@/company/requestCompany.server";
import {
  dispatchNotificationRecord,
  retryFailedNotificationRecord,
} from "@/fns/dispatchNotification.server";
import type { Database, Json } from "@/integrations/supabase/database.types";
import { notificationDispatchDedupeKey } from "@/jobs/catalog";
import { DELIVERY_INDETERMINATE, EMAIL_SENDER_NOT_CONFIGURED } from "@/lib/providers/types";

/**
 * Sweeps the notifications that no dispatch job holds.
 *
 * The notification request path enqueues a `notification.dispatch` job and
 * returns, so the row waits for the notify worker. Two kinds of row reach
 * this sweep with nobody else holding them:
 * - a manual send scheduled for a future time (`sendNotification`), which is
 *   inserted `queued` with no dispatch job — this sweep is what sends it once
 *   its time comes;
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
 * - **A row the notify worker is already sending is left alone.** The
 *   notification request path enqueues `notification.dispatch` and returns, so
 *   the row stays `queued` until the worker picks it up. Dispatching it here
 *   as well would deliver the same message to the same recipient twice.
 * - **A row another dispatcher holds is left alone (GR-001).** Every dispatch
 *   first claims its row with a lease (`dispatch_claimed_at`), so of the
 *   drain, the `notification.dispatch` worker and the retry paths exactly one
 *   sends a row. A queued row whose claim this run loses comes back still
 *   `queued` — its sender is mid-send — and is counted `skippedInFlight`; a
 *   queued row whose lease expired is reclaimed by the claim and sent here.
 * - **A retried `failed` row is claimed before it is dispatched (GR-010).**
 *   The report delivery re-queue retries failed rows too, and without a claim
 *   both paths could dispatch the one row — the tenant would get the message
 *   twice. `retryFailedNotificationRecord` hands the row to exactly one of
 *   them; a claim lost here counts as `skippedInFlight`, because another
 *   retry path now holds the row.
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
    "The same idempotency key was sent with a different request body. Because IJARY uses the notification row id as the key, this row's content changed between attempts. Retrying would resend the same conflicting body. Inspect the row history and either cancel it or enqueue a fresh notification.",
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
  [EMAIL_SENDER_NOT_CONFIGURED]:
    "Neither the company nor the platform has an email sender that can send this message. Retrying cannot configure one. Store the company's sender credential in Settings → Notifications, or set the platform default sender, then send the message again.",
};

/** Merged provider code → reason lookup used by the drain sweep. */
const NEEDS_REVIEW_CODES: Readonly<Record<string, string>> = {
  ...POSTORA_NEEDS_REVIEW,
  ...EVOLUTION_NEEDS_REVIEW,
  ...PROVIDER_NEEDS_REVIEW,
};

/**
 * يقرأ معرّف الإشعار من حمولة مهمة `notification.dispatch`.
 *
 * The payload is a jsonb column, so it can hold any JSON value; a row whose
 * payload is not an object names no notification.
 */
function notificationIdFromJobPayload(payload: Json): string | null {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return null;
  const notificationId = (payload as Record<string, unknown>).notificationId;
  return typeof notificationId === "string" ? notificationId : null;
}

/**
 * يقرأ معرّفات الإشعارات التي لها مهمة إرسال جارية، فيتخطّاها مهمة التصريف.
 *
 * The notification request path enqueues `notification.dispatch` and returns,
 * so the row stays `queued` until the notify worker picks it up. A drain
 * that dispatches the same row sends the tenant the message twice — once
 * from the drain and once from the worker.
 *
 * The lookup is narrowed by the catalogue's dedupe key, a plain text column
 * the database can filter on, and confirmed by the payload's
 * `notificationId` — the field the catalogue defines for this kind
 * (contracts/jobs.md section 5).
 */
async function inFlightDispatchNotificationIds(
  db: SupabaseClient<Database>,
  notificationIds: string[],
): Promise<Set<string>> {
  if (!notificationIds.length) return new Set();
  const result = await db
    .from("job_requests")
    .select("payload, dedupe_key")
    .eq("kind", "notification.dispatch")
    .in("status", ["pending", "published", "running"])
    .in("dedupe_key", notificationIds.map(notificationDispatchDedupeKey));
  if (result.error) throw new Error(result.error.message);
  const candidates = new Set(notificationIds);
  const inFlight = new Set<string>();
  for (const row of result.data ?? []) {
    const notificationId = notificationIdFromJobPayload(row.payload);
    if (notificationId && candidates.has(notificationId)) inFlight.add(notificationId);
  }
  return inFlight;
}

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
export async function runNotificationDrainJob(_asOf: string | null = null, companyId?: string) {
  const activeCompany = getRequestCompany();
  const resolvedCompanyId = companyId ?? requireRequestCompany().id;
  const db = companyClient(resolvedCompanyId);

  const execute = async () => {
    const now = Date.now();
    const staleBefore = new Date(now - STALE_AFTER_HOURS * 60 * 60 * 1000);

    const pending = await db
      .from("notifications")
      .select(
        "id, state, channel, retry_count, scheduled_at, created_at, error_code, failure_reason",
      )
      .in("state", ["queued", "failed"])
      .order("created_at", { ascending: true })
      .limit(DRAIN_BATCH_LIMIT);
    if (pending.error) throw new Error(pending.error.message);

    const dispatched: string[] = [];
    const retried: string[] = [];
    const cancelled: string[] = [];
    let notYetDue = 0;
    let heldForReview = 0;

    // A row the notify worker is already sending is not the drain's to touch:
    // both would deliver the same message to the same recipient.
    const inFlight = await inFlightDispatchNotificationIds(
      db,
      (pending.data ?? []).map((row) => row.id),
    );
    let skippedInFlight = 0;

    for (const row of pending.data ?? []) {
      if (inFlight.has(row.id)) {
        skippedInFlight += 1;
        continue;
      }

      const dueAt = new Date(row.scheduled_at ?? row.created_at);

      if (dueAt.getTime() > now) {
        notYetDue += 1;
        continue;
      }

      const reviewReason =
        row.state === "failed" &&
        row.error_code &&
        Object.hasOwn(NEEDS_REVIEW_CODES, row.error_code)
          ? NEEDS_REVIEW_CODES[row.error_code]
          : undefined;
      if (reviewReason) {
        const reviewResult = await db
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
        const cancelResult = await db
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
          const exhausted = await db
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
        const claimed = await retryFailedNotificationRecord(
          row.id,
          row.retry_count,
          resolvedCompanyId,
        );
        if (!claimed) {
          // Another retry path (the report re-queue, a second drain run) holds
          // this row now — dispatching it here as well would send it twice.
          skippedInFlight += 1;
          continue;
        }
        if (claimed.state === "sent") retried.push(row.id);
        continue;
      }

      const result = await dispatchNotificationRecord(row.id, { companyId: resolvedCompanyId });
      if (result.state === "sent") {
        dispatched.push(row.id);
      } else if (result.state === "queued") {
        // GR-001: the dispatch claim rejected this run — the row came back
        // still `queued` because another sender holds its lease and is
        // sending it right now. Dispatching it here as well would deliver the
        // same message to the same recipient twice.
        skippedInFlight += 1;
      }
    }

    await db.rpc("write_audit", {
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
        skipped_in_flight: skippedInFlight,
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
      skippedInFlight,
    };
  };

  if (activeCompany?.id === resolvedCompanyId) {
    return execute();
  }
  return runWithRequestCompany(
    {
      id: resolvedCompanyId,
      slug: activeCompany?.slug ?? "",
      status: "active",
      host: activeCompany?.host ?? "",
    },
    execute,
  );
}
