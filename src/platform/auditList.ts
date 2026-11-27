import { z } from "zod";

import { supabase } from "@/integrations/supabase/client";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { PlatformAuditLogRow } from "@/integrations/supabase/database.types";

import { writePlatformAudit } from "./audit";

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

/**
 * يضيف صف مشرف عام بعد إنشاء حساب GoTrue الخاص به.
 *
 * Only `src/platform/**` may hold `service_role`, so this insert lives here and
 * the bootstrap script calls it. It deliberately does not write `profiles`: a
 * super admin has no company row and therefore reads no company data through
 * RLS (research.md R16).
 */
export async function insertPlatformAdminRow(input: {
  userId: string;
  fullName: string;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("platform_admins").insert({
    user_id: input.userId,
    full_name: input.fullName,
    is_active: true,
  });

  if (error) {
    throw new Error(`Platform admin row insert failed: ${error.message}`);
  }
}

/** مخطط بيانات أول مشرف عامٍ يُنشأ من سطر الأوامر. */
export const platformAdminBootstrapSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(12).max(128),
  fullName: z.string().trim().min(1).max(120),
});

/** بيانات أول مشرف عام كما تُقرأ من سطر الأوامر. */
export type PlatformAdminBootstrapInput = z.input<typeof platformAdminBootstrapSchema>;

/**
 * يرفض البذر إذا كان هناك مشرف عام مسجّل بالفعل.
 *
 * Once an admin exists, the next one must be added through the audited panel:
 * this command is a bootstrap, never a general account-creation API.
 */
async function assertEmptyAdminRoster(): Promise<void> {
  const { data: existing, error } = await supabaseAdmin
    .from("platform_admins")
    .select("user_id")
    .limit(1);
  if (error) {
    throw new Error(`Platform admin roster read failed: ${error.message}`);
  }
  if (existing?.length) {
    throw new Error("PLATFORM_ADMIN_ALREADY_EXISTS");
  }
}

/**
 * ينشئ حساب GoTrue بالبريد الحقيقي، لأن مشرف المنصة لا يملك ملفاً شخصياً يحمله.
 *
 * The company staff helper forces a synthetic auth email; a super admin has no
 * profile row, so its GoTrue email is the address it signs in with.
 */
async function createBootstrapAuthUser(admin: {
  email: string;
  password: string;
  fullName: string;
}): Promise<string> {
  const created = await supabaseAdmin.auth.admin.createUser({
    email: admin.email,
    password: admin.password,
    email_confirm: true,
    user_metadata: { display_name: admin.fullName },
  });
  if (created.error || !created.data.user) {
    throw new Error(
      `Platform admin auth user creation failed: ${created.error?.message ?? "GoTrue returned no user"}`,
    );
  }
  return created.data.user.id;
}

/**
 * يضيف صف المشرف ويحذف حساب GoTrue إذا فشل ذلك، حتى لا يبقى حساب بلا صلاحية.
 */
async function insertRosterRowOrRollback(userId: string, fullName: string): Promise<void> {
  try {
    await insertPlatformAdminRow({ userId, fullName });
  } catch (error) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw error;
  }
}

/**
 * ينشئ أول مشرف عام: حساب GoTrue، ثم صفه في `platform_admins`، ثم سطر تدقيق.
 *
 * Only `src/platform/**` may hold `service_role`, so the bootstrap script calls
 * this helper instead of building its own client. Every write is audited and a
 * partial failure never leaves an auth account that cannot pass
 * `is_platform_admin()`.
 */
export async function bootstrapFirstPlatformAdmin(
  input: PlatformAdminBootstrapInput,
): Promise<{ userId: string; email: string }> {
  const admin = platformAdminBootstrapSchema.parse(input);
  await assertEmptyAdminRoster();

  const userId = await createBootstrapAuthUser(admin);
  await insertRosterRowOrRollback(userId, admin.fullName);

  await writePlatformAudit({
    action: "platform_admin.create",
    entity: "platform_admin",
    entityId: userId,
    actorId: userId,
    after: { email: admin.email, full_name: admin.fullName },
  });

  return { userId, email: admin.email };
}
