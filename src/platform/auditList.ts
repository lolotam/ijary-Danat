import { z } from "zod";

import { supabase } from "@/integrations/supabase/client";
import type { PlatformAuditLogRow } from "@/integrations/supabase/database.types";

/** حجم الصفحة الافتراضي لشاشة سجل تدقيق المنصة. */
export const PLATFORM_AUDIT_PAGE_SIZE = 25;

/**
 * مخطط استعلام سجل تدقيق المنصة.
 *
 * The action prefix is a literal prefix, never a user-supplied PostgREST filter:
 * only letters, digits, dot, dash and underscore are accepted, so a caller
 * cannot add another operator through the `action` column.
 */
export const auditListSchema = z.object({
  page: z.number().int().min(1).max(1000).default(1),
  pageSize: z.number().int().min(1).max(100).default(PLATFORM_AUDIT_PAGE_SIZE),
  companyId: z.string().uuid().nullable().optional(),
  actionPrefix: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .optional(),
});

/** المدخل المقبول لاستعلام السجل قبل تطبيق القيم الافتراضية. */
export type PlatformAuditQueryInput = z.input<typeof auditListSchema>;

/** نتيجة قراءة صف واحد من سجل تدقيق المنصة. */
export interface PlatformAuditPage {
  rows: PlatformAuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * يقرأ صفاً من سجل تدقيق المنصة مرتباً من الأحدث إلى الأقدم.
 *
 * `is_platform_admin()` on `platform_audit_log` already limits SELECT to an
 * active super admin with an `aal2` claim, so the browser client is enough and
 * no second, service-role read path is needed. `count: exact` is what lets the
 * screen show a real pager instead of guessing whether a next page exists.
 */
export async function listPlatformAudit(
  input: PlatformAuditQueryInput,
): Promise<PlatformAuditPage> {
  const query = auditListSchema.parse(input);
  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  let request = supabase.from("platform_audit_log").select("*", { count: "exact" });
  if (query.companyId) {
    request = request.eq("company_id", query.companyId);
  }
  if (query.actionPrefix) {
    request = request.like("action", `${query.actionPrefix}.%`);
  }

  const { data, error, count } = await request
    .order("created_at", { ascending: false })
    .range(from, to);
  if (error) {
    throw new Error(`Platform audit read failed: ${error.message}`);
  }

  return {
    rows: (data ?? []) as PlatformAuditLogRow[],
    total: count ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}
