import type { AuthError } from "@supabase/supabase-js";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { userConflictMessage } from "@/lib/userConflicts";

/**
 * يتعرّف على رفض قاعدة البيانات لاسم مستخدم محجوز لحساب آخر.
 *
 * The race fallback for {@link assertUsernameAvailable}: two admins saving the
 * same name at once both pass the pre-check, and `profiles_username_key`
 * refuses the second write. Matched by constraint name so another unique
 * violation on `profiles` (a tenant's second portal account) keeps its own
 * message.
 */
export function isUsernameConflict(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  return error?.code === "23505" && Boolean(error.message?.includes("profiles_username_key"));
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
): Promise<void> {
  let query = supabaseAdmin.from("profiles").select("id, display_name").eq("username", username);
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
 * message, so both are accepted.
 */
export function isEmailTaken(error: Pick<AuthError, "message" | "code">): boolean {
  return error.code === "email_exists" || /already been registered/i.test(error.message);
}

/**
 * يبني خطأ «البريد الإلكتروني مسجّل مسبقاً» ويسمّي صاحبه من جدول profiles.
 *
 * `profiles.email` is not unique (only `auth.users.email` is), so the lookup
 * is best-effort: a failed or empty read still yields the conflict, just
 * without a name.
 */
export async function emailTakenError(email: string): Promise<Error> {
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("display_name")
    .eq("email", email)
    .limit(1);
  const owner = data?.[0]?.display_name ?? null;
  const english = owner
    ? `The email "${email}" is already used by "${owner}". Choose a different email.`
    : `The email "${email}" is already registered to another account. Choose a different email.`;
  return new Error(userConflictMessage({ kind: "email", value: email, owner }, english));
}
