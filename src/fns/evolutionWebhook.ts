import { createHash, timingSafeEqual } from "node:crypto";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { backfillChatAvatarsInBackground } from "@/fns/evolutionAvatars";
import { confirmSessionDisconnect } from "@/fns/evolutionSessionWatch";
import type { Json } from "@/integrations/supabase/database.types";
import {
  addressableJid,
  maskJid,
  normalizeEvolutionEvent,
  remoteNumberFor,
} from "@/lib/evolution/client";
import { EVOLUTION_WEBHOOK_HEADER } from "@/fns/evolutionSession";
import {
  inboxStatusForAck,
  isMessageKeyId,
  normalizeAckStatus,
  WHATSAPP_REJECTED_AFTER_SEND,
} from "@/lib/evolution/messageAck";

/**
 * مستقبل ويبهوك Evolution: يوثّق بالسر المشترك ثم يبتلع أحداث الرسائل
 * والاتصال ورموز QR في صفقة واحدة مقاومة للتكرار.
 *
 * Security model: a static per-instance secret configured on Evolution at
 * pairing time, compared in constant time (with the previous secret accepted
 * during rotation). Replay of a message event is harmless — ingestion is
 * idempotent on message_id inside the SQL RPC — and state events only move
 * forward because updates are conditional. The endpoint answers 200 for every
 * authenticated, parseable request so Evolution does not retry-storm us over
 * rows we chose to skip.
 */

/** Reject bodies above this before JSON.parse — webhooks are small. */
const MAX_BODY_BYTES = 1024 * 1024;

const HANDLED_EVENTS = new Set([
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
  "CONNECTION_UPDATE",
  "QRCODE_UPDATED",
]);

/** يبني استجابة JSON برمز الحالة المحدّد. */
function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * مقارنة ثابتة الزمن عبر تلبيد الطرفين، فلا يتسرّب طول السر ولا محتواه.
 */
function secretsMatch(candidate: string, expected: string | null): boolean {
  if (!expected) return false;
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

type Rec = Record<string, unknown>;

/** يعيد القيمة كسجل مفاتيح إن كانت كائناً غير مصفوفي، أو null خلاف ذلك. */
function asRecord(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

/** يوحّد حقل `data` من جسم الويبهوك إلى مصفوفة عناصر رسائل سواء وصل مفرداً أو مصفوفة. */
function messageItems(body: Rec): Rec[] {
  const data = body.data;
  if (Array.isArray(data)) return data.filter((item): item is Rec => !!asRecord(item));
  const single = asRecord(data);
  return single ? [single] : [];
}

/**
 * يستخرج نص الرسالة من أشكال حمولة Baileys المتعددة (نص، نص موسّع، تسمية وسائط).
 */
function extractBody(message: Rec | null): string | null {
  if (!message) return null;
  const conversation = message.conversation;
  if (typeof conversation === "string" && conversation) return conversation;
  const extended = asRecord(message.extendedTextMessage)?.text;
  if (typeof extended === "string" && extended) return extended;
  for (const key of ["imageMessage", "videoMessage", "documentMessage"]) {
    const caption = asRecord(message[key])?.caption;
    if (typeof caption === "string" && caption) return caption;
  }
  return null;
}

/**
 * يصنّف نوع الوسائط واسم الملف من جسم رسالة Baileys.
 */
function extractMedia(message: Rec | null): { mediaType: string | null; fileName: string | null } {
  if (!message) return { mediaType: null, fileName: null };
  if (asRecord(message.imageMessage)) return { mediaType: "image", fileName: null };
  if (asRecord(message.videoMessage)) return { mediaType: "video", fileName: null };
  if (asRecord(message.audioMessage)) return { mediaType: "audio", fileName: null };
  const document = asRecord(message.documentMessage);
  if (document) {
    const fileName = document.fileName;
    return {
      mediaType: "document",
      fileName: typeof fileName === "string" && fileName ? fileName : null,
    };
  }
  if (asRecord(message.stickerMessage)) return { mediaType: "sticker", fileName: null };
  return { mediaType: null, fileName: null };
}

/**
 * يحوّل عنصر رسالة بصيغة Baileys إلى صف إدخال للـ RPC، أو null لما يُتجاهَل
 * (مجموعات، قنوات، معرّفات LID بلا رقم بديل).
 *
 * Shared with the history-sync sweep — findMessages records carry the same
 * shape as MESSAGES_UPSERT items, and one mapper means one set of quirks.
 * History rows pass `countUnread: false` so an import never lights the badge,
 * and `resolveLidNumber` because Evolution stores history under bare `@lid`
 * ids with no phone alias — the sweep supplies the phone it resolved for the
 * whole chat, while live webhook events (already phone-normalised) never
 * need it.
 */
export function buildIngestRow(
  item: Rec,
  options?: { countUnread?: boolean; resolveLidNumber?: (lidJid: string) => string | null },
): Rec | null {
  const key = asRecord(item.key);
  if (!key || typeof key.id !== "string" || !key.id) return null;
  const jid = addressableJid(key);
  let chatNumber = jid ? remoteNumberFor(jid) : null;
  if (!chatNumber) {
    const remote = typeof key.remoteJid === "string" ? key.remoteJid : "";
    if (remote.endsWith("@lid")) {
      chatNumber = options?.resolveLidNumber?.(remote) ?? null;
      if (!chatNumber) {
        console.warn(`[evolution-webhook] dropped unresolved @lid message from ${maskJid(remote)}`);
      }
    }
    if (!chatNumber) return null;
  }
  const fromMe = key.fromMe === true;
  const message = asRecord(item.message);
  const body = extractBody(message);
  const { mediaType, fileName } = extractMedia(message);
  const timestamp = Number(item.messageTimestamp);
  const sentAt =
    Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000) : new Date();
  const pushName = typeof item.pushName === "string" ? item.pushName : null;

  return {
    message_id: key.id,
    chat_number: chatNumber,
    direction: fromMe ? "outbound" : "inbound",
    from_me: fromMe,
    body,
    message_type: mediaType ?? "text",
    media_type: mediaType,
    // Evolution re-fetches media by the message key id, so it doubles as the media id.
    media_id: mediaType ? key.id : null,
    media_filename: fileName,
    sent_at: sentAt.toISOString(),
    push_name: fromMe ? null : pushName,
    count_unread: options?.countUnread ?? true,
    // Allow-listed diagnostic subset only — payloads can embed base64 media.
    raw: {
      key: { id: key.id, remoteJid: key.remoteJid ?? null, fromMe },
      messageTimestamp: Number.isFinite(timestamp) ? timestamp : null,
    },
  };
}

/** يبتلع دفعة الرسائل الواردة/الصادرة من حدث MESSAGES_UPSERT عبر دالة القاعدة ويطلق جلب الصور في الخلفية. */
async function handleMessagesUpsert(companyId: string, body: Rec): Promise<void> {
  const rows = messageItems(body)
    .map((item) => buildIngestRow(item))
    .filter((row): row is Rec => row !== null);
  if (!rows.length) return;
  const result = await companyClient(companyId).rpc("ingest_whatsapp_messages", {
    p_rows: rows as unknown as Json,
  });
  if (result.error) throw new Error(result.error.message);
  // A chat created by this very webhook has no picture yet — the sender is new
  // to us, so nothing cached one. Fetching it here is what makes a first
  // incoming message appear in the list with the same face the phone shows.
  // Deliberately not awaited: Evolution retries a webhook it considers slow,
  // and a retried batch is more work for the same pictures.
  backfillChatAvatarsInBackground(
    rows.map((row) => String(row.chat_number)),
    companyId,
  );
}

/**
 * يطبّق إقرار خادم واتساب على صف الصندوق، وعند الرفض يوقف صف الإشعار للمراجعة.
 *
 * Evolution's payload is `{ keyId, remoteJid, fromMe, status }` (v2.3.7 —
 * the numeric Baileys code is mapped to a string before it reaches us); a
 * raw Baileys shape `{ key: { id, fromMe }, update: { status } }` is accepted
 * too so a gateway upgrade cannot silently stop this. Only our own sends
 * matter: an inbound message's read receipt is not a delivery outcome.
 *
 * On ERROR the notification that carries this id moves straight to
 * `needs_review` — not `failed`, which the drain would retry, and a retry of
 * a time-locked contact is rejected the same way. Conditional on `sent` so
 * a late ack cannot un-cancel a row an admin already handled. The 2026-09-02
 * overdue reminder to one tenant sat `sent` all day this way.
 */
async function handleMessagesUpdate(companyId: string, body: Rec): Promise<void> {
  const db = companyClient(companyId);
  for (const item of messageItems(body)) {
    const key = asRecord(item.key);
    const update = asRecord(item.update);
    const keyId = item.keyId ?? key?.id;
    const fromMe = item.fromMe ?? key?.fromMe;
    const status = normalizeAckStatus(item.status ?? update?.status);
    if (!isMessageKeyId(keyId) || fromMe !== true || !status) continue;

    const inboxStatus = inboxStatusForAck(status);
    if (!inboxStatus) continue;
    const inbox = await db
      .from("whatsapp_messages")
      .update({ status: inboxStatus })
      .eq("message_id", keyId);
    if (inbox.error) throw new Error(inbox.error.message);
    if (status !== "ERROR") continue;

    // A multi-part send stores its ids comma-joined; match the whole id at
    // any position. keyId is validated alphanumeric above, so it is safe in
    // a pattern.
    const parked = await db
      .from("notifications")
      .update({
        state: "needs_review",
        error_code: "whatsapp_rejected",
        failure_reason: WHATSAPP_REJECTED_AFTER_SEND,
      })
      .eq("state", "sent")
      .like("provider_message_id", `%${keyId}%`);
    if (parked.error) throw new Error(parked.error.message);
  }
}

/**
 * يحدّث حالة اتصال الجلسة الواردة من الويبهوك ويطلق تأكيد الانقطاع غير المنتظر للحالات غير المتصلة.
 *
 * Non-open/non-connecting states (`close`, `refused`, …) trigger a live probe in
 * the background so the webhook still returns 200 immediately without risking an
 * unhandled rejection.
 */
async function handleConnectionUpdate(companyId: string, body: Rec): Promise<void> {
  const data = asRecord(body.data);
  const state = String(data?.state ?? data?.connection ?? data?.status ?? "").toLowerCase();
  if (!state) return;
  const updates: { last_connection_state: string; last_qr?: null } =
    state === "open"
      ? { last_connection_state: state, last_qr: null }
      : { last_connection_state: state };
  const result = await companyClient(companyId)
    .from("evolution_connections")
    .update(updates)
    .eq("id", 1);
  if (result.error) throw new Error(result.error.message);
  if (state !== "open" && state !== "connecting") {
    void confirmSessionDisconnect().catch((error) => {
      console.error(
        "[evolution-webhook] disconnect check failed",
        error instanceof Error ? error.message : String(error),
      );
    });
  }
}

/**
 * يحفظ رمز QR المحدّث في صف الاقتران ويضع الحالة على `connecting`.
 */
async function handleQrUpdate(companyId: string, body: Rec): Promise<void> {
  const data = asRecord(body.data);
  const qrcode = asRecord(data?.qrcode);
  const qr = qrcode?.base64 ?? qrcode?.code ?? data?.base64 ?? data?.code ?? null;
  if (typeof qr !== "string" || !qr) return;
  const result = await companyClient(companyId)
    .from("evolution_connections")
    .update({ last_qr: qr, last_connection_state: "connecting" })
    .eq("id", 1);
  if (result.error) throw new Error(result.error.message);
}

/**
 * نقطة دخول الويبهوك؛ تُستدعى من مسار /api/public/evolution-webhook.
 */
export async function respondToEvolutionWebhook(request: Request): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return json(413, { error: "Payload too large" });

  let body: Rec;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const record = asRecord(parsed);
    if (!record) return json(400, { error: "Invalid JSON" });
    body = record;
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const secret = request.headers.get(EVOLUTION_WEBHOOK_HEADER);
  if (!secret) return json(401, { error: "Unauthorized" });

  const companyId = requireRequestCompany().id;
  const connection = await companyClient(companyId)
    .from("evolution_connections")
    .select("instance_name, webhook_secret, previous_webhook_secret")
    .eq("id", 1)
    .maybeSingle();
  if (connection.error) return json(500, { error: "Connection lookup failed" });
  if (!connection.data) return json(401, { error: "Unauthorized" });

  const authorized =
    secretsMatch(secret, connection.data.webhook_secret) ||
    secretsMatch(secret, connection.data.previous_webhook_secret);
  if (!authorized) return json(401, { error: "Unauthorized" });

  // The instance in the payload must be OUR instance: the secret authenticates
  // the gateway, not an arbitrary instance name riding in the body.
  const instanceName = body.instance ?? body.instanceName;
  if (typeof instanceName !== "string" || instanceName !== connection.data.instance_name) {
    return json(401, { error: "Unauthorized" });
  }

  const event = normalizeEvolutionEvent(body.event);
  if (!HANDLED_EVENTS.has(event)) return json(200, { received: true, ignored: true });

  try {
    if (event === "MESSAGES_UPSERT") await handleMessagesUpsert(companyId, body);
    else if (event === "MESSAGES_UPDATE") await handleMessagesUpdate(companyId, body);
    else if (event === "CONNECTION_UPDATE") await handleConnectionUpdate(companyId, body);
    else await handleQrUpdate(companyId, body);
  } catch (error) {
    // A storage failure must surface as 5xx so Evolution redelivers; the
    // ingestion RPC makes the redelivery idempotent.
    console.error(
      "[evolution-webhook] event handling failed",
      event,
      error instanceof Error ? error.message : error,
    );
    return json(500, { error: "Event handling failed" });
  }

  return json(200, { received: true });
}
