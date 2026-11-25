import { createServerFn } from "@tanstack/react-start";
import type MailComposer from "nodemailer/lib/mail-composer";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Json } from "@/integrations/supabase/database.types";
import { requirePermission } from "@/fns/requirePermission";
import {
  describeGmailApiError,
  getGmailAccessToken,
  GMAIL_API,
  grantCanSend,
  readGmailGrant,
} from "@/lib/gmailClient.server";
import { PROVIDER_TIMEOUT_MS } from "@/lib/providers/types";

/**
 * Sending mail from the connected Gmail account — compose, reply and forward.
 *
 * Why the Gmail API rather than the SMTP/Resend provider already wired for
 * notifications: only this path sends *as the mailbox*, threads a reply onto
 * its parent, and leaves a copy in the account's Sent folder. Over SMTP a
 * "reply" would arrive from a different identity with no thread continuity,
 * which is not a reply in any sense the recipient would recognise.
 *
 * MIME assembly is nodemailer's MailComposer, already a dependency. It builds
 * RFC 5322 — multipart bodies, attachments, threading headers, correct
 * encoding of non-ASCII subjects — without opening an SMTP connection. Hand
 * rolling that is where header-injection and broken-Arabic bugs come from.
 *
 * MailComposer is loaded with `await import`, never a static import, and that
 * is load-bearing rather than stylistic. The compiler strips the `.handler`
 * body from the client build and Rollup then tree-shakes whatever it used —
 * which is why `client.server` and `gmailClient.server` above never reach the
 * browser. That only works for ESM. MailComposer is CommonJS, so Rollup cannot
 * prove it side-effect-free and keeps it, and it subclasses Node's
 * `stream.Transform`, which is `undefined` in a browser. A static import
 * therefore put `class extends undefined` at the top of the route chunk and
 * /admin/inbox died before rendering a single row — the whole page, not just
 * the compose dialog. Found 2026-08-13. `src/lib/providers/smtp.ts` loads
 * nodemailer lazily for the same reason.
 */

/**
 * Gmail's own per-message ceiling is 25 MB, and it applies to the *encoded*
 * message. Base64 inflates by about a third, so the raw budget is ~18 MB;
 * rounding down leaves room for headers and the body.
 */
const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

const attachmentSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  /** Base64 (not data-URL): the browser strips the prefix before sending. */
  content: z.string().min(1),
  mimeType: z.string().trim().min(1).max(255),
});

export const gmailSendSchema = z
  .object({
    /**
     * Empty is allowed: a Bcc-only message is exactly what "send to all
     * tenants" produces, and requiring a visible recipient would reject it.
     * The at-least-one rule moved into the refine below, across all three.
     */
    to: z.array(z.string().trim().email()).default([]),
    cc: z.array(z.string().trim().email()).default([]),
    bcc: z.array(z.string().trim().email()).default([]),
    subject: z.string().max(998).default(""),
    body: z.string().default(""),
    /**
     * Rich-text alternative. Sent alongside `body`, never instead of it — a
     * multipart/alternative message is what mail clients expect, and a
     * text-only client handed nothing renders a blank message.
     */
    html: z.string().optional(),
    attachments: z.array(attachmentSchema).default([]),
    /**
     * The `gmail_messages` row being replied to or forwarded. Threading data is
     * read server-side from its stored payload rather than trusted from the
     * client, so a caller cannot forge `In-Reply-To` onto someone else's thread.
     */
    replyToMessageId: z.string().uuid().optional(),
    /** Forwards reuse the compose path but must not thread onto the original. */
    thread: z.boolean().default(true),
  })
  .refine((value) => value.to.length || value.cc.length || value.bcc.length, {
    message: "A message needs at least one recipient.",
    path: ["to"],
  })
  .refine((value) => value.subject.trim() || value.body.trim() || value.html?.trim(), {
    message: "A message needs either a subject or a body.",
    path: ["subject"],
  });

export type GmailSendInput = z.infer<typeof gmailSendSchema>;

/**
 * يحوّل نص HTML إلى نص عادي لعرضه في قائمة المُرسَل.
 *
 * The Sent row stores what a human reads in a list, not what a mail client
 * renders — storing markup there put literal <p> tags in the inbox table.
 * Block-level closers become newlines first so paragraphs do not run together.
 */
export function plainTextFrom(value: string): string {
  return (
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Ampersand last: decoding it first would turn &amp;lt; into a real "<".
      .replace(/&amp;/g, "&")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** Gmail wants the raw MIME base64url-encoded and unpadded. */
function toBase64Url(raw: Buffer): string {
  return raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * يبني رسالة MIME كاملة، مع الإبقاء على ترويسة المستلمين المخفيين.
 *
 * `keepBcc` has to be set explicitly. MailComposer leaves it off, which is the
 * right default for SMTP: there the transport is handed the envelope recipients
 * separately, so emitting the header as well would disclose them to everyone.
 *
 * Gmail's `messages/send` has no envelope. It takes the raw MIME and nothing
 * else, and delivers to whatever the headers name. With the default, the Bcc
 * header was stripped and those recipients were simply never sent to — no
 * error, no bounce, no delivery. Found 2026-08-13; the field had been in the
 * compose dialog, quietly discarding addresses, since it shipped.
 */
export async function buildMime(
  options: ConstructorParameters<typeof MailComposer>[0],
): Promise<Buffer> {
  // Kept lazy on purpose — hoisting this to a static import ships nodemailer to
  // the browser and breaks the whole inbox route. See the note at the top.
  const { default: MailComposer } = await import("nodemailer/lib/mail-composer");
  return new Promise((resolve, reject) => {
    const compiled = new MailComposer(options).compile();
    compiled.keepBcc = true;
    compiled.build((error, message) => {
      if (error) reject(error);
      else resolve(message);
    });
  });
}

export const gmailSend = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => gmailSendSchema.parse(data))
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "notifications.send",
      attempted: "mailbox.send",
      refusal: "You do not have permission to send notifications.",
    });

    const totalBytes = data.attachments.reduce(
      // Base64 length maps back to bytes at 3/4; near enough to reject early
      // with a clear message rather than after a slow failed upload.
      (sum, attachment) => sum + Math.floor((attachment.content.length * 3) / 4),
      0,
    );
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachments total ${(totalBytes / 1024 / 1024).toFixed(1)} MB. Gmail's limit is 25 MB per message once encoded, so keep attachments under 18 MB.`,
      );
    }

    const grant = await readGmailGrant();
    if (!grant) {
      throw new Error(
        "No Gmail account is connected. Connect one in Settings → Integrations first.",
      );
    }
    // Checked before spending a token refresh and an upload on a request Google
    // will refuse anyway — and the message names the fix rather than the fault.
    if (grant.scope !== null && !grantCanSend(grant.scope)) {
      throw new Error(
        "This Gmail connection was authorised for reading only. Open Settings → Integrations, click Disconnect, then Connect Gmail again to allow sending.",
      );
    }

    const { threadId, replyHeaders } = await resolveThreading(data);

    const mime = await buildMime({
      // Gmail overrides From with the authenticated account regardless, so the
      // stored address is used for fidelity rather than control. Sending as an
      // arbitrary address is not possible and should not appear to be.
      from: grant.emailAddress ?? undefined,
      // Guarded like cc/bcc now that a Bcc-only send is valid — an empty array
      // would otherwise emit a bare `To:` header with no address after it.
      to: data.to.length ? data.to : undefined,
      cc: data.cc.length ? data.cc : undefined,
      bcc: data.bcc.length ? data.bcc : undefined,
      subject: data.subject,
      text: data.body || plainTextFrom(data.html ?? ""),
      ...(data.html ? { html: data.html } : {}),
      inReplyTo: replyHeaders?.inReplyTo,
      references: replyHeaders?.references,
      attachments: data.attachments.map((attachment) => ({
        filename: attachment.filename,
        content: Buffer.from(attachment.content, "base64"),
        contentType: attachment.mimeType,
      })),
    });

    const accessToken = await getGmailAccessToken(grant.credentials);
    const response = await fetch(`${GMAIL_API}/${grant.credentials.address}/messages/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        raw: toBase64Url(mime),
        // Gmail threads on its own threadId; the RFC headers above are what
        // every *other* client threads on. Both are needed.
        ...(threadId ? { threadId } : {}),
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(describeGmailApiError(response.status, await response.text()));
    }

    const sent = (await response.json()) as { id?: string; threadId?: string };

    // Local Sent row so the message appears under the Sent sub-tab immediately
    // rather than waiting for the next 10-minute sync tick. Failure here must
    // never fail the send — the mail has already left.
    if (sent.id) {
      try {
        await recordLocalSentMessage({
          gmailId: sent.id,
          threadId: sent.threadId ?? null,
          fromAddress: grant.emailAddress ?? "me",
          to: data.to,
          subject: data.subject,
          body: data.body || plainTextFrom(data.html ?? ""),
        });
      } catch (error) {
        console.error(
          "gmailSend: local sent-row insert failed (send itself succeeded)",
          error instanceof Error ? error.message : error,
        );
      }
    }

    return { id: sent.id ?? null, threadId: sent.threadId ?? null };
  });

/**
 * Inserts a thin local row for a just-sent message.
 *
 * `raw_payload` is thinner than a synced row's (no full labelIds/MIME tree).
 * That is acceptable because `direction` is set explicitly rather than
 * derived — do not assume every row has full labelIds when reading this
 * column.
 *
 * `message_id` is the Gmail API message id from the send response so the
 * sync's `on conflict (company_id, message_id) do nothing` leaves this row
 * alone when the same message later appears in a list tick. (When the
 * synced shape uses an RFC Message-ID key instead, a second row is possible;
 * that is still preferable to a failed send.)
 */
async function recordLocalSentMessage(input: {
  gmailId: string;
  threadId: string | null;
  fromAddress: string;
  to: string[];
  subject: string;
  body: string;
}): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: company, error: companyError } = await supabaseAdmin
    .from("companies")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (companyError) throw new Error(companyError.message);

  const toAddress = input.to.join(", ");
  const now = new Date().toISOString();
  // Thin payload — direction is authoritative; labelIds may be absent.
  const rawPayload = {
    id: input.gmailId,
    threadId: input.threadId ?? undefined,
    snippet: input.body.slice(0, 200) || undefined,
    // Not a full format=full payload; direction is set on the column instead.
    source: "gmailSend",
  } as unknown as Json;

  const { error } = await supabaseAdmin.from("gmail_messages").upsert(
    {
      company_id: company.id,
      // Gmail message id from the send response (brief: Part B.2).
      message_id: input.gmailId,
      thread_id: input.threadId,
      from_address: input.fromAddress,
      to_address: toAddress,
      subject: input.subject || null,
      snippet: input.body.slice(0, 200) || null,
      body_text: input.body || null,
      received_at: now,
      is_read: true,
      direction: "sent",
      raw_payload: rawPayload,
    },
    { onConflict: "company_id,message_id", ignoreDuplicates: true },
  );
  if (error) throw new Error(error.message);
}

/**
 * Threading data, read from the parent's stored payload.
 *
 * Deliberately not taken from the client: `In-Reply-To` decides which
 * conversation a message joins, so accepting it from the browser would let a
 * caller graft mail onto a thread they never received.
 *
 * `buildReplyHeaders` returns null when the parent has no real Message-ID
 * header — the sync worker's `gmail:<id>` fallback is a valid uniqueness key
 * and an invalid RFC header. In that case the reply still sends, just without
 * threading headers, which is strictly better than emitting malformed ones.
 */
async function resolveThreading(data: GmailSendInput) {
  if (!data.replyToMessageId || !data.thread) {
    return { threadId: null as string | null, replyHeaders: null };
  }

  // Imported lazily so the pure parsing module stays out of this file's import
  // graph when nothing is being replied to.
  const [{ supabaseAdmin }, { buildReplyHeaders, extractHeaders }] = await Promise.all([
    import("@/integrations/supabase/client.server"),
    import("@/lib/gmailMessage"),
  ]);

  const { data: parent } = await supabaseAdmin
    .from("gmail_messages")
    .select("thread_id, raw_payload")
    .eq("id", data.replyToMessageId)
    .maybeSingle();
  if (!parent) return { threadId: null as string | null, replyHeaders: null };

  const payload = (parent.raw_payload as { payload?: unknown } | null)?.payload;
  const headers = extractHeaders(payload as never);
  return {
    threadId: parent.thread_id,
    replyHeaders: buildReplyHeaders(headers),
  };
}
