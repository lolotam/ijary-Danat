import { addressableJid, maskJid, remoteNumberFor } from "@/lib/evolution/client";

type Rec = Record<string, unknown>;

/** يعيد القيمة كسجل مفاتيح إن كانت كائناً غير مصفوفي، أو null خلاف ذلك. */
function asRecord(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
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
