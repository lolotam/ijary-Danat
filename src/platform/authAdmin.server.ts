import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { syntheticAuthEmail } from "@/auth/loginIdentity";

// Only the three GoTrue admin calls staff management needs are exposed. Handing
// out `auth.admin` itself let any importer list, invite or sign links for users
// of every company, since GoTrue has no notion of a company.
//
// Every account is keyed on a synthetic auth email (research.md R3): GoTrue
// enforces global email uniqueness while real addresses are unique per company
// only, so a real address in `auth.users` would refuse the second company's
// account. The real address lives in `profiles`; the helpers below make sure it
// never reaches GoTrue.
type AdminApi = typeof supabaseAdmin.auth.admin;
type AuthUserAttributes = Parameters<AdminApi["createUser"]>[0];
type AuthUserUpdateAttributes = Parameters<AdminApi["updateUserById"]>[1];

/**
 * ينشئ مستخدم GoTrue جديداً ببريد توليدي مرتبط بمعرّف يُولَّد له، ويعيد نتيجة GoTrue كما هي.
 *
 * The caller's `email` attribute is the person's real address and is dropped
 * here on purpose: it belongs in `profiles` (unique per company) and must never
 * become a GoTrue login. The generated id is passed to GoTrue explicitly so the
 * synthetic address (`syntheticAuthEmail(id)`) matches the account from the
 * first moment — the sign-in flow recomputes exactly that address from the
 * profile id. `email_confirm` is forced so GoTrue never tries to confirm an
 * address that is undeliverable by design.
 */
export function createAuthUser(attributes: AuthUserAttributes): ReturnType<AdminApi["createUser"]> {
  const userId = crypto.randomUUID();
  return supabaseAdmin.auth.admin.createUser({
    ...attributes,
    id: userId,
    email: syntheticAuthEmail(userId),
    email_confirm: true,
  });
}

/**
 * يحدّث بيانات مستخدم GoTrue موجود (كلمة المرور، الحظر، البيانات الوصفية) مع تثبيت البريد التوليدي.
 *
 * Same invariant as {@link createAuthUser}: whatever email attribute the caller
 * sends — a real address, or the legacy `<username>@users.local` mapping — is
 * replaced with the account's synthetic address. Every admin write therefore
 * converges legacy accounts onto R3's form, and no update can ever leave a real
 * deliverable address as a GoTrue login.
 */
export function updateAuthUserById(
  userId: string,
  attributes: AuthUserUpdateAttributes,
): ReturnType<AdminApi["updateUserById"]> {
  return supabaseAdmin.auth.admin.updateUserById(userId, {
    ...attributes,
    email: syntheticAuthEmail(userId),
    email_confirm: true,
  });
}

/**
 * يحذف مستخدم GoTrue نهائياً، ويُستخدم أيضاً للتراجع عند فشل إنشاء الملف الشخصي.
 */
export function deleteAuthUser(userId: string): ReturnType<AdminApi["deleteUser"]> {
  return supabaseAdmin.auth.admin.deleteUser(userId);
}

/**
 * يُنهي جميع جلسات مستخدم GoTrue ورموز التحديث الخاصة به.
 *
 * `@supabase/supabase-js` `auth.admin.signOut(jwt)` takes a user JWT rather
 * than a user id, so neither `confirmPasswordReset` (no session) nor a
 * global multi-session revocation can use it. Calls the `service_role`-only
 * `revoke_user_sessions` RPC (migration 321) instead.
 */
export function signOutAuthUser(
  userId: string,
): Promise<{ data: unknown; error: { message: string } | null }> {
  const rpc = supabaseAdmin.rpc as unknown as (
    fn: "revoke_user_sessions",
    args: { _user_id: string },
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
  return rpc("revoke_user_sessions", { _user_id: userId });
}
