import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { sendEmailChannel } from "@/fns/dispatchEmailChannel";
import { sendWhatsAppChannel } from "@/fns/dispatchWhatsAppChannel";
import type { WhatsAppPacer } from "@/fns/evolutionDelivery";
import {
  stringArray,
  type EnabledConfigs,
  type NotificationIssue,
} from "@/fns/notificationChannel";
import { requirePermission } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type {
  Database,
  Json,
  NotificationProvider,
  NotificationSkipReason,
  Tables,
} from "@/integrations/supabase/database.types";
import type { EmailAttachment } from "@/lib/providers/types";
import { ProviderDeliveryError } from "@/lib/providers/types";
import { EvolutionProviderError } from "@/lib/providers/evolution";
import { PostoraProviderError } from "@/lib/providers/postora";
import { isTenantBoundAudience, TENANT_PAUSED_REASON } from "@/lib/tenantNotificationsPaused";

const schema = z.object({ notificationId: z.string().uuid() });
type DispatchDb = SupabaseClient<Database>;

/**
 * طول حجز إرسال الإشعار بالمللي ثانية: عشر دقائق.
 *
 * The lease must outlast the longest realistic dispatch — two channels,
 * attachment downloads and provider round-trips finish well within a minute —
 * so a sender still working cannot lose its claim mid-send, while a sender
 * that crashed mid-send leaves a row the next drain reclaims instead of one
 * stuck until the 72-hour stale window cancels it.
 */
export const DISPATCH_LEASE_MS = 10 * 60 * 1000;

/** يستخرج نصاً غير فارغ من مفتاح داخل حمولة JSON، أو null إن غاب. */
function stringValue(value: Json, key: string): string | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const item = value[key];
  return typeof item === "string" && item.trim() ? item.trim() : null;
}

/**
 * يكتب الحالة النهائية لصف إشعار ويسجّلها في سجل التدقيق، ويحرّر حجز الإرسال.
 *
 * Every terminal write clears `dispatch_claimed_at` (GR-001): the lease must
 * describe exactly one dispatch attempt, and a row that reached `sent`,
 * `failed`, `skipped` (or that this call parks) is no longer being sent by
 * anyone. Migration 315's trigger enforces the same rule database-side for
 * the writers outside this module.
 */
async function updateNotification(
  db: DispatchDb,
  id: string,
  updates: Partial<Tables<"notifications">>,
): Promise<Tables<"notifications">> {
  const result = await db
    .from("notifications")
    .update({ ...updates, dispatch_claimed_at: null })
    .eq("id", id)
    .select("*")
    .single();
  if (result.error) throw new Error(result.error.message);
  const auditWrite = await db.rpc("write_audit", {
    p_action: "notification.dispatch",
    p_entity_type: "notification",
    p_entity_id: id,
    p_before: null,
    p_after: {
      failure_reason: result.data.failure_reason,
      provider: result.data.provider,
      provider_message_id: result.data.provider_message_id,
      state: result.data.state,
    },
    p_result: result.data.state === "sent" ? "success" : "failure",
    p_error_code: result.data.state === "sent" ? null : "NOTIFICATION_DISPATCH_FAILED",
  });
  if (auditWrite.error) throw new Error(auditWrite.error.message);
  return result.data;
}

/** يقرأ المزوّدين المفعّلين، مفهرسين باسم المزوّد. */
async function enabledConfigs(db: DispatchDb): Promise<EnabledConfigs> {
  const result = await db.from("provider_configs").select("*").eq("is_enabled", true);
  if (result.error) throw new Error(result.error.message);
  return new Map(result.data.map((config) => [config.provider, config]));
}

/**
 * يحمّل مرفقات الإشعار من التخزين، ويسمّيها بالاسم المعروض حين يوفّره الحمل.
 *
 * `attachment_names` exists because a stored key is not a filename: receipt
 * objects end in a payment id and a content hash that make the upload
 * idempotent, and a tenant receiving `REC-…-8f3c1a…-0b91.pdf` cannot match it to
 * the receipt they were issued. The list is positional against
 * `attachment_paths` and is only produced complete, so an index that has no name
 * falls back to the stored basename rather than borrowing its neighbour's.
 */
async function loadAttachments(db: DispatchDb, payload: Json): Promise<EmailAttachment[]> {
  const paths = stringArray(payload, "attachment_paths");
  if (!paths.length) return [];
  const displayNames = stringArray(payload, "attachment_names");
  const attachments: EmailAttachment[] = [];
  for (const [index, path] of paths.entries()) {
    // Paths are stored as "bucket/object/path" or default deposit-attachments relative paths.
    const bucket = stringValue(payload, "attachment_bucket") ?? "deposit-attachments";
    const download = await db.storage.from(bucket).download(path);
    if (download.error) {
      // Was a bare `continue`: the mail went out with the attachment silently
      // missing, indistinguishable from one that never had it configured.
      // Storage content types live in POSIX xattrs here, and a copy that drops
      // them makes every object 500 while looking present on disk — precisely
      // the failure that must not be swallowed.
      console.error(
        "[dispatchNotification] attachment download failed",
        bucket,
        path,
        download.error.message,
      );
      continue;
    }
    const buffer = Buffer.from(await download.data.arrayBuffer());
    const filename = displayNames[index] ?? path.split("/").pop() ?? "attachment.bin";
    const contentType = download.data.type || undefined;
    attachments.push({ filename, content: buffer, contentType });
  }
  return attachments;
}

/**
 * صف إشعار بعد حجز الإرسال: مهلة الحجز مكتوبة عليه بالضرورة.
 *
 * The claim stamps `dispatch_claimed_at` and `returning *` echoes it back, so
 * the lease on this row is a concrete timestamp — the compare-and-swap that
 * releases it later needs a non-null value (`eq` in PostgREST refuses null).
 */
type ClaimedNotification = Tables<"notifications"> & { dispatch_claimed_at: string };

/**
 * يحجز صف إشعار واحداً للإرسال: تحديث شرطي يعلن أن هذا المتصل — وحده — يرسله الآن.
 *
 * GR-001: the retry compare-and-swap did not stop a claimed row from being
 * sent twice. While one caller was dispatching inline, the notification drain
 * (its `queued, failed` scan and its queued branch) or the
 * `notification.dispatch` worker could read the same row as `queued` and
 * dispatch it again. The claim closes that window: one atomic conditional
 * update — `state in ('queued', 'failed')` and the lease free or expired —
 * and of two concurrent callers only the one Postgres lets update the row
 * gets it back. A caller that gets `null` owns nothing and must send nothing.
 *
 * The lease value is written from the application clock (PostgREST sends a
 * literal, not `now()`) and compared against the same clock, so set and check
 * live in one time domain. See `DISPATCH_LEASE_MS` for its length.
 */
async function claimNotificationForDispatch(
  db: DispatchDb,
  notificationId: string,
  companyId: string,
): Promise<ClaimedNotification | null> {
  const claimedAt = new Date().toISOString();
  const leaseExpiredBefore = new Date(Date.now() - DISPATCH_LEASE_MS).toISOString();
  const claimed = await db
    .from("notifications")
    .update({ dispatch_claimed_at: claimedAt })
    .eq("id", notificationId)
    .eq("company_id", companyId)
    .in("state", ["queued", "failed"])
    .or(`dispatch_claimed_at.is.null,dispatch_claimed_at.lt.${leaseExpiredBefore}`)
    .select("*")
    .maybeSingle();
  if (claimed.error) throw new Error(claimed.error.message);
  if (!claimed.data) return null;
  return { ...claimed.data, dispatch_claimed_at: claimedAt };
}

/**
 * يرسل صف إشعار محجوز ويكتب حالته النهائية: مُرسَل، أو متخطّى، أو فاشل.
 *
 * The channels live in `dispatchEmailChannel` and `dispatchWhatsAppChannel`
 * (audit M9); this function owns what they share — loading the row, the
 * tenant, the providers and the attachments once, running email then
 * WhatsApp, and deciding the terminal state from the issues both returned.
 * Every write it makes goes through `updateNotification`, which clears the
 * dispatch lease (GR-001).
 *
 * `pace` is the notify worker's per-connection WhatsApp lock (FR-067). A
 * caller that dispatches outside the notify worker — the notification drain,
 * the manual re-send from the log — passes none, and the provider falls back
 * to its in-process per-connection pacer.
 */
async function sendClaimedNotification(
  db: DispatchDb,
  notification: Tables<"notifications">,
  opts?: { pace?: WhatsAppPacer },
): Promise<Tables<"notifications">> {
  const tenantResult = notification.tenant_id
    ? await db.from("tenants").select("*").eq("id", notification.tenant_id).single()
    : null;
  if (tenantResult?.error) {
    return updateNotification(db, notification.id, {
      state: "failed",
      failure_reason: tenantResult.error.message,
      retry_count: notification.retry_count + 1,
    });
  }
  const tenant = tenantResult?.data ?? null;

  // Owner decision 2026-10-20: a paused tenant receives nothing
  // through the pipeline. The enqueue path holds back only rows sent at once,
  // so this is the guard for everything else: rows queued before the switch
  // was turned on, deferred rows (dispatch: false, a later scheduled_at) and
  // drain retries. The tenant was loaded above for every row that has one, and
  // an unreadable tenant already failed the row, so no send reaches here unread.
  if (isTenantBoundAudience(notification.audience) && tenant?.notifications_paused) {
    return updateNotification(db, notification.id, {
      state: "skipped",
      failure_reason: TENANT_PAUSED_REASON,
    });
  }

  const configs = await enabledConfigs(db);
  const messageIds: string[] = [];
  let selectedProvider: NotificationProvider | null = null;
  let senderAddress: string | null = notification.sender_address;
  let whatsappSkipReason: NotificationSkipReason | undefined;
  const issues: NotificationIssue[] = [];
  const attachments = await loadAttachments(db, notification.payload);

  try {
    const channelInput = { notification, tenant, configs, attachments };
    const wantsEmail = notification.channel === "email" || notification.channel === "both";
    const wantsWhatsApp = notification.channel === "whatsapp" || notification.channel === "both";
    // Sequential, email first, and neither catches: a thrown email error must
    // fail the row before WhatsApp is attempted, as it always has.
    if (wantsEmail) {
      const email = await sendEmailChannel({ ...channelInput, senderAddress });
      messageIds.push(...email.messageIds);
      issues.push(...email.issues);
      selectedProvider = email.provider ?? selectedProvider;
      senderAddress = email.senderAddress;
    }
    if (wantsWhatsApp) {
      const whatsapp = await sendWhatsAppChannel({
        ...channelInput,
        db,
        senderAddress,
        pace: opts?.pace,
      });
      messageIds.push(...whatsapp.messageIds);
      issues.push(...whatsapp.issues);
      selectedProvider = whatsapp.provider ?? selectedProvider;
      senderAddress = whatsapp.senderAddress;
      whatsappSkipReason = whatsapp.skipReason;
    }

    if (!messageIds.length) {
      const nextState =
        issues.length > 0 && issues.every((issue) => issue.kind === "skip") ? "skipped" : "failed";
      return updateNotification(db, notification.id, {
        // `every`, not `some`: a batch whose email skipped but whose WhatsApp
        // genuinely failed must stay `failed` so the drain job retries the
        // leg a retry can still deliver. The length guard keeps an empty
        // `issues` recording `failed`, exactly as before.
        state: nextState,
        ...(nextState === "skipped" && whatsappSkipReason
          ? { skip_reason: whatsappSkipReason }
          : {}),
        failure_reason: issues.map((issue) => issue.message).join(" "),
        retry_count: notification.retry_count + 1,
        sender_address: senderAddress,
      });
    }
    return updateNotification(db, notification.id, {
      state: "sent",
      sent_at: new Date().toISOString(),
      provider: selectedProvider,
      provider_message_id: messageIds.join(","),
      failure_reason: issues.length ? issues.map((issue) => issue.message).join(" ") : null,
      sender_address: senderAddress,
    });
  } catch (error) {
    return updateNotification(db, notification.id, {
      state: "failed",
      failure_reason: error instanceof Error ? error.message : "Notification dispatch failed.",
      error_code:
        error instanceof PostoraProviderError ||
        error instanceof EvolutionProviderError ||
        error instanceof ProviderDeliveryError
          ? error.code
          : null,
      retry_count: notification.retry_count + 1,
      sender_address: senderAddress,
    });
  }
}

/**
 * يعيد صف إشعار محجوز إلى `failed` بعد خطأ في منتصف الإرسال، ثم يُرمى الخطأ.
 *
 * GR-004: a throw after the claim — loading the provider configs, reading an
 * attachment, the audit write — left the row `queued` with its failure context
 * already cleared and its `retry_count` untouched, so the drain's queued
 * branch dispatched it again while ignoring MAX_RETRIES. This write records
 * the attempt that really ran: `failed`, `retry_count + 1`, the error message
 * and the lease released.
 *
 * The write is a compare-and-swap on the lease this attempt holds: if a
 * terminal write already landed (the audit threw after the state was written)
 * or another sender reclaimed an expired lease mid-send, the row is not this
 * attempt's to fail and the update matches nothing.
 */
async function failClaimedNotification(
  db: DispatchDb,
  notification: ClaimedNotification,
  error: unknown,
): Promise<void> {
  const failed = await db
    .from("notifications")
    .update({
      state: "failed",
      failure_reason: error instanceof Error ? error.message : "Notification dispatch failed.",
      retry_count: notification.retry_count + 1,
      dispatch_claimed_at: null,
    })
    .eq("id", notification.id)
    .eq("dispatch_claimed_at", notification.dispatch_claimed_at)
    .select("id")
    .maybeSingle();
  if (failed.error) {
    // The thrown dispatch error is the real failure and is rethrown by the
    // caller; the failed bookkeeping write is only logged so a row left
    // `queued` with a held lease stays traceable instead of vanishing.
    console.error("[dispatchNotification] failed to record the failure", failed.error.message);
  }
}

/**
 * يرسل صف إشعار واحد عبر قناتيه ويسجّل حالته النهائية: مُرسَل، أو متخطّى، أو فاشل.
 *
 * A `sent`, `skipped`, or `cancelled` row is returned untouched — no claim, no write.
 * Everything else must be claimed first (GR-001): of the drain, the
 * `notification.dispatch` worker and the retry paths, exactly one caller is
 * allowed to send a row, and a caller that loses the claim returns the row as
 * it is now without reaching any provider. A throw after the claim is
 * recorded as a real failed attempt and rethrown (GR-004) instead of leaving
 * the row looking merely queued.
 */
export async function dispatchNotificationRecord(
  notificationId: string,
  opts?: { companyId?: string; pace?: WhatsAppPacer },
): Promise<Tables<"notifications">> {
  const companyId = opts?.companyId ?? requireRequestCompany().id;
  const db = companyClient(companyId);

  const notificationResult = await db
    .from("notifications")
    .select("*")
    .eq("id", notificationId)
    .single();
  if (notificationResult.error) throw new Error(notificationResult.error.message);
  const notification = notificationResult.data;
  if (
    notification.state === "cancelled" ||
    notification.state === "sent" ||
    notification.state === "skipped"
  ) {
    return notification;
  }

  const claimed = await claimNotificationForDispatch(db, notificationId, companyId);
  if (!claimed) {
    // GR-001: the claim was lost — another sender holds the row right now, or
    // it reached a terminal state after the read above. This is a no-op: the
    // row is returned as it is now and no provider is contacted.
    const current = await db.from("notifications").select("*").eq("id", notificationId).single();
    if (current.error) throw new Error(current.error.message);
    return current.data;
  }

  try {
    return await sendClaimedNotification(db, claimed, opts);
  } catch (error) {
    await failClaimedNotification(db, claimed, error);
    throw error;
  }
}

export type DispatchNotificationInput = z.infer<typeof schema>;

/**
 * يعيد محاولة صف إشعار فاشل واحد: يحجزه بتحديث شرطي، ثم يصرّفه إن كان له وحده.
 *
 * GR-010: the notification drain's retry of a failed row and the report
 * delivery re-queue could both dispatch the same row — each read `failed` and
 * sent, so one tenant could get the same message twice. The claim is a
 * compare-and-swap: `state = 'failed' AND retry_count = <seen>` is exactly the
 * row this caller read, and the update moves it to `queued`, so of two
 * concurrent callers only the one Postgres lets update the row gets it back —
 * and only that caller dispatches. A caller that gets `null` holds nothing and
 * must send nothing.
 *
 * `null` also comes back when the dispatch claim itself was lost (GR-001):
 * the compare-and-swap won but another sender claimed the row in the window
 * before this dispatch. That caller sent nothing and owns nothing, so it is
 * reported exactly like a lost compare-and-swap — the winner records the
 * outcome.
 *
 * Clearing `failure_reason` and `error_code` on the claim is the Notification
 * Log's Retry button behaviour: the partner code that parked the row must not
 * judge the new attempt before it runs.
 */
export async function retryFailedNotificationRecord(
  notificationId: string,
  seenRetryCount: number,
  companyId: string,
): Promise<Tables<"notifications"> | null> {
  const db = companyClient(companyId);
  const claimed = await db
    .from("notifications")
    .update({ state: "queued", failure_reason: null, error_code: null })
    .eq("id", notificationId)
    .eq("state", "failed")
    .eq("retry_count", seenRetryCount)
    .select("*")
    .maybeSingle();
  if (claimed.error) throw new Error(claimed.error.message);
  if (!claimed.data) return null;
  const dispatched = await dispatchNotificationRecord(claimed.data.id, { companyId });
  return dispatched.dispatch_claimed_at ? null : dispatched;
}

export const dispatchNotification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "notifications.send",
      attempted: "notification.dispatch",
      refusal: "You do not have permission to send notifications.",
    });
    return dispatchNotificationRecord(data.notificationId);
  });
