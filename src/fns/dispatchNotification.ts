import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { sendEmailChannel } from "@/fns/dispatchEmailChannel";
import { sendWhatsAppChannel } from "@/fns/dispatchWhatsAppChannel";
import {
  stringArray,
  type EnabledConfigs,
  type NotificationIssue,
} from "@/fns/notificationChannel";
import { requirePermission } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json, NotificationProvider, Tables } from "@/integrations/supabase/database.types";
import type { EmailAttachment } from "@/lib/providers/types";
import { ProviderDeliveryError } from "@/lib/providers/types";
import { EvolutionProviderError } from "@/lib/providers/evolution";
import { PostoraProviderError } from "@/lib/providers/postora";
import { isTenantBoundAudience, TENANT_PAUSED_REASON } from "@/lib/tenantNotificationsPaused";

const schema = z.object({ notificationId: z.string().uuid() });

function stringValue(value: Json, key: string): string | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const item = value[key];
  return typeof item === "string" && item.trim() ? item.trim() : null;
}

async function updateNotification(
  id: string,
  updates: Partial<Tables<"notifications">>,
): Promise<Tables<"notifications">> {
  const result = await supabaseAdmin
    .from("notifications")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();
  if (result.error) throw new Error(result.error.message);
  const auditWrite = await supabaseAdmin.rpc("write_audit", {
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
async function enabledConfigs(): Promise<EnabledConfigs> {
  const result = await supabaseAdmin.from("provider_configs").select("*").eq("is_enabled", true);
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
async function loadAttachments(payload: Json): Promise<EmailAttachment[]> {
  const paths = stringArray(payload, "attachment_paths");
  if (!paths.length) return [];
  const displayNames = stringArray(payload, "attachment_names");
  const attachments: EmailAttachment[] = [];
  for (const [index, path] of paths.entries()) {
    // Paths are stored as "bucket/object/path" or default deposit-attachments relative paths.
    const bucket = stringValue(payload, "attachment_bucket") ?? "deposit-attachments";
    const download = await supabaseAdmin.storage.from(bucket).download(path);
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
 * يرسل صف إشعار واحد عبر قناتيه ويسجّل حالته النهائية: مُرسَل، أو متخطّى، أو فاشل.
 *
 * The channels live in `dispatchEmailChannel` and `dispatchWhatsAppChannel`
 * (audit M9); this function owns what they share — loading the row, the
 * tenant, the providers and the attachments once, running email then
 * WhatsApp, and deciding the terminal state from the issues both returned.
 */
export async function dispatchNotificationRecord(
  notificationId: string,
): Promise<Tables<"notifications">> {
  const notificationResult = await supabaseAdmin
    .from("notifications")
    .select("*")
    .eq("id", notificationId)
    .single();
  if (notificationResult.error) throw new Error(notificationResult.error.message);
  const notification = notificationResult.data;
  if (notification.state === "cancelled" || notification.state === "sent") return notification;

  const tenantResult = notification.tenant_id
    ? await supabaseAdmin.from("tenants").select("*").eq("id", notification.tenant_id).single()
    : null;
  if (tenantResult?.error) {
    return updateNotification(notification.id, {
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
    return updateNotification(notification.id, {
      state: "skipped",
      failure_reason: TENANT_PAUSED_REASON,
    });
  }

  const configs = await enabledConfigs();
  const messageIds: string[] = [];
  let selectedProvider: NotificationProvider | null = null;
  let senderAddress: string | null = notification.sender_address;
  const issues: NotificationIssue[] = [];
  const attachments = await loadAttachments(notification.payload);

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
      const whatsapp = await sendWhatsAppChannel({ ...channelInput, senderAddress });
      messageIds.push(...whatsapp.messageIds);
      issues.push(...whatsapp.issues);
      selectedProvider = whatsapp.provider ?? selectedProvider;
      senderAddress = whatsapp.senderAddress;
    }

    if (!messageIds.length) {
      return updateNotification(notification.id, {
        // `every`, not `some`: a batch whose email skipped but whose WhatsApp
        // genuinely failed must stay `failed` so the drain job retries the
        // leg a retry can still deliver. The length guard keeps an empty
        // `issues` recording `failed`, exactly as before.
        state:
          issues.length > 0 && issues.every((issue) => issue.kind === "skip")
            ? "skipped"
            : "failed",
        failure_reason: issues.map((issue) => issue.message).join(" "),
        retry_count: notification.retry_count + 1,
        sender_address: senderAddress,
      });
    }
    return updateNotification(notification.id, {
      state: "sent",
      sent_at: new Date().toISOString(),
      provider: selectedProvider,
      provider_message_id: messageIds.join(","),
      failure_reason: issues.length ? issues.map((issue) => issue.message).join(" ") : null,
      sender_address: senderAddress,
    });
  } catch (error) {
    return updateNotification(notification.id, {
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

export type DispatchNotificationInput = z.infer<typeof schema>;

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
