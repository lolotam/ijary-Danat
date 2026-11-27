import { createHash, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { backfillChatAvatarsInBackground } from "@/fns/evolutionAvatars";
import { confirmSessionDisconnect } from "@/fns/evolutionSessionWatch";
import { decodeByteaHex } from "@/gateways/connectionStore.server";
import type {
  Database,
  Json,
  WhatsappConnectionStatus,
} from "@/integrations/supabase/database.types";
import {
  addressableJid,
  maskJid,
  normalizeEvolutionEvent,
  remoteNumberFor,
} from "@/lib/evolution/client";
import {
  inboxStatusForAck,
  isMessageKeyId,
  normalizeAckStatus,
  WHATSAPP_REJECTED_AFTER_SEND,
} from "@/lib/evolution/messageAck";
import { decryptSecret } from "@/lib/secrets.server";
import {
  lookupWhatsappConnectionById,
  type WhatsappConnectionOwner,
} from "@/platform/whatsappConnectionLookup.server";
import { EVOLUTION_WEBHOOK_HEADER } from "@/whatsapp/evolutionInstance";

/**
 * مستقبل ويبهوك Evolution: يوجّه كل حدث إلى شركة الاتصال الذي أنتجه، ثم
 * يبتلع أحداث الرسائل والاتصال ورموز QR في صفقة واحدة مقاومة للتكرار.
 *
 * Security model: a per-connection secret, compared in constant time (the
 * previous version is accepted during rotation). The company comes from the
 * connection id in the URL and never from the payload — a payload is the
 * attacker's to write. Replay of a message event is harmless — ingestion is
 * idempotent on message_id inside the SQL RPC — and state events only move
 * forward because the updates are conditional. The endpoint answers 200 for
 * every authenticated, parseable request so Evolution does not retry-storm us
 * over rows we chose to skip.
 */

/** Reject bodies above this before JSON.parse — webhooks are small. */
const MAX_BODY_BYTES = 1024 * 1024;

const HANDLED_EVENTS = new Set([
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
  "CONNECTION_UPDATE",
  "QRCODE_UPDATED",
]);

/** عدد إصدارات سرّ الويبهوك المقبولة (الحالي والسابق أثناء التدوير). */
const ACCEPTED_SECRET_VERSIONS = 2;

const uuidSchema = z.string().uuid();

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
function secretsMatch(candidate: string, expected: string): boolean {
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
async function handleMessagesUpsert(
  db: SupabaseClient<Database>,
  companyId: string,
  body: Rec,
): Promise<void> {
  const rows = messageItems(body)
    .map((item) => buildIngestRow(item))
    .filter((row): row is Rec => row !== null);
  if (!rows.length) return;
  const result = await db.rpc("ingest_whatsapp_messages", {
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
async function handleMessagesUpdate(db: SupabaseClient<Database>, body: Rec): Promise<void> {
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
 * يحوّل حالة جلسة Evolution إلى حالة اتصال واتساب المخزّنة.
 *
 * `refused` and the other failure states are all "error": the panel shows the
 * connection as broken, and the disconnect watcher treats every state that is
 * not "connected" the same way.
 */
function connectionStatusFor(state: string): WhatsappConnectionStatus {
  if (state === "open") return "connected";
  if (state === "connecting") return "pairing";
  if (state === "close" || state === "disconnected") return "disconnected";
  return "error";
}

/**
 * يبني تحديث حالة الاتصال من حالة جلسة Evolution.
 *
 * Leaving "connected" stamps `disconnected_at` once, and entering it re-arms
 * the disconnect alert: the same episode rule the SQL trigger used to enforce
 * on the singleton connection, applied here because the per-company table has
 * no trigger of its own yet.
 */
function connectionStatusUpdates(
  status: WhatsappConnectionStatus,
  previousStatus: WhatsappConnectionStatus,
): Database["public"]["Tables"]["whatsapp_connections"]["Update"] {
  const updates: Database["public"]["Tables"]["whatsapp_connections"]["Update"] = {
    status,
    last_seen_at: new Date().toISOString(),
  };
  if (status === "connected") {
    updates.disconnected_at = null;
    updates.disconnect_alert_armed = true;
  } else if (previousStatus === "connected") {
    updates.disconnected_at = new Date().toISOString();
  }
  return updates;
}

/**
 * يحدّث حالة اتصال الجلسة من حدث ويبهوك ويطلق تأكيد الانقطاع للحالات غير المتصلة.
 *
 * Non-connected states trigger a live probe in the background so the webhook
 * still returns 200 immediately without risking an unhandled rejection.
 */
async function handleConnectionUpdate(
  db: SupabaseClient<Database>,
  owner: WhatsappConnectionOwner,
  body: Rec,
): Promise<void> {
  const data = asRecord(body.data);
  const state = String(data?.state ?? data?.connection ?? data?.status ?? "").toLowerCase();
  if (!state) return;

  const status = connectionStatusFor(state);
  const result = await db
    .from("whatsapp_connections")
    .update(connectionStatusUpdates(status, owner.status))
    .eq("id", owner.id);
  if (result.error) throw new Error(result.error.message);

  if (status !== "connected" && status !== "pairing") {
    void confirmSessionDisconnect({
      companyId: owner.company_id,
      connectionId: owner.id,
    }).catch((error) => {
      console.error(
        "[evolution-webhook] disconnect check failed",
        error instanceof Error ? error.message : String(error),
      );
    });
  }
}

/**
 * يحفظ رمز QR المحدّث في صف الاقتران ويضع الحالة على `pairing`.
 *
 * A late QR event must not knock a paired connection back to `pairing`: the
 * disconnect watcher reads that status, and a connected session that looked
 * unpaired would raise a false disconnect alert.
 */
async function handleQrUpdate(
  db: SupabaseClient<Database>,
  connectionId: string,
  body: Rec,
): Promise<void> {
  const data = asRecord(body.data);
  const qrcode = asRecord(data?.qrcode);
  const qr = qrcode?.base64 ?? qrcode?.code ?? data?.base64 ?? data?.code ?? null;
  if (typeof qr !== "string" || !qr) return;
  const result = await db
    .from("whatsapp_connections")
    .update({ last_qr: qr, status: "pairing" })
    .eq("id", connectionId)
    .neq("status", "connected");
  if (result.error) throw new Error(result.error.message);
}

/**
 * يحلّل جسم الويبهوك إلى سجل مفاتيح، أو null إن لم يكن JSON صالحاً.
 */
function parseWebhookBody(rawBody: string): Rec | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

/**
 * يقرأ سرّ الويبهوك الخاص بالاتصال: أحدث إصدارين، الحالي والسابق أثناء التدوير.
 *
 * The secret lives encrypted in `company_secrets` under the connection's id.
 * Evolution is configured with the new secret before it is stored, so a
 * delivery signed with the previous one must keep landing during that window.
 */
async function loadWebhookSecrets(
  db: SupabaseClient<Database>,
  connectionId: string,
): Promise<string[]> {
  const { data, error } = await db
    .from("company_secrets")
    .select("ciphertext, iv, auth_tag, key_version")
    .eq("owner_kind", "whatsapp")
    .eq("owner_id", connectionId)
    .eq("name", "webhook_secret")
    .order("version", { ascending: false })
    .limit(ACCEPTED_SECRET_VERSIONS);
  if (error) {
    throw new Error(`Failed to load WhatsApp webhook secret: ${error.message}`);
  }
  return (data ?? []).map((row) =>
    decryptSecret({
      ciphertext: decodeByteaHex(row.ciphertext),
      iv: decodeByteaHex(row.iv),
      authTag: decodeByteaHex(row.auth_tag),
      keyVersion: row.key_version,
    }),
  );
}

/**
 * يتحقق أن الحدثomir من نسخة Evolution هذه.
 *
 * The secret authenticates the connection, not an arbitrary instance name
 * riding in the body: a captured secret replayed against another instance must
 * not land in this company's inbox.
 */
function instanceMatches(body: Rec, instanceName: string | null): boolean {
  if (!instanceName) return true;
  const claimed = body.instance ?? body.instanceName;
  return typeof claimed === "string" && claimed === instanceName;
}

/**
 * يوجّه حدث Evolution إلى معالجه داخل شركة الاتصال صاحبه.
 */
async function dispatchEvolutionEvent(
  event: string,
  db: SupabaseClient<Database>,
  owner: WhatsappConnectionOwner,
  body: Rec,
): Promise<void> {
  if (event === "MESSAGES_UPSERT") {
    await handleMessagesUpsert(db, owner.company_id, body);
    return;
  }
  if (event === "MESSAGES_UPDATE") {
    await handleMessagesUpdate(db, body);
    return;
  }
  if (event === "CONNECTION_UPDATE") {
    await handleConnectionUpdate(db, owner, body);
    return;
  }
  await handleQrUpdate(db, owner.id, body);
}

/**
 * نقطة دخول الويبهوك؛ تُستدعى من مسار /api/public/webhooks/evolution/$connectionId.
 *
 * The connection id in the URL is the only thing that says which company the
 * event belongs to. An unknown or inactive connection is refused with a 404
 * that reveals nothing, and the secret is read from the connection's own
 * company before a single row is written.
 */
export async function respondToEvolutionWebhook(
  request: Request,
  connectionId: string,
): Promise<Response> {
  try {
    return await routeEvolutionDelivery(request, connectionId);
  } catch (error) {
    // A storage failure must surface as 5xx so Evolution redelivers; the
    // ingestion RPC makes the redelivery idempotent.
    console.error(
      "[evolution-webhook] delivery failed",
      error instanceof Error ? error.message : error,
    );
    return json(500, { error: "Event handling failed" });
  }
}

/**
 * يوجّه التسليم: يتحقق من الاتصال والسرّ ثم يعالج الحدث داخل شركة صاحبه.
 */
async function routeEvolutionDelivery(request: Request, connectionId: string): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!uuidSchema.safeParse(connectionId).success) return json(404, { error: "Not found." });

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return json(413, { error: "Payload too large" });

  const body = parseWebhookBody(rawBody);
  if (!body) return json(400, { error: "Invalid JSON" });

  const secret = request.headers.get(EVOLUTION_WEBHOOK_HEADER);
  if (!secret) return json(401, { error: "Unauthorized" });

  const owner = await lookupWhatsappConnectionById(connectionId);
  if (!owner || !owner.is_active || owner.method !== "evolution_qr") {
    return json(404, { error: "Not found." });
  }

  const db = companyClient(owner.company_id);
  const expectedSecrets = await loadWebhookSecrets(db, connectionId);
  if (!expectedSecrets.length) return json(503, { error: "Webhook secret is not configured." });
  if (!expectedSecrets.some((expected) => secretsMatch(secret, expected))) {
    return json(401, { error: "Unauthorized" });
  }
  if (!instanceMatches(body, owner.instance_name)) {
    return json(401, { error: "Unauthorized" });
  }

  const event = normalizeEvolutionEvent(body.event);
  if (!HANDLED_EVENTS.has(event)) return json(200, { received: true, ignored: true });

  await dispatchEvolutionEvent(event, db, owner, body);

  return json(200, { received: true });
}
