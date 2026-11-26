import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";

/** ما تعيده دالة الحذف التلقائي لكل سجل: المدة المطبقة وعدد الصفوف المحذوفة. */
export type LogRetentionOutcome = {
  audit: { days: number | null; deleted: number };
  notifications: { days: number | null; deleted: number };
};

/**
 * يشغّل الحذف التلقائي اليومي لسجلي التدقيق والإشعارات للشركة الحالية حسب المدة المحفوظة.
 */
export async function runLogRetentionJob(
  _asOfIgnored?: string | null,
  companyId?: string,
): Promise<LogRetentionOutcome> {
  const db = companyClient(companyId ?? requireRequestCompany().id);
  const { data, error } = await db.rpc("purge_expired_logs");
  if (error) throw new Error(`Log retention failed: ${error.message}`);
  return data as LogRetentionOutcome;
}
