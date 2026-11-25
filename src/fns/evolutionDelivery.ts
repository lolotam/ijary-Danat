import { backfillChatAvatarsInBackground } from "@/fns/evolutionAvatars";
import { reportSendSessionDisconnected } from "@/fns/evolutionSessionWatch";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/database.types";
import { extractState } from "@/lib/evolution/client";
import {
  evolutionClientFromConfig,
  EvolutionProviderError,
  sendWithEvolution,
  sessionDisconnectedError,
} from "@/lib/providers/evolution";
import type {
  ProviderResult,
  WhatsAppMediaPart,
  WhatsAppProviderMessage,
} from "@/lib/providers/types";
import { toInternationalDigits } from "@/lib/providers/types";

/**
 * طبقة التسليم المشتركة عبر Evolution: تتأكد أن جلسة QR مفتوحة، تُرسل، ثم
 * تسجّل الرسائل الصادرة في صندوق واتساب وتخزّن مرفقاتها.
 *
 * Both callers — the notification dispatcher and the inbox composer — go
 * through here so delivery policy cannot diverge: one instance-name source
 * (the evolution_connections singleton), one session check, one send path,
 * one inbox record shape, one media cache. Keeping it in src/fns (not
 * src/lib/providers) because it needs the service-role client, which the
 * provider adapters deliberately do not import.
 */

/** Private bucket holding every chat file, sent or received (migration 182). */
export const WHATSAPP_MEDIA_BUCKET = "whatsapp-media";

/**
 * ينظّف اسم الملف من فواصل المسارات؛ اسم المرسل مُدخل غير موثوق.
 */
export function safeMediaFileName(value: string | null, fallback: string): string {
  const name = (value ?? "").replace(/[/\\]/g, "_").trim();
  return name || fallback;
}

/**
 * مسار الملف في مخزن whatsapp-media: chat/<الرقم>/<معرّف الرسالة>/<الاسم>.
 */
export function whatsappMediaPath(chatNumber: string, messageId: string, fileName: string): string {
  return `chat/${chatNumber}/${messageId}/${fileName}`;
}

type ConnectionRow = { instance_name: string; last_connection_state: string | null };

/**
 * يقرأ صف الاقتران المفرد؛ غيابه يعني أن أحداً لم يمسح رمز QR قط.
 *
 * A missing row is the same terminal condition as a logged-out session, so it
 * carries the same `session_disconnected` code and the drain job parks the
 * notification for the same human fix.
 */
async function loadConnectionRow(): Promise<ConnectionRow> {
  const result = await supabaseAdmin
    .from("evolution_connections")
    .select("instance_name, last_connection_state")
    .eq("id", 1)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) {
    throw new EvolutionProviderError(
      "No WhatsApp QR session has been paired. Scan the QR code in Settings → Integrations.",
      "session_disconnected",
      false,
    );
  }
  return result.data;
}

/**
 * يقرأ اسم النسخة المقترنة من صف evolution_connections المفرد.
 *
 * Existence only — used by the media fetch path, which reads from Evolution's
 * store and does not need a live session. Sends go through
 * {@link requireOpenSession} instead.
 */
export async function loadEvolutionInstanceName(): Promise<string> {
  return (await loadConnectionRow()).instance_name;
}

/**
 * يتأكد أن الجلسة مفتوحة قبل الإرسال؛ يشفي سجلاً بالياً بفحص حيّ واحد.
 *
 * The webhook writes `last_connection_state` the moment WhatsApp unlinks the
 * device, so a send that trusts a `close` row saves a round-trip to a gateway
 * that will answer 500 — and, more importantly, fails with the code that parks
 * the row for a human instead of one that retries it three times.
 *
 * A recorded state other than `open` is verified live before it is believed:
 * a webhook that never arrived (Evolution restarted while the app was
 * deploying) must not silence every WhatsApp until someone opens the settings
 * page. When the probe says `open` the row is healed here, best effort.
 */
async function requireOpenSession(config: Json): Promise<string> {
  const row = await loadConnectionRow();
  if (row.last_connection_state === "open") return row.instance_name;

  const client = evolutionClientFromConfig(config);
  const live = await client
    .connectionState(row.instance_name)
    .then(extractState)
    .catch(() => null);
  if (live !== "open") throw sessionDisconnectedError(live ?? row.last_connection_state);

  const heal = await supabaseAdmin
    .from("evolution_connections")
    .update({ last_connection_state: "open" })
    .eq("id", 1);
  if (heal.error) {
    console.error("[evolutionDelivery] failed to record the healed session state", heal.error);
  }
  return row.instance_name;
}

type OutboundPart = {
  body: string | null;
  media: WhatsAppMediaPart | null;
  messageId: string;
};

/**
 * يسجّل الرسائل الصادرة في جداول صندوق واتساب (أفضل جهد، لا يُفشل الإشعار)،
 * ويختم media_id عند الإرسال نفسه.
 *
 * Inbox visibility is a product feature, not part of delivery: if the RPC
 * fails the tenant still got the message, so this logs and returns instead of
 * throwing. A later `fromMe` webhook echo upserts on the same message_id and
 * heals the gap. media_id cannot wait for that echo though: it is not
 * guaranteed to arrive (a message can sit at "sent" forever), and in Evolution
 * the media id IS the message key id the send response already returned — the
 * same value the webhook would later stamp — so without it here a cache miss
 * can never fall back to Evolution's media store.
 */
async function recordOutboundMessages(chatNumber: string, parts: OutboundPart[]): Promise<void> {
  if (!parts.length) return;
  const sentAt = new Date().toISOString();
  const rows = parts.map((part) => ({
    message_id: part.messageId,
    chat_number: chatNumber,
    direction: "outbound",
    from_me: true,
    body: part.media ? null : part.body,
    message_type: part.media ? part.media.mediatype : "text",
    media_type: part.media ? part.media.mediatype : null,
    media_id: part.media ? part.messageId : null,
    media_filename: part.media ? part.media.fileName : null,
    sent_at: sentAt,
    push_name: null,
    raw: null,
  }));
  const result = await supabaseAdmin.rpc("ingest_whatsapp_messages", { p_rows: rows });
  if (result.error) {
    console.error("[evolutionDelivery] failed to record outbound inbox rows", result.error.message);
    return;
  }
  // Same reason as the inbound path: messaging a number for the first time
  // creates its chat row, and the picture has to come from somewhere. Not
  // awaited — the tenant already has the message, and the notification drain
  // dispatches rows one after another, so a slow gateway here would tax every
  // recipient behind this one.
  backfillChatAvatarsInBackground([chatNumber]);
}

/**
 * يخزّن كل مرفق أُرسل في مخزن whatsapp-media تحت معرّف رسالته (أفضل جهد).
 *
 * Evolution's own media store expires old payloads, so without this copy the
 * inbox bubble for a receipt sent last month downloads nothing. The path is
 * the one `fetchMediaWithCache` looks up first, so a cached send never round
 * trips to the gateway. A failed cache write is logged, not thrown: the tenant
 * already has the file.
 */
async function cacheOutboundMedia(chatNumber: string, parts: OutboundPart[]): Promise<void> {
  for (const part of parts) {
    if (!part.media) continue;
    const path = whatsappMediaPath(
      chatNumber,
      part.messageId,
      safeMediaFileName(part.media.fileName, "file"),
    );
    const upload = await supabaseAdmin.storage
      .from(WHATSAPP_MEDIA_BUCKET)
      .upload(path, Buffer.from(part.media.base64, "base64"), {
        contentType: part.media.mimeType ?? "application/octet-stream",
        upsert: true,
      });
    if (upload.error) {
      console.error(
        "[evolutionDelivery] outbound media cache write failed",
        path,
        upload.error.message,
      );
    }
  }
}

/**
 * يُسلّم رسالة واتساب عبر Evolution ويسجّلها في الصندوق ويخزّن مرفقاتها.
 *
 * On `partial_send` the parts that DID go out are not recorded here (the send
 * threw before returning ids); the webhook `fromMe` echo backfills them, and
 * the notification row's failure_reason tells the admin how many landed.
 */
export async function deliverEvolutionNotification(
  message: WhatsAppProviderMessage,
): Promise<ProviderResult> {
  let result: Awaited<ReturnType<typeof sendWithEvolution>>;
  try {
    const instanceName = await requireOpenSession(message.config);
    result = await sendWithEvolution(message, instanceName);
  } catch (error) {
    if (
      error instanceof EvolutionProviderError &&
      (error.code === "session_disconnected" || error.code === "instance_missing")
    ) {
      await reportSendSessionDisconnected().catch(() => undefined);
    }
    throw error;
  }

  const chatNumber = toInternationalDigits(message.to);
  const body = (message.body ?? "").trim();
  const media = message.media ?? [];
  const parts: OutboundPart[] = result.partIds.map((messageId, index) => {
    // Part order mirrors sendWithEvolution: text first (when present), then media.
    const mediaIndex = body ? index - 1 : index;
    return { messageId, body, media: mediaIndex >= 0 ? (media[mediaIndex] ?? null) : null };
  });
  await recordOutboundMessages(chatNumber, parts);
  await cacheOutboundMedia(chatNumber, parts);

  return { messageId: result.messageId };
}
