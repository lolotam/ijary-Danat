import { CompanyContextError } from "@/company/errors";
import { supabase } from "@/integrations/supabase/client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * يحسم معرّف الشركة الحالية في المتصفح من بيانات الجلسة أو من جدول الشركات المحمي بـ RLS.
 *
 * Avoids any `limit(1)` oldest-company fallback; RLS on `companies` already
 * restricts rows to `id = current_company_id()`.
 */
export async function resolveBrowserCompanyId(): Promise<string> {
  const { data: sessionData } = await supabase.auth.getSession();
  const metaCompanyId = sessionData.session?.user?.app_metadata?.company_id;
  if (typeof metaCompanyId === "string" && UUID_PATTERN.test(metaCompanyId)) {
    return metaCompanyId;
  }

  const { data, error } = await supabase.from("companies").select("id").maybeSingle();
  if (error) throw error;
  if (!data?.id) {
    throw new CompanyContextError("COMPANY_REQUIRED");
  }
  return data.id;
}

/**
 * يعيد معرّف الشركة الصالح للرفع في المتصفح، سواء مُرِّر صراحة أو حُسم من الجلسة الحالية.
 */
export async function resolveUploadCompanyId(explicitCompanyId?: string | null): Promise<string> {
  if (typeof explicitCompanyId === "string" && UUID_PATTERN.test(explicitCompanyId)) {
    return explicitCompanyId;
  }
  return resolveBrowserCompanyId();
}
