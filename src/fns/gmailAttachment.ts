import { createHash } from "node:crypto";

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  describeGmailApiError,
  getGmailAccessToken,
  GMAIL_API,
  readGmailGrant,
} from "@/lib/gmailClient.server";
import { PROVIDER_TIMEOUT_MS } from "@/lib/providers/types";
import { listAttachments } from "@/lib/gmailMessage";
import { requireStaff } from "@/fns/requirePermission";

/**
 * Fetching one attachment's bytes.
 *
 * `format=full` — what the sync worker stores in `raw_payload` — describes
 * attachments but omits their content, so the bytes need a separate call. It
 * runs server-side because the Gmail access token must never reach the browser;
 * the client receives base64 content and builds a Blob from it.
 *
 * الملف يُخزَّن في مخزن gmail-attachments عند أول تنزيل: بعدها يبقى متاحاً
 * حتى لو حُذفت الرسالة من Gmail أو فُصل الصندوق، ولا يكلّف نداء Google آخر.
 */

const BUCKET = "gmail-attachments";

const schema = z.object({
  /** The `gmail_messages` row the attachment belongs to. */
  messageId: z.string().uuid(),
  attachmentId: z.string().min(1),
});

/**
 * يبني مسار المخزن: معرّف الصف + بصمة قصيرة لمعرّف المرفق + اسم الملف.
 *
 * Gmail attachmentIds routinely exceed storage key length limits, so a short
 * hash stands in for them; the row id scopes it, the filename keeps the
 * object recognisable in the bucket.
 */
function cachePath(messageRowId: string, attachmentId: string, filename: string): string {
  const hash = createHash("sha256").update(attachmentId).digest("hex").slice(0, 16);
  const safeName = filename.replace(/[/\\]/g, "_").trim() || "attachment.bin";
  return `message/${messageRowId}/${hash}/${safeName}`;
}

/** Gmail speaks base64url; Buffer speaks base64. Convert without padding fuss. */
function base64UrlToBuffer(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function bufferToBase64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const gmailAttachment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => schema.parse(data))
  .handler(async ({ data, context }) => {
    await requireStaff(context, {
      attempted: "gmail.read_attachment",
      refusal: "You do not have permission to read mailbox attachments.",
    });

    const { data: message } = await supabaseAdmin
      .from("gmail_messages")
      .select("raw_payload")
      .eq("id", data.messageId)
      .maybeSingle();
    if (!message?.raw_payload) throw new Error("Message not found.");

    const raw = message.raw_payload as { id?: string; payload?: unknown };

    /*
     * The requested attachment must be one this message actually declares.
     *
     * Without this, `attachmentId` is an opaque handle passed straight to
     * Google under the mailbox's own credentials — a caller could supply the id
     * of an attachment from any other message in the account and read it. The
     * manifest is already in the payload, so the check costs nothing.
     */
    const declared = listAttachments(raw.payload as never).find(
      (attachment) => attachment.attachmentId === data.attachmentId,
    );
    if (!declared) throw new Error("That attachment does not belong to this message.");

    // Cache first: a hit costs no Gmail call and works even after the message
    // is trashed in Gmail or the mailbox is disconnected.
    const path = cachePath(data.messageId, data.attachmentId, declared.filename);
    const cached = await supabaseAdmin.storage.from(BUCKET).download(path);
    if (!cached.error && cached.data) {
      const buffer = Buffer.from(await cached.data.arrayBuffer());
      return {
        filename: declared.filename,
        mimeType: declared.mimeType,
        data: bufferToBase64Url(buffer),
      };
    }

    const gmailMessageId = raw.id;
    if (!gmailMessageId) throw new Error("This message has no Gmail id to fetch against.");

    const grant = await readGmailGrant();
    if (!grant) throw new Error("No Gmail account is connected.");

    const accessToken = await getGmailAccessToken(grant.credentials);
    const response = await fetch(
      `${GMAIL_API}/${grant.credentials.address}/messages/${gmailMessageId}/attachments/${data.attachmentId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        // An attachment can be 25 MB of base64 and the timer covers the whole
        // body read, so it gets the same headroom SMTP gives a large upload.
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS * 3),
      },
    );
    if (!response.ok) {
      throw new Error(
        describeGmailApiError(response.status, await response.text(), "downloading attachments"),
      );
    }

    const json = (await response.json()) as { data?: string };
    if (!json.data) throw new Error("Gmail returned no content for that attachment.");

    const upload = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, base64UrlToBuffer(json.data), {
        contentType: declared.mimeType || "application/octet-stream",
        upsert: true,
      });
    if (upload.error) {
      // The admin's download still succeeds; only the cache write failed.
      console.error("[gmail-attachment] cache write failed", path, upload.error.message);
    }

    return {
      filename: declared.filename,
      mimeType: declared.mimeType,
      /** base64url, as Gmail returns it; the client normalises before decoding. */
      data: json.data,
    };
  });
