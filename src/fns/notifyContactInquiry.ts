import {
  loadCompanyDefaults,
  notifyAdminEvent,
  renderAdminEmailCopy,
  rowOrThrow,
  type AdminEmailMessage,
  type AdminNotificationResult,
} from "@/fns/adminEmailNotification";
import { translatorFor } from "@/i18n/dictionary";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Tables } from "@/integrations/supabase/database.types";

const WORKFLOW_KEY = "contact-inquiry-received";

/** يبني رسالة طلب التواصل وحمولتها. */
async function buildContactMessage(
  inquiry: Tables<"contact_inquiries">,
): Promise<AdminEmailMessage> {
  const { locale } = await loadCompanyDefaults();
  const t = translatorFor(locale);
  const copy = await renderAdminEmailCopy({
    code: "contact-inquiry",
    locale,
    variables: {
      name: inquiry.name,
      email: inquiry.email,
      phone: inquiry.phone ?? "",
      message: inquiry.message,
    },
    fallbackSubject: t("workflows.fallbackSubject.contactInquiry"),
    fallbackBody: (safe) => `<p>${safe.name} - ${safe.email}</p><p>${safe.message}</p>`,
  });
  return { copy, payload: { inquiry_id: inquiry.id } };
}

/** يرسل تنبيه طلب التواصل إلى الإدارة عبر بوابة سير العمل. */
export async function notifyContactInquiryRecord(
  inquiryId: string,
): Promise<AdminNotificationResult> {
  return notifyAdminEvent(WORKFLOW_KEY, {
    type: "contact_inquiry",
    load: async () =>
      rowOrThrow(
        await supabaseAdmin.from("contact_inquiries").select("*").eq("id", inquiryId).single(),
      ),
    dedupeMatch: { inquiry_id: inquiryId },
    build: buildContactMessage,
  });
}
