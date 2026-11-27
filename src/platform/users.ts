import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { AppRole } from "@/integrations/supabase/database.types";
import { parseServerInput } from "@/lib/parseServerInput";
import { writePlatformAudit } from "@/platform/audit";
import { signOutAuthUser, updateAuthUserById } from "@/platform/authAdmin.server";
import {
  assertCompanyExists,
  COMPANY_NOT_FOUND,
  createPlatformStaffAccount,
  generateTemporaryPassword,
  USER_NOT_FOUND,
} from "@/platform/companyStaffAccount";
import { requirePlatformAdmin } from "@/platform/requirePlatformAdmin.server";

/**
 * عمليات سوبر الأدمن على حسابات الشركات: إنشاء موظف، تفعيله وإيقافه، وتغيير
 * كلمة مروره.
 *
 * The shared vocabulary — the refusal codes, the company lookup and the
 * account creation routine — lives in `companyStaffAccount.ts`, because the
 * first administrator of a new company is created by exactly the routine that
 * creates any other staff account.
 */

/**
 * الأدوار التي يمنحها مشرف المنصة.
 *
 * The renter role is not here: a renter account is bound to a tenant record
 * (`profiles.tenant_id`), and a tenant is the company's own business — the
 * company panel creates it.
 */
const STAFF_ROLES = ["admin", "accountant", "collector", "readonly"] as const;

/** دور موظف داخل الشركة، كما يمنحه مشرف المنصة. */
export type PlatformStaffRole = (typeof STAFF_ROLES)[number];

/** الحد الأقصى لعدد الحسابات في صفحة واحدة. */
const MAX_PAGE_SIZE = 200;

/** حجم الصفحة الافتراضي. */
const DEFAULT_PAGE_SIZE = 50;

/** صف حساب كما تعرضه لوحة المنصة. */
export interface PlatformUserSummary {
  id: string;
  displayName: string | null;
  username: string | null;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  roles: AppRole[];
  createdAt: string;
}

const createUserSchema = z.object({
  companyId: z.string().uuid(),
  fullName: z.string().trim().min(1).max(120),
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/)
    .optional()
    .nullable(),
  email: z.string().trim().email().max(320).optional().nullable(),
  phone: z.string().trim().max(32).optional().nullable(),
  role: z.enum(STAFF_ROLES),
});

/**
 * ينشئ حساب موظف داخل شركة معيّنة، ويعيد معرّفه وكلمة المرور المؤقتة.
 *
 * The temporary password is returned once and never written anywhere: not to
 * a profile row, not to the platform audit payload, not to a log line. The
 * account is flagged `must_change_password`, so the password is spent at the
 * first sign-in.
 */
export async function platformCreateUser(input: {
  companyId: string;
  fullName: string;
  username?: string | null;
  email?: string | null;
  phone?: string | null;
  role: PlatformStaffRole;
}): Promise<{ userId: string; tempPassword: string }> {
  const admin = await requirePlatformAdmin();
  const staff = parseServerInput(createUserSchema, input);

  await assertCompanyExists(staff.companyId);

  const account = await createPlatformStaffAccount({
    grantedBy: admin.userId,
    companyId: staff.companyId,
    fullName: staff.fullName,
    username: staff.username,
    email: staff.email,
    phone: staff.phone,
    role: staff.role,
  });

  await writePlatformAudit({
    action: "user.create",
    entity: "user",
    entityId: account.userId,
    companyId: staff.companyId,
    actorId: admin.userId,
    before: null,
    after: {
      role: staff.role,
      username: staff.username ?? null,
      email: staff.email ?? null,
    },
  });

  return account;
}

const listUsersSchema = z.object({
  companyId: z.string().uuid(),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  offset: z.number().int().min(0).optional(),
});

/**
 * يسرد حسابات شركة معيّنة، بترتيب الأحدث أولاً.
 *
 * The roles come from a second query rather than an embedded select: the
 * embedded form needs the relationship declared in the generated types, and a
 * plain join keeps the shape of the result under this file's control.
 */
export async function platformListUsers(input: {
  companyId: string;
  limit?: number;
  offset?: number;
}): Promise<{ rows: PlatformUserSummary[]; count: number }> {
  await requirePlatformAdmin();
  const listing = parseServerInput(listUsersSchema, input);

  await assertCompanyExists(listing.companyId);

  const {
    data: profiles,
    error,
    count,
  } = await supabaseAdmin
    .from("profiles")
    .select(
      "id, display_name, username, email, phone, is_active, must_change_password, created_at",
      {
        count: "exact",
      },
    )
    .eq("company_id", listing.companyId)
    .order("created_at", { ascending: false })
    .range(listing.offset ?? 0, (listing.offset ?? 0) + (listing.limit ?? DEFAULT_PAGE_SIZE) - 1);

  if (error) {
    throw new Error(`profiles lookup failed: ${error.message}`);
  }

  const rows = profiles ?? [];
  const rolesByUser = await loadRolesByUser(
    listing.companyId,
    rows.map((row) => row.id),
  );

  return {
    rows: rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      username: row.username,
      email: row.email,
      phone: row.phone,
      isActive: row.is_active,
      mustChangePassword: row.must_change_password,
      roles: rolesByUser.get(row.id) ?? [],
      createdAt: row.created_at,
    })),
    count: count ?? rows.length,
  };
}

/**
 * يقرأ أدوار كل حساب في الصفحة، مجمّعةً حسب المستخدم.
 */
async function loadRolesByUser(
  companyId: string,
  userIds: string[],
): Promise<Map<string, AppRole[]>> {
  const rolesByUser = new Map<string, AppRole[]>();
  if (userIds.length === 0) {
    return rolesByUser;
  }

  const { data: roleRows, error } = await supabaseAdmin
    .from("user_roles")
    .select("user_id, role")
    .eq("company_id", companyId)
    .in("user_id", userIds);

  if (error) {
    throw new Error(`user_roles lookup failed: ${error.message}`);
  }

  for (const roleRow of roleRows ?? []) {
    const roles = rolesByUser.get(roleRow.user_id) ?? [];
    roles.push(roleRow.role);
    rolesByUser.set(roleRow.user_id, roles);
  }
  return rolesByUser;
}

/**
 * يوقف حساب مستخدم داخل شركة: حظرٌ في GoTrue، ثم إبطال الجلسات، ثم مسح العلامة.
 *
 * The ban comes first because it is the only step that stops new tokens; the
 * sessions are revoked next so a person cannot keep working on the session
 * they hold; the profile flag comes last, and the ban is lifted again when
 * that write fails — the account never reads "inactive" while its tokens
 * still work, the hole the company panel's own `setUserActive` documents.
 */
async function deactivateAccount(userId: string, companyId: string): Promise<void> {
  const banned = await updateAuthUserById(userId, { ban_duration: "876000h" });
  if (banned.error) {
    throw new Error(`failed to ban the account: ${banned.error.message}`);
  }

  const revoked = await signOutAuthUser(userId);
  if (revoked.error) {
    const unbanned = await updateAuthUserById(userId, { ban_duration: "none" });
    throw new Error(
      unbanned.error
        ? `session revoke failed (${revoked.error.message}) and the ban could not be lifted (${unbanned.error.message}); the account is still banned — retry the operation`
        : `session revoke failed: ${revoked.error.message}`,
    );
  }

  const updated = await supabaseAdmin
    .from("profiles")
    .update({ is_active: false })
    .eq("id", userId)
    .eq("company_id", companyId);

  if (updated.error) {
    const unbanned = await updateAuthUserById(userId, { ban_duration: "none" });
    throw new Error(
      unbanned.error
        ? `profile write failed (${updated.error.message}) and lifting the ban afterwards failed too (${unbanned.error.message}); the account is still banned — retry the operation`
        : `profile write failed: ${updated.error.message}`,
    );
  }
}

/**
 * يعيد تفعيل حساب: رفع الحظر ثم رفع العلامة.
 *
 * The ban is lifted first and the flag written second, and a failed flag
 * write puts the ban back — the account is never open while it is still
 * flagged as inactive.
 */
async function activateAccount(userId: string, companyId: string): Promise<void> {
  const unbanned = await updateAuthUserById(userId, { ban_duration: "none" });
  if (unbanned.error) {
    throw new Error(`failed to lift the ban on the account: ${unbanned.error.message}`);
  }

  const updated = await supabaseAdmin
    .from("profiles")
    .update({ is_active: true })
    .eq("id", userId)
    .eq("company_id", companyId);

  if (updated.error) {
    const rebanned = await updateAuthUserById(userId, { ban_duration: "876000h" });
    throw new Error(
      rebanned.error
        ? `profile write failed (${updated.error.message}) and the ban could not be put back (${rebanned.error.message}); the account is still banned — retry the operation`
        : `profile write failed: ${updated.error.message}`,
    );
  }
}

const setUserActiveSchema = z.object({
  companyId: z.string().uuid(),
  userId: z.string().uuid(),
  isActive: z.boolean(),
});

/**
 * يوقف حساب مستخدم داخل شركة أو يعيد تفعيله.
 *
 * Both directions touch GoTrue and Postgres, which are separate stores, so
 * each one orders its writes so that a failure leaves the account in the
 * state it started in rather than halfway between the two.
 */
export async function platformSetUserActive(input: {
  companyId: string;
  userId: string;
  isActive: boolean;
}): Promise<{ userId: string; isActive: boolean }> {
  const admin = await requirePlatformAdmin();
  const change = parseServerInput(setUserActiveSchema, input);

  const { data: profile, error: lookupError } = await supabaseAdmin
    .from("profiles")
    .select("id, is_active")
    .eq("id", change.userId)
    .eq("company_id", change.companyId)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`profiles lookup failed: ${lookupError.message}`);
  }
  if (!profile) {
    throw new Error(USER_NOT_FOUND);
  }

  if (change.isActive) {
    await activateAccount(change.userId, change.companyId);
  } else {
    await deactivateAccount(change.userId, change.companyId);
  }

  await writePlatformAudit({
    action: "user.status.update",
    entity: "user",
    entityId: change.userId,
    companyId: change.companyId,
    actorId: admin.userId,
    before: { is_active: profile.is_active },
    after: { is_active: change.isActive },
  });

  return { userId: change.userId, isActive: change.isActive };
}

const resetPasswordSchema = z.object({
  companyId: z.string().uuid(),
  userId: z.string().uuid(),
});

/**
 * يغيّر كلمة مرور حساب داخل شركة إلى كلمة مؤقتة ويجبره على تغييرها.
 *
 * The sessions are revoked first — a password change does not invalidate the
 * tokens GoTrue has already handed out, and the person must not keep working
 * on the old session. The forced-change flag is written before the password,
 * so a failed password change leaves an account that still signs in with its
 * old password and is asked to change it, never an account whose password
 * nobody knows.
 */
export async function platformResetPassword(input: {
  companyId: string;
  userId: string;
}): Promise<{ userId: string; tempPassword: string }> {
  const admin = await requirePlatformAdmin();
  const reset = parseServerInput(resetPasswordSchema, input);

  const { data: profile, error: lookupError } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("id", reset.userId)
    .eq("company_id", reset.companyId)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`profiles lookup failed: ${lookupError.message}`);
  }
  if (!profile) {
    throw new Error(USER_NOT_FOUND);
  }

  const revoked = await signOutAuthUser(reset.userId);
  if (revoked.error) {
    throw new Error(`session revoke failed: ${revoked.error.message}`);
  }

  const flagged = await supabaseAdmin
    .from("profiles")
    .update({ must_change_password: true })
    .eq("id", reset.userId)
    .eq("company_id", reset.companyId);

  if (flagged.error) {
    throw new Error(`must_change_password write failed: ${flagged.error.message}`);
  }

  const tempPassword = generateTemporaryPassword();
  const updated = await updateAuthUserById(reset.userId, { password: tempPassword });
  if (updated.error) {
    throw new Error(`password update failed: ${updated.error.message}`);
  }

  await writePlatformAudit({
    action: "user.password_reset",
    entity: "user",
    entityId: reset.userId,
    companyId: reset.companyId,
    actorId: admin.userId,
    before: null,
    after: { must_change_password: true },
  });

  return { userId: reset.userId, tempPassword };
}
