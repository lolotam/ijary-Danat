import { randomBytes } from "node:crypto";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isEmailConflict, isUsernameConflict } from "@/lib/userConflicts.server";
import { createAuthUser, deleteAuthUser } from "@/platform/authAdmin.server";

/**
 * مفردات الحساب داخل الشركة المشتركة بين عمليات المنصة: أكواد الرفض، وقراءة
 * الشركة، وقاعدة إنشاء حساب الموظف.
 *
 * Account creation lives here and not in `users.ts` because the first
 * administrator of a new company is created by exactly the routine that
 * creates any other staff account — same GoTrue account, same profile row,
 * same forced password change, same rollback.
 */

/** رفض: الشركة المطلوبة غير موجودة. */
export const COMPANY_NOT_FOUND = "COMPANY_NOT_FOUND";

/** رفض: الحساب المطلوب غير موجود داخل الشركة المعطاة. */
export const USER_NOT_FOUND = "USER_NOT_FOUND";

/** رفض: اسم المستخدم محجوز لحساب آخر داخل الشركة نفسها. */
export const USERNAME_TAKEN = "USERNAME_TAKEN";

/** رفض: البريد الإلكتروني محجوز لحساب آخر داخل الشركة نفسها. */
export const EMAIL_TAKEN = "EMAIL_TAKEN";

/** بيانات حساب موظف داخل شركة. */
export interface PlatformStaffAccount {
  /** معرّف مشرف المنصة الذي ينشئ الحساب؛ يُكتب في `user_roles.granted_by`. */
  grantedBy: string;
  /** الشركة التي ينتمي إليها الحساب. */
  companyId: string;
  /** الاسم المعروض في لوحة الشركة. */
  fullName: string;
  /** اسم المستخدم داخل الشركة (اختياري). */
  username?: string | null;
  /** البريد الحقيقي للشخص (اختياري). */
  email?: string | null;
  /** رقم الهاتف (اختياري). */
  phone?: string | null;
  /** الدور داخل الشركة. */
  role: "admin" | "accountant" | "collector" | "readonly";
}

/**
 * يولّد كلمة مرور مؤقتة تُعاد مرة واحدة إلى مشرف المنصة.
 *
 * The plaintext never reaches a database row, an audit payload or a log — it
 * exists only in the response that carries it to the super admin, who hands
 * it over out of band.
 */
export function generateTemporaryPassword(): string {
  return randomBytes(12).toString("base64url");
}

/**
 * يتأكد أن الشركة موجودة قبل أي كتابة عليها.
 */
export async function assertCompanyExists(companyId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("companies")
    .select("id")
    .eq("id", companyId)
    .maybeSingle();

  if (error) {
    throw new Error(`company lookup failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(COMPANY_NOT_FOUND);
  }
}

/**
 * يتأكد أن اسم المستخدم غير محجوز داخل الشركة.
 *
 * The name is unique per company (migration 255), never globally, so a person
 * may hold the same name in two companies. `citext` makes the comparison
 * case-insensitive, the same way the unique index is.
 */
async function assertUsernameAvailable(
  companyId: string,
  username: string | null | undefined,
): Promise<void> {
  if (!username) {
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("company_id", companyId)
    .eq("username", username)
    .limit(1);

  if (error) {
    throw new Error(`profiles username lookup failed: ${error.message}`);
  }
  if (data?.length) {
    throw new Error(USERNAME_TAKEN);
  }
}

/**
 * يتأكد أن البريد الإلكتروني غير محجوز داخل الشركة.
 *
 * The address is unique per company as well, and it lives in `profiles` — the
 * GoTrue login is the synthetic address, which is unique by construction.
 */
async function assertEmailAvailable(
  companyId: string,
  email: string | null | undefined,
): Promise<void> {
  if (!email) {
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("company_id", companyId)
    .eq("email", email)
    .limit(1);

  if (error) {
    throw new Error(`profiles email lookup failed: ${error.message}`);
  }
  if (data?.length) {
    throw new Error(EMAIL_TAKEN);
  }
}

/**
 * ينشئ حساب موظف داخل شركة: مستخدم GoTrue، ثم ملف شخصي، ثم دور.
 *
 * The three writes are not one transaction — GoTrue and Postgres are separate
 * stores — so they are ordered so that any partial failure lands on "no
 * account", never on "an account nobody can use": the GoTrue user is deleted
 * when the profile or the role cannot be written, and deleting it cascades to
 * both rows.
 *
 * The account is created with `must_change_password`, so the temporary
 * password is worthless after the first sign-in.
 */
export async function createPlatformStaffAccount(
  account: PlatformStaffAccount,
): Promise<{ userId: string; tempPassword: string }> {
  await assertUsernameAvailable(account.companyId, account.username);
  await assertEmailAvailable(account.companyId, account.email);

  const tempPassword = generateTemporaryPassword();

  const created = await createAuthUser({
    email: account.email ?? undefined,
    password: tempPassword,
    user_metadata: {
      username: account.username ?? undefined,
      display_name: account.fullName,
    },
  });

  if (created.error || !created.data.user) {
    throw new Error(
      `auth user creation failed: ${created.error?.message ?? "GoTrue returned no user"}`,
    );
  }
  const userId = created.data.user.id;

  const profile = await supabaseAdmin
    .from("profiles")
    .upsert({
      id: userId,
      company_id: account.companyId,
      username: account.username ?? null,
      display_name: account.fullName,
      email: account.email ?? null,
      phone: account.phone ?? null,
      is_active: true,
      must_change_password: true,
    })
    .select("id")
    .single();

  if (profile.error) {
    await deleteAuthUser(userId);
    if (isUsernameConflict(profile.error)) {
      throw new Error(USERNAME_TAKEN);
    }
    if (isEmailConflict(profile.error)) {
      throw new Error(EMAIL_TAKEN);
    }
    throw new Error(`profile insert failed: ${profile.error.message}`);
  }

  const role = await supabaseAdmin.from("user_roles").insert({
    company_id: account.companyId,
    user_id: userId,
    role: account.role,
    granted_by: account.grantedBy,
  });

  if (role.error) {
    await deleteAuthUser(userId);
    throw new Error(`user_roles insert failed: ${role.error.message}`);
  }

  return { userId, tempPassword };
}
