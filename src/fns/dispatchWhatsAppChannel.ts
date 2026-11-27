import type { SupabaseClient } from "@supabase/supabase-js";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { deliverEvolutionNotification, type WhatsAppPacer } from "@/fns/evolutionDelivery";
import {
  tenantOptedOut,
  type ChannelInput,
  type ChannelOutcome,
  type EnabledConfigs,
  type NotificationIssue,
} from "@/fns/notificationChannel";
import type {
  Database,
  NotificationSkipReason,
  Tables,
} from "@/integrations/supabase/database.types";
import { sendWithPostora } from "@/lib/providers/postora";
import { sendWithTwilio } from "@/lib/providers/twilio";
import type {
  EmailAttachment,
  WhatsAppMediaPart,
  WhatsAppProviderMessage,
} from "@/lib/providers/types";
import { sendWithWhatsApp } from "@/lib/providers/whatsapp";
import type { ProviderTemplateMapping } from "@/lib/providers/whatsappTemplateBinding";
import {
  allowsFreeform,
  resolveMetaBinding,
  resolveTwilioBinding,
} from "@/lib/providers/whatsappTemplateBinding";
import { WHATSAPP_PROVIDERS } from "@/lib/whatsappAvailability";
import { WHATSAPP_SKIP } from "@/lib/whatsappSkipReasons";

/**
 * يختار مزوّد واتساب المُفعّل. evolution_api أولاً لأنها المسار الجديد المُفضّل —
 * مفعّلة واحدة فقط في كل مرة (الزناد في قاعدة البيانات يضمن ذلك)، فالترتيب
 * يُصرّح بالنية بدلاً من حل التعارض.
 *
 * Selects the enabled WhatsApp provider. evolution_api is first because it is
 * the new preferred path — only one WhatsApp provider can be enabled at a time
 * (the database trigger enforces it), so order declares intent, not conflict
 * resolution.
 */
export function whatsappProvider(configs: EnabledConfigs): Tables<"provider_configs"> | null {
  for (const provider of WHATSAPP_PROVIDERS) {
    const config = configs.get(provider);
    if (config) return config;
  }
  return null;
}

/** يقرأ ربط القالب المعتمد لدى المزوّد لرمز القالب المحلي (migration 38) ضمن الشركة. */
async function loadTemplateMapping(
  templateCode: string | null,
  db: SupabaseClient<Database>,
): Promise<ProviderTemplateMapping | null> {
  if (!templateCode) return null;
  const result = await db
    .from("notification_templates")
    .select(
      "allow_freeform, provider_language_code, provider_param_keys, provider_template_name, twilio_content_sid, twilio_variable_keys",
    )
    .eq("code", templateCode)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return result.data ?? null;
}

type WhatsAppSend = { ok: true; value: WhatsAppProviderMessage } | { ok: false; reason: string };

/**
 * مدخلات قناة واتساب: كل ما تحتاجه القناة، ومنظّم الإيقاع وعميل الشركة اختياريان.
 *
 * `pace` is the notify worker's per-connection lock (FR-067). A caller that
 * dispatches outside the notify worker — the notification drain, the manual
 * re-send from the log — passes none, and the provider falls back to its
 * in-process per-connection pacer.
 */
export interface WhatsAppChannelInput extends ChannelInput {
  db?: SupabaseClient<Database>;
  pace?: WhatsAppPacer;
}

/** نتيجة قناة واتساب مع سبب التخطّي المهيكل عند رفض الإرسال بسبب الحصة أو الإعدادات. */
export interface WhatsAppChannelOutcome extends ChannelOutcome {
  skipReason?: NotificationSkipReason;
}

interface WhatsAppSendContext {
  config: Tables<"provider_configs">;
  mapping: ProviderTemplateMapping | null;
  notification: Tables<"notifications">;
  to: string;
}

/** يبني رسالة WhatsApp Cloud API من القالب المعتمد لدى Meta. */
function cloudApiMessage({ config, mapping, notification, to }: WhatsAppSendContext): WhatsAppSend {
  const binding = resolveMetaBinding(mapping, notification.payload, notification.locale);
  if (!binding.ok) return binding;
  return {
    ok: true,
    value: {
      config: config.config,
      from: config.from_whatsapp,
      template: binding.value,
      to,
    },
  };
}

/** يبني رسالة Twilio من Content SID المعتمد، أو نصاً حراً داخل نافذة خدمة مفتوحة. */
function twilioMessage({ config, mapping, notification, to }: WhatsAppSendContext): WhatsAppSend {
  const binding = resolveTwilioBinding(mapping, notification.payload);
  if (binding.ok) {
    return {
      ok: true,
      value: {
        config: config.config,
        contentSid: binding.value.contentSid,
        contentVariables: binding.value.contentVariables,
        from: config.from_whatsapp,
        to,
      },
    };
  }
  // No approved Content SID. Free-form text is only valid inside an open
  // customer-service window, so it needs an explicit assertion from the caller.
  if (!allowsFreeform(mapping, notification.payload)) return binding;
  const body = (notification.body ?? "").trim();
  if (!body) return { ok: false, reason: "Twilio requires a message body." };
  return {
    ok: true,
    value: { allowFreeform: true, body, config: config.config, from: config.from_whatsapp, to },
  };
}

/** Per-file ceiling for WhatsApp media; Evolution re-encodes to base64 in RAM. */
const WHATSAPP_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/**
 * يحوّل نوع المحتوى المخزّن إلى فئة وسائط Evolution؛ المستند هو الافتراضي.
 *
 * The MIME comes from storage metadata (xattrs), not the filename extension —
 * a sender-chosen extension is untrusted, the stored content type is not.
 */
function evolutionMediatype(contentType: string | undefined): WhatsAppMediaPart["mediatype"] {
  if (contentType?.startsWith("image/")) return "image";
  if (contentType?.startsWith("video/")) return "video";
  if (contentType?.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * يبني رسالة Evolution حرة النص: نص الإشعار كما هو، والمرفقات كوسائط.
 *
 * Evolution is a Baileys bridge — no Meta template layer, so no binding
 * resolution: `notification.body` goes out verbatim. That is a deliberate
 * behavioural divergence from the Cloud API path, which refuses to send
 * without an approved template. Oversized attachments fail the leg loudly
 * rather than being silently dropped (same principle as the attachment
 * download error above: a receipt that quietly loses its PDF is
 * indistinguishable from one that never had it).
 */
function evolutionMessage(
  { config, notification, to }: WhatsAppSendContext,
  attachments: EmailAttachment[],
): WhatsAppSend {
  const body = (notification.body ?? "").trim();
  if (!body && !attachments.length) {
    return { ok: false, reason: "Evolution requires a message body." };
  }
  const media: WhatsAppMediaPart[] = [];
  for (const attachment of attachments) {
    const buffer = Buffer.isBuffer(attachment.content)
      ? attachment.content
      : Buffer.from(attachment.content);
    if (buffer.byteLength > WHATSAPP_MEDIA_MAX_BYTES) {
      return {
        ok: false,
        reason: `Attachment "${attachment.filename}" exceeds the ${Math.round(WHATSAPP_MEDIA_MAX_BYTES / 1024 / 1024)}MB WhatsApp media limit.`,
      };
    }
    media.push({
      base64: buffer.toString("base64"),
      fileName: attachment.filename,
      mediatype: evolutionMediatype(attachment.contentType),
      mimeType: attachment.contentType,
    });
  }
  return {
    ok: true,
    value: { body, config: config.config, from: config.from_whatsapp, media, to },
  };
}

/**
 * يرسل قناة واتساب لإشعار واحد ويعيد نتيجتها؛ لا يلتقط أخطاء المزوّد.
 *
 * A provider that refuses before sending (no approved template, oversized
 * media) is an issue of kind "failure" — worth a retry once fixed. A provider
 * that throws propagates, so `dispatchNotificationRecord` records the row
 * failed with the provider's error code, exactly as before the split.
 */
export async function sendWhatsAppChannel(
  input: WhatsAppChannelInput,
): Promise<WhatsAppChannelOutcome> {
  const { notification, tenant, configs, attachments, senderAddress } = input;
  const db = input.db ?? companyClient(requireRequestCompany().id);
  const issues: NotificationIssue[] = [];
  const noSend = (): WhatsAppChannelOutcome => ({
    messageIds: [],
    issues,
    provider: null,
    senderAddress,
  });
  const config = whatsappProvider(configs);
  const waNumber =
    (notification.recipient_address && !notification.recipient_address.includes("@")
      ? notification.recipient_address
      : null) ??
    tenant?.whatsapp ??
    tenant?.mobile ??
    null;

  if (tenantOptedOut(notification, tenant)) {
    issues.push({ kind: "skip", message: WHATSAPP_SKIP.remindersDisabled });
    return noSend();
  }
  if (!waNumber) {
    issues.push({ kind: "skip", message: WHATSAPP_SKIP.noNumber });
    return noSend();
  }
  if (!config) {
    issues.push({ kind: "skip", message: WHATSAPP_SKIP.noProvider });
    return noSend();
  }

  // The approved provider-side template lives on the notification_templates
  // row, keyed by the local template_code (migration 38).
  const mapping = await loadTemplateMapping(notification.template_code, db);
  const context = { config, mapping, notification, to: waNumber };
  const send =
    config.provider === "twilio"
      ? twilioMessage(context)
      : config.provider === "evolution_api"
        ? evolutionMessage(context, attachments)
        : cloudApiMessage(context);

  // A real send attempt that did not happen — the provider (or the template
  // binding it needs) refused, which a fix plus retry can address, so this
  // leg must not drag the row into `skipped`.
  if (!send.ok) {
    issues.push({ kind: "failure", message: `WhatsApp not sent: ${send.reason}` });
    return noSend();
  }

  // نحجز من الحصة الشهرية قبل استدعاء المزوّد مباشرةً؛ وإذا فشل الإرسال بعد الحجز
  // يظل الإرسال محسوباً لأن المزوّد قد يكون أوصل الرسالة فعلاً.
  // Reserve monthly quota right before calling the provider; a failed send
  // after reservation stays counted because the provider may have delivered.
  const quota = await db.rpc("consume_whatsapp_quota");
  if (quota.error) {
    throw new Error(`consume_whatsapp_quota: ${quota.error.message}`);
  }
  if (quota.data === false) {
    issues.push({ kind: "skip", message: "WhatsApp skipped: monthly WhatsApp quota reached." });
    return { ...noSend(), skipReason: "limit_reached" };
  }

  const result =
    config.provider === "twilio"
      ? await sendWithTwilio(send.value)
      : config.provider === "postora"
        ? // The notification row id is the idempotency key: the drain job
          // retries the same row, so the same key reaches Postora and it
          // recognises the duplicate instead of sending the tenant a second
          // message.
          await sendWithPostora(send.value, notification.id)
        : config.provider === "evolution_api"
          ? await deliverEvolutionNotification(send.value, undefined, input.pace)
          : await sendWithWhatsApp(send.value);
  return {
    messageIds: [result.messageId],
    issues,
    provider: config.provider,
    senderAddress: config.from_whatsapp ?? senderAddress,
  };
}
