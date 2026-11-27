import type { AuthError } from "@supabase/supabase-js";

import { serverCompanyClient } from "@/company/companyClient.server";
import { userConflictMessage } from "@/lib/userConflicts";

/**
 * يتعرّف على رفض قاعدة البيانات لاسم مستخدم محجوز لحساب آخر داخل الشركة.
 *
 * The race fallback for {@link assertUsernameAvailable}: two admins saving the
 * same name at once both pass the pre-check, and the per-company unique
 * constraint (`profiles_company_username_key`, migration 255) refuses the second
 * write. Matched by constraint name so another unique violation on `profiles`
 * (a tenant's second portal account, a duplicate email) keeps its own message.
 * The pre-255 global name is still matched for the same reason.
 */
export function isUsernameConflict(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (error?.code !== "23505") return false;
  return Boolean(
    error.message?.includes("profiles_company_username_key") ||
    error.message?.includes("profiles_username_key"),
  );
}

/**
 * يتعرّف على رفض قاعدة البيانات لبريد إلكتروني محجوز لحساب آخر داخل الشركة.
 *
 * Real addresses are unique per company (`profiles_company_email_lower_idx`,
 * migration 255) because they live in `profiles`, not in GoTrue — the synthetic
 * auth email (R3) can never collide. So the profile write, not the auth call,
 * is what refuses a duplicate, and it needs its own name match to be explained
 * rather than surfaced as a raw constraint.
 */
export function isEmailConflict(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  return (
    error?.code === "23505" && Boolean(error.message?.includes("profiles_company_email_lower_idx"))
  );
}

/**
 * يبني خطأ «اسم المستخدم محجوز» مع اسم صاحبه إن كان معروفاً.
 *
 * Names the owner so the admin can tell a genuine clash (another person) from
 * a stale portal account worth deleting — the raw Postgres text said neither.
 */
export function usernameTakenError(username: string, owner?: string | null): Error {
  const english = owner
    ? `The username "${username}" is already used by "${owner}". Choose a different username.`
    : `The username "${username}" is already in use. Choose a different username.`;
  return new Error(userConflictMessage({ kind: "username", value: username, owner }, english));
}

/**
 * يتحقق من أن اسم المستخدم غير محجوز لحساب آخر قبل أي كتابة.
 *
 * Must run before the auth user is created or updated. The `handle_new_user`
 * trigger quietly suffixes a clashing name, so `auth.admin.createUser`
 * succeeds; the clash only surfaces when the profile is then written with the
 * name as typed — after the auth side already exists (create rolls it back,
 * update had already changed the email and password). `profiles.username` is
 * citext, so `eq` is case-insensitive, matching the unique constraint.
 *
 * `excludeProfileId` is the account being edited: the edit dialog re-sends an
 * unchanged username, which must not count as a clash with itself.
 */
export async function assertUsernameAvailable(
  username: string,
  excludeProfileId: string | null,
  explicitCompanyId?: string,
): Promise<void> {
  const { companyId, client } = serverCompanyClient(explicitCompanyId);
  let query = client
    .from("profiles")
    .select("id, display_name")
    .eq("company_id", companyId)
    .eq("username", username);
  if (excludeProfileId) query = query.neq("id", excludeProfileId);

  const { data, error } = await query.limit(1);
  if (error) throw new Error(`Could not check the username: ${error.message}`);

  const owner = data?.[0];
  if (owner) throw usernameTakenError(username, owner.display_name);
}

/**
 * يتعرّف على رفض GoTrue لبريد إلكتروني مسجّل مسبقاً لحساب آخر.
 *
 * Newer GoTrue sets `code: "email_exists"`; older builds only say so in the
 * message, so both are accepted. Kept as the GoTrue-side guard even though the
 * synthetic auth email (R3) makes a collision near-impossible: {@link isEmailConflict}
 * is what catches real-address duplicates today, at the profile write.
 */
export function isEmailTaken(error: Pick<AuthError, "message" | "code">): boolean {
  return error.code === "email_exists" || /already been registered/i.test(error.message);
}

/**
 * يبني خطأ «البريد الإلكتروني مسجّل مسبقاً» ويسمّي صاحبه من جدول profiles.
 *
 * The lookup reads the company's own profiles only (`serverCompanyClient`
 * scopes the query), so it can never name an owner from another company.
 * `profiles.email` is unique per company (migration 255), so the lookup finds
 * the racing row in the common case; a failed or empty read still yields the
 * conflict, just without a name.
 */
export async function emailTakenError(email: string, explicitCompanyId?: string): Promise<Error> {
  const { companyId, client } = serverCompanyClient(explicitCompanyId);
  const { data } = await client
    .from("profiles")
    .select("display_name")
    .eq("company_id", companyId)
    .eq("email", email)
    .limit(1);
  const owner = data?.[0]?.display_name ?? null;
  const english = owner
    ? `The email "${email}" is already used by "${owner}". Choose a different email.`
    : `The email "${email}" is already registered to another account. Choose a different email.`;
  return new Error(userConflictMessage({ kind: "email", value: email, owner }, english));
}
