import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { writePlatformAudit } from "./audit";

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
