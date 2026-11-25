import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  deliverEvolutionNotification,
  loadEvolutionInstanceName,
  safeMediaFileName,
  WHATSAPP_MEDIA_BUCKET,
  whatsappMediaPath,
} from "@/fns/evolutionDelivery";
import { requireEnabledEvolutionConfig } from "@/fns/whatsappChat";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Tables } from "@/integrations/supabase/database.types";
import { evolutionClientFromConfig } from "@/lib/providers/evolution";
import type { WhatsAppMediaPart } from "@/lib/providers/types";
import { type PermissionContext, requirePermission } from "@/fns/requirePermission";

/**
 * وسائط صندوق واتساب: تنزيل مرفقات المحادثة، إرسال ملفات من الملحن،
 * وإعادة توجيه أي رسالة.
 *
 * Every fetched file is cached in the private `whatsapp-media` bucket
 * (migration 182) under chat/<number>/<message id>/<file name>; sent files are
 * cached by the delivery layer itself, so the composer, forwarding and the
 * notification dispatcher all leave the same trail. The cache is the
 * durability layer: Evolution's own media store expires old payloads, and the
 * bucket lives on the Supabase Storage bind mount, so a receipt a tenant sent
 * last year stays downloadable after any redeploy.
 */

const BUCKET = WHATSAPP_MEDIA_BUCKET;
/** Decoded ceiling for a single chat file, matching the send-side cap. */
const MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/** يرفض طلب صندوق واتساب إن لم يملك المستخدم الصلاحية، بعد تسجيل الرفض. */
async function assertPermission(context: PermissionContext, code: string): Promise<void> {
  await requirePermission(context, {
    code,
    attempted: "whatsapp.media",
    refusal: "You do not have permission to use the WhatsApp inbox.",
  });
}

/** Real extensions for the MIME types WhatsApp media actually arrives as. */
const EXT_FOR_MIME: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "application/pdf": "pdf",
};

/** Last-resort extensions when the store returned no usable MIME type. */
const EXT_FOR_TYPE: Readonly<Record<string, string>> = {
  image: "jpg",
  sticker: "webp",
  video: "mp4",
  audio: "ogg",
};

/**
 * اسم التنزيل المعروض: اسم المرسل إن وُجد، وإلا اسم مولّد بامتداد حقيقي.
 *
 * WhatsApp images/videos/audio carry NO filename in their payload, and a
 * fabricated extension like ".image" produces a file nothing can open — the
 * extension must come from the actual MIME type, with the base MIME's
 * parameters (";codecs=…") stripped before lookup.
 */
function displayFileName(
  row: Pick<Tables<"whatsapp_messages">, "media_filename" | "media_type" | "message_id">,
  mimeType: string,
): string {
  if (row.media_filename) return safeMediaFileName(row.media_filename, "attachment.bin");
  const baseMime = mimeType.split(";")[0].trim().toLowerCase();
  const ext = EXT_FOR_MIME[baseMime] ?? EXT_FOR_TYPE[row.media_type ?? ""] ?? "bin";
  return `${row.media_type ?? "file"}-${row.message_id.slice(0, 8).toLowerCase()}.${ext}`;
}

/**
 * يحوّل نوع MIME إلى فئة وسائط Evolution؛ المستند هو الافتراضي.
 */
function mediatypeForMime(mimeType: string): WhatsAppMediaPart["mediatype"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

async function loadMediaRow(messageId: string): Promise<Tables<"whatsapp_messages">> {
  const result = await supabaseAdmin
    .from("whatsapp_messages")
    .select("*")
    .eq("message_id", messageId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Message not found.");
  return result.data;
}

interface FetchedMedia {
  base64: string;
  fileName: string;
  mimeType: string;
}

/**
 * يجلب ملف رسالة: من مخزن whatsapp-media أولاً، وإلا من Evolution ثم يخزّنه.
 *
 * Only media_type is required up front: the delivery layer caches every sent
 * file in the bucket at send time, so an outbound message whose webhook echo
 * never arrived still has its bytes on disk with a NULL media_id. media_id is
 * needed solely for the Evolution fallback, so it is checked only once the
 * cache has missed.
 */
async function fetchMediaWithCache(row: Tables<"whatsapp_messages">): Promise<FetchedMedia> {
  if (!row.media_type) throw new Error("This message carries no file.");
  // The cache leaf must be computable BEFORE the MIME type is known, so
  // nameless media stores under the constant "file"; the user-facing download
  // name is derived from the real MIME type at return time instead.
  const path = whatsappMediaPath(
    row.chat_number,
    row.message_id,
    safeMediaFileName(row.media_filename, "file"),
  );

  const cached = await supabaseAdmin.storage.from(BUCKET).download(path);
  if (!cached.error && cached.data) {
    const buffer = Buffer.from(await cached.data.arrayBuffer());
    const mimeType = cached.data.type || "application/octet-stream";
    return {
      base64: buffer.toString("base64"),
      fileName: displayFileName(row, mimeType),
      mimeType,
    };
  }

  if (!row.media_id) throw new Error("This message carries no file.");
  const providerConfig = await requireEnabledEvolutionConfig();
  const instanceName = await loadEvolutionInstanceName();
  const client = evolutionClientFromConfig(providerConfig.config);
  const payload = (await client.getBase64FromMediaMessage(instanceName, row.media_id)) as {
    base64?: unknown;
    media?: unknown;
    mimetype?: unknown;
  };
  const base64 = payload.base64 ?? payload.media;
  if (typeof base64 !== "string" || !base64) {
    throw new Error("Evolution no longer holds this file — its media store expires old payloads.");
  }
  // Bound the ENCODED length first: decoding is where the memory goes.
  if (base64.length > (MEDIA_MAX_BYTES * 4) / 3 + 4) {
    throw new Error("The file exceeds the 10MB chat media limit.");
  }
  const buffer = Buffer.from(base64, "base64");
  const mimeType =
    typeof payload.mimetype === "string" && payload.mimetype
      ? payload.mimetype
      : "application/octet-stream";

  const upload = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: mimeType, upsert: true });
  if (upload.error) {
    // The tenant's download still succeeds; only the cache write failed.
    console.error("[whatsapp-media] cache write failed", path, upload.error.message);
  }
  return { base64: buffer.toString("base64"), fileName: displayFileName(row, mimeType), mimeType };
}

const downloadSchema = z.object({ messageId: z.string().min(1) });

/**
 * ينزّل ملف رسالة واتساب (للمعاينة أو الحفظ من صندوق الوارد).
 */
export const downloadWhatsAppMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(downloadSchema)
  .handler(async ({ data, context }) => {
    await assertPermission(context, "notifications.read");
    const row = await loadMediaRow(data.messageId);
    return fetchMediaWithCache(row);
  });

const sendMediaSchema = z.object({
  chatNumber: z.string().min(8),
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(3).max(120),
  /** Raw file content, base64-encoded; the schema cap mirrors MEDIA_MAX_BYTES. */
  base64: z
    .string()
    .min(1)
    .max((MEDIA_MAX_BYTES * 4) / 3 + 4),
});

/**
 * يرسل ملفاً (صورة/مستند/فيديو/صوت) من ملحن الدردشة؛ التخزين للتنزيل لاحقاً
 * تتولاه طبقة التسليم.
 */
export const sendWhatsAppChatMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(sendMediaSchema)
  .handler(async ({ data, context }) => {
    await assertPermission(context, "notifications.send");
    const config = await requireEnabledEvolutionConfig();
    const fileName = safeMediaFileName(data.fileName, "attachment.bin");

    const result = await deliverEvolutionNotification({
      body: "",
      config: config.config,
      from: config.from_whatsapp,
      to: data.chatNumber,
      media: [
        {
          base64: data.base64,
          fileName,
          mediatype: mediatypeForMime(data.mimeType),
          mimeType: data.mimeType,
        },
      ],
    });
    return { messageId: result.messageId };
  });

const forwardSchema = z.object({
  messageId: z.string().min(1),
  toChatNumber: z.string().min(8),
});

/**
 * يعيد توجيه رسالة (نص أو ملف) إلى محادثة أخرى.
 */
export const forwardWhatsAppMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(forwardSchema)
  .handler(async ({ data, context }) => {
    await assertPermission(context, "notifications.send");
    const config = await requireEnabledEvolutionConfig();
    const source = await loadMediaRow(data.messageId);

    if (source.media_type && source.media_id) {
      const media = await fetchMediaWithCache(source);
      const result = await deliverEvolutionNotification({
        body: "",
        config: config.config,
        from: config.from_whatsapp,
        to: data.toChatNumber,
        media: [
          {
            base64: media.base64,
            fileName: media.fileName,
            mediatype: mediatypeForMime(media.mimeType),
            mimeType: media.mimeType,
          },
        ],
      });
      return { messageId: result.messageId };
    }

    const body = (source.body ?? "").trim();
    if (!body) throw new Error("This message has no content to forward.");
    const result = await deliverEvolutionNotification({
      body,
      config: config.config,
      from: config.from_whatsapp,
      to: data.toChatNumber,
    });
    return { messageId: result.messageId };
  });
