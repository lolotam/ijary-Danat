import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** ما تعيده دالة الحذف التلقائي لكل سجل: المدة المطبقة وعدد الصفوف المحذوفة. */
export type LogRetentionOutcome = {
  audit: { days: number | null; deleted: number };
  notifications: { days: number | null; deleted: number };
};

/**
 * يشغّل الحذف التلقائي اليومي لسجلي التدقيق والإشعارات حسب المدة المحفوظة.
 *
 * The windows live on `companies` and the deletion in `purge_expired_logs`
 * (migration 242), so the policy is enforced in one place whether it runs from
 * here or from the admin's "apply now" in `set_log_retention`. Idempotent: a
 * repeated tick finds nothing past the cutoff.
 *
 * `asOf` is ignored: retention is always relative to now, and replaying it for
 * a past date would delete rows the chosen window still promises to keep.
 */
export async function runLogRetentionJob(
  _asOfIgnored?: string | null,
): Promise<LogRetentionOutcome> {
  const { data, error } = await supabaseAdmin.rpc("purge_expired_logs");
  if (error) throw new Error(`Log retention failed: ${error.message}`);
  return data as LogRetentionOutcome;
}
