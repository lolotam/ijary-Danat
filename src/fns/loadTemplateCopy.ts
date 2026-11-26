import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import type { NotificationChannel } from "@/integrations/supabase/database.types";
import type { EmailLocale } from "@/lib/emailTemplates";
import { escapeVariables, renderTemplate } from "@/lib/templateRender";

/**
 * The admin-editable subject and body for one notification template.
 *
 * Generalised from loadCredentialCopy (migration 68), which proved the pattern
 * for the credentials mail. The row is chosen by code and the column is then
 * read for the same locale, so what an admin edits under "Arabic" is exactly
 * what an Arabic recipient gets.
 *
 * Returns nulls when the row is missing or inactive — every caller falls back to
 * its built-in copy, so a deleted or disabled template degrades to the previous
 * email rather than sending nothing.
 *
 * Values are escaped INTO THE BODY only; the surrounding template text is
 * admin-authored and may legitimately contain markup.
 *
 * The subject is rendered from the RAW values, because a subject is not markup.
 * It reaches SMTP/Resend as a plain header (dispatchNotification passes
 * `notification.subject` straight through), and the one place it does enter HTML
 * — wrapLayout's `<title>` and header line — escapes it there. Escaping here too
 * put `&amp;` in the recipient's inbox and `&amp;amp;` in the branded header.
 *
 * `channel` is returned alongside the copy so a sender can decide which rows to
 * create at all. Senders used to read this row for subject and body and then
 * pick channels from whichever contact details the tenant happened to have,
 * which is how an email-only template still queued WhatsApp.
 */
export async function loadTemplateCopy(
  code: string,
  locale: EmailLocale,
  variables: Record<string, string>,
): Promise<{
  subject: string | null;
  body: string | null;
  channel: NotificationChannel | null;
}> {
  const result = await companyClient(requireRequestCompany().id)
    .from("notification_templates")
    .select("subject_ar, subject_en, body_ar, body_en, channel")
    .eq("code", code)
    .eq("is_active", true)
    .maybeSingle();
  if (result.error || !result.data) return { subject: null, body: null, channel: null };

  const safe = escapeVariables(variables);
  const row = result.data;
  return {
    subject: renderTemplate(locale === "ar" ? row.subject_ar : row.subject_en, variables),
    body: renderTemplate(locale === "ar" ? row.body_ar : row.body_en, safe),
    channel: row.channel,
  };
}
