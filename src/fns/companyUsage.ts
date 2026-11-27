import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requirePermission } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/database.types";

/** نفس مفتاح `PERMISSIONS.COMPANY_UPDATE` الذي يحرس صفحة الإعدادات. */
const COMPANY_SETTINGS_PERMISSION = "company.update";

/** أدوار الموظفين التي يحسبها مشغّل 323؛ دور `tenant` لا يدخل العدّ. */
const STAFF_ROLES = ["admin", "accountant", "collector", "readonly"] as const;

/** استخدام حدّ واحد: الكمية المستخدمة والسقف، أو `null` للبلا حد. */
export interface LimitUsage {
  used: number;
  limit: number | null;
}

/** استخدام حدود الشركة الأربعة كما تعرضها بطاقة الإعدادات. */
export interface CompanyUsage {
  units: LimitUsage;
  staff: LimitUsage;
  whatsapp: LimitUsage;
  storage: LimitUsage;
}

/**
 * يحسب أول يوم في الشهر بتوقيت الكويت، وهو مفتاح صف الاستهلاك الشهري.
 *
 * The SQL quota RPC uses `Asia/Kuwait` for the same boundary. Deriving it here
 * from the clock keeps the read in step with that counter near midnight.
 */
function kuwaitMonthStart(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuwait",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")!.value;
  const month = parts.find((part) => part.type === "month")!.value;
  return `${year}-${month}-01`;
}

/**
 * يقرأ الجداول الستة للشركة في طلب واحد متوازٍ.
 */
async function readUsageRows(db: SupabaseClient<Database>, companyId: string, month: string) {
  return Promise.all([
    db
      .from("company_limits")
      .select("max_units, max_staff_users, max_whatsapp_per_month, max_storage_bytes")
      .eq("company_id", companyId)
      .maybeSingle(),
    db.from("units").select("id", { count: "exact", head: true }).eq("company_id", companyId),
    db.from("profiles").select("id").eq("company_id", companyId).eq("is_active", true),
    db
      .from("user_roles")
      .select("user_id")
      .eq("company_id", companyId)
      .in("role", [...STAFF_ROLES]),
    db
      .from("company_usage_monthly")
      .select("whatsapp_sent")
      .eq("company_id", companyId)
      .eq("month", month)
      .maybeSingle(),
    db.from("company_storage_usage").select("bytes").eq("company_id", companyId).maybeSingle(),
  ]);
}

/** ما تعيده قراءة الجداول الستة، كما يعرفه النوع دون تكرار تعريفه يدوياً. */
type UsageRows = Awaited<ReturnType<typeof readUsageRows>>;

/**
 * يرفض إرجاع استخدام جزئي إذا فشل أيّ من الجداول الستة.
 */
function assertReadsSucceeded([
  limits,
  units,
  profiles,
  roles,
  whatsapp,
  storage,
]: UsageRows): void {
  if (limits.error) throw new Error(`company_limits lookup failed: ${limits.error.message}`);
  if (units.error) throw new Error(`units count failed: ${units.error.message}`);
  if (profiles.error) throw new Error(`profiles lookup failed: ${profiles.error.message}`);
  if (roles.error) throw new Error(`user_roles lookup failed: ${roles.error.message}`);
  if (whatsapp.error) {
    throw new Error(`company_usage_monthly lookup failed: ${whatsapp.error.message}`);
  }
  if (storage.error)
    throw new Error(`company_storage_usage lookup failed: ${storage.error.message}`);
}

/**
 * يحوّل صفوف قاعدة البيانات إلى أربعة أزواج من الاستهلاك والحد.
 *
 * Migration 323 counts active profiles that hold one of the staff roles. Several
 * roles on one person are still one staff account, so the role ids are a set.
 */
function toCompanyUsage([
  limits,
  units,
  profiles,
  roles,
  whatsapp,
  storage,
]: UsageRows): CompanyUsage {
  const staffIds = new Set((roles.data ?? []).map((role) => role.user_id));
  const staffCount = (profiles.data ?? []).filter((profile) => staffIds.has(profile.id)).length;

  return {
    units: { used: units.count ?? 0, limit: limits.data?.max_units ?? null },
    staff: { used: staffCount, limit: limits.data?.max_staff_users ?? null },
    whatsapp: {
      used: whatsapp.data?.whatsapp_sent ?? 0,
      limit: limits.data?.max_whatsapp_per_month ?? null,
    },
    storage: { used: storage.data?.bytes ?? 0, limit: limits.data?.max_storage_bytes ?? null },
  };
}

/**
 * يقرأ استخدام الشركة الحالي مقابل حدودها الأربعة.
 *
 * Every query runs as `company_service`, so RLS confines all six reads to the
 * company of the request. No write is issued: the quotas themselves are
 * maintained by the database triggers and the WhatsApp RPC.
 */
export const companyUsage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CompanyUsage> => {
    await requirePermission(context, {
      code: COMPANY_SETTINGS_PERMISSION,
      attempted: "company.usage.read",
      refusal: "You do not have permission to view your company's usage.",
    });

    const companyId = requireRequestCompany().id;
    const rows = await readUsageRows(
      companyClient(companyId),
      companyId,
      kuwaitMonthStart(new Date()),
    );
    assertReadsSucceeded(rows);
    return toCompanyUsage(rows);
  });
