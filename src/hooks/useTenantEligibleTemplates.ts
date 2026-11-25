import { useCronJobs } from "@/hooks/useCronJobs";
import { useNotificationTemplates } from "@/hooks/useNotificationTemplates";
import type {
  NotificationChannel,
  NotificationTemplateRow,
} from "@/integrations/supabase/database.types";
import { isTemplateOfferable } from "@/lib/templateEligibility";

/**
 * يصفي القوالب إلى ما يجوز عرضه للإرسال اليدوي على القناة المطلوبة.
 *
 * Shared by both dialogs so they cannot drift. Channel match is exact-or-both
 * in one direction: a `both` template serves email, but an email-only template
 * does not serve a requested `both`.
 */
export function selectEligibleTemplates(
  templates: NotificationTemplateRow[],
  workflows: ReadonlyArray<{ key: string; recipient_targets: string[] | null }>,
  requestedChannel: NotificationChannel,
): NotificationTemplateRow[] {
  return templates.filter(
    (template) =>
      template.is_active &&
      (template.channel === "both" || template.channel === requestedChannel) &&
      isTemplateOfferable(template.type, workflows),
  );
}

/**
 * يوفّر للقوالب المعروضة للإرسال اليدوي قائمة مصفاة حسب القناة وسير العمل.
 *
 * Thin composition of the two queries plus the pure selector — the dialogs
 * must not re-implement the filter.
 */
export function useTenantEligibleTemplates(channel: NotificationChannel): {
  data: NotificationTemplateRow[];
  isLoading: boolean;
} {
  const templates = useNotificationTemplates();
  const workflows = useCronJobs();
  return {
    data: selectEligibleTemplates(templates.data ?? [], workflows.data ?? [], channel),
    isLoading: Boolean(templates.isLoading || workflows.isLoading),
  };
}
