import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { plainTextFrom } from "@/fns/gmailSend";
import { brandNameFor, emailLogoFor } from "@/fns/publicBranding";
import { readPublicBranding } from "@/fns/publicBranding.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { applyEmailLogo } from "@/lib/emailLogo";
import type { Json } from "@/integrations/supabase/database.types";
import { sendWithResend } from "@/lib/providers/resend";
import { recordSentResendMessage } from "@/lib/recordSentResendMessage";
import { requirePermission } from "@/fns/requirePermission";

/** رمز قائمة الخيارات التي تحمل عناوين الإرسال المسموح بها عبر Resend. */
export const RESEND_SENDER_LIST_CODE = "resend_senders";

/**
 * بادئة معرّف الرسالة لصفوف Resend، على غرار `gmail:` للرسائل بلا ترويسة.
 *
 * Module-private: nothing outside this file writes a Resend row, and an export
 * without a consumer is a promise the codebase has not been asked to keep.
 */

const attachmentSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  /** Base64, not a data URL — the browser strips the prefix before sending. */
  content: z.string().min(1),
  mimeType: z.string().trim().min(1).max(255),
});

/**
 * مخطّط الإرسال عبر Resend، مطابق لمخطّط Gmail عدا حقل المرسِل.
 *
 * Exported so tests can exercise it directly: the `createServerFn` test double
 * skips `.validator()`, so a schema asserted only through the handler is never
 * actually run.
 */
export const resendMailboxSendSchema = z
  .object({
    /** Must be one of the addresses in the `resend_senders` catalogue. */
    from: z.string().trim().email(),
    to: z.array(z.string().trim().email()).default([]),
    cc: z.array(z.string().trim().email()).default([]),
    bcc: z.array(z.string().trim().email()).default([]),
    subject: z.string().max(998).default(""),
    /** Plain-text body. */
    body: z.string().default(""),
    /** Rich-text alternative, sent alongside `body` and never instead of it. */
    html: z.string().optional(),
    attachments: z.array(attachmentSchema).default([]),
  })
  // Bcc-only is legitimate — it is exactly what "send to all tenants" produces.
  .refine((value) => value.to.length || value.cc.length || value.bcc.length, {
    message: "A message needs at least one recipient.",
    path: ["to"],
  })
  .refine((value) => value.subject.trim() || value.body.trim() || value.html?.trim(), {
    message: "A message needs either a subject or a body.",
    path: ["subject"],
  });

export type ResendMailboxSendInput = z.infer<typeof resendMailboxSendSchema>;

/**
 * يقرأ عناوين الإرسال المسموح بها من قائمة الخيارات.
 *
 * Read server-side on every send rather than trusted from the request. The
 * dropdown already restricts the choice, but a dropdown is a convenience for
 * the honest caller — anyone can POST this endpoint with any `from`, and
 * without this check the app would happily send as an address the admins never
 * approved, on a domain they may not even own.
 */
async function allowedSenders(): Promise<string[]> {
  const db = companyClient(requireRequestCompany().id);
  const list = await db
    .from("option_lists")
    .select("id")
    .eq("code", RESEND_SENDER_LIST_CODE)
    .maybeSingle();
  if (list.error) throw new Error(list.error.message);
  if (!list.data) return [];

  const items = await db
    .from("option_list_items")
    .select("value")
    .eq("list_id", list.data.id)
    .eq("is_active", true);
  if (items.error) throw new Error(items.error.message);
  return (items.data ?? []).map((row) => row.value.trim().toLowerCase());
}

/**
 * يقرأ إعداد مزوّد Resend المفعَّل.
 *
 * The config holds the *name* of the environment variable that carries the key,
 * never the key itself — `sendWithResend` resolves it. Requiring the provider to
 * be enabled keeps one switch in charge: an admin who turns Resend off in
 * Settings has turned it off here too.
 */
async function resendProviderConfig(): Promise<Json> {
  const db = companyClient(requireRequestCompany().id);
  const { data, error } = await db
    .from("provider_configs")
    .select("config, is_enabled")
    .eq("provider", "resend")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Resend is not configured as a provider.");
  if (!data.is_enabled) throw new Error("Resend is not enabled. Enable it in Settings first.");
  return data.config;
}

/**
 * يرسل رسالة من صندوق البريد عبر Resend ويحفظها في مجلد المُرسَل.
 *
 * Separate from `gmailSend` rather than a branch inside it. The two share only
 * their input shape: Gmail sends as the authenticated account and threads
 * replies from stored headers, while Resend sends as any address on a verified
 * domain and has no thread to join. A single function would carry two sets of
 * preconditions and a mode flag, and the Gmail path — which handles real
 * threading — would have to be re-tested for a change that never touches it.
 */
export const resendMailboxSend = createServerFn({ method: "POST" })
  .validator((input: unknown) => resendMailboxSendSchema.parse(input))
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    // The same gate `gmailSend` applies. Without it any authenticated
    // account — a tenant with a portal login included — could POST here and
    // send mail as ceo@danat-future.com, because everything below runs with the
    // service role and the approved-sender list is not a permission.
    //
    // `throw new Error`, not `throw new Response(403)`: a thrown Response is
    // delivered raw and RESOLVES client-side, so the caller would read a refusal
    // as a successful send.
    await requirePermission(context, {
      code: "notifications.send",
      attempted: "mailbox.send",
      refusal: "You do not have permission to send mail.",
    });

    const from = data.from.trim();
    const senders = await allowedSenders();
    if (!senders.includes(from.toLowerCase())) {
      throw new Error(`${from} is not an approved Resend sender address.`);
    }

    const config = await resendProviderConfig();
    const text = data.body || plainTextFrom(data.html ?? "");
    // A composed body that never went through `wrapLayout` carries no marker and
    // this is a no-op, which is correct rather than a gap: only the branded
    // shell has a place to put a logo.
    const branding = await readPublicBranding();
    // Arabic because a composed message has no locale of its own and Arabic is
    // the product's primary language. It reaches the reader as the company name
    // in the branded header, and as the logo's `alt` text when the image is
    // blocked.
    const html = applyEmailLogo(
      data.html?.trim() ? data.html : text,
      emailLogoFor(branding),
      brandNameFor(branding, "ar"),
    );

    const result = await sendWithResend({
      attachments: data.attachments.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.mimeType,
      })),
      bcc: data.bcc,
      // `html` is the rendered body; `body` is its plain-text alternative.
      // Falling back to the text keeps a message with no rich content sendable.
      body: html,
      cc: data.cc,
      config,
      from,
      subject: data.subject,
      text,
      to: data.to,
    });

    // The mail has already left. A failure to archive it locally must not be
    // reported as a failed send: the compose window would stay open showing an
    // error, and the obvious retry would deliver the message a second time.
    // Logged, not swallowed — the row is recoverable, a duplicate send is not.
    try {
      await recordSentResendMessage({
        bcc: data.bcc,
        // The plain-text alternative, not the HTML — and deliberately so. This
        // lands in `body_text`, whose first 200 characters become the snippet
        // the mailbox list renders; storing the document would make every row
        // read `<!doctype html><html lang=…`. It is not a different message:
        // `text` is what was sent alongside the HTML in the same request.
        body: text,
        cc: data.cc,
        from,
        resendId: result.messageId,
        source: "resendMailboxSend",
        subject: data.subject,
        to: data.to,
      });
    } catch (error) {
      console.error(
        "resendMailboxSend: local sent-row insert failed (send itself succeeded)",
        error,
      );
    }

    return { id: result.messageId };
  });
