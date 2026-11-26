import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import type { NotificationChannel } from "@/integrations/supabase/database.types";

/**
 * يقرر ما إذا كانت قناة القالب تسمح بإنشاء إشعار على القناة المطلوبة.
 *
 * A null `templateChannel` means no active template row was found, and that
 * deliberately imposes NO restriction: `loadTemplateCopy` already degrades a
 * missing or deactivated template to the built-in copy rather than to silence,
 * and failing closed here would turn a deleted template row into a money-path
 * outage instead of a cosmetic one.
 */
export function templateAllowsChannel(
  templateChannel: NotificationChannel | null | undefined,
  requested: NotificationChannel,
): boolean {
  if (!templateChannel) return true;
  if (requested === "both") return templateChannel === "both";
  return templateChannel === "both" || templateChannel === requested;
}

/**
 * يقرأ قناة القالب — حتى لو كان معطّلاً — دون تحميل أو تصيير النص.
 *
 * Separate from `loadTemplateCopy` because the central gate in
 * `enqueueNotification` needs only the policy: rendering subject and body there
 * would escape and interpolate variables the caller has already rendered.
 *
 * Deliberately does NOT filter on `is_active`, unlike `loadTemplateCopy`. Copy
 * and channel degrade in opposite directions: an inactive template should fall
 * back to the built-in *wording*, but its channel is still the last thing the
 * admin chose, and honouring it costs nothing. Filtering here would mean that
 * unchecking "active" silently re-armed the original defect — an email-only
 * template would start queueing WhatsApp again.
 *
 * A query error returns null — the same "no restriction" path as a missing row.
 * A transient database fault must not silently suppress a notification.
 */
export async function loadTemplateChannel(code: string): Promise<NotificationChannel | null> {
  const result = await companyClient(requireRequestCompany().id)
    .from("notification_templates")
    .select("channel")
    .eq("code", code)
    .maybeSingle();
  if (result.error || !result.data) return null;
  return result.data.channel;
}
