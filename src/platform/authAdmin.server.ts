import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Only the three GoTrue admin calls staff management needs are exposed. Handing
// out `auth.admin` itself let any importer list, invite or sign links for users
// of every company, since GoTrue has no notion of a company.
type AdminApi = typeof supabaseAdmin.auth.admin;
type AuthUserAttributes = Parameters<AdminApi["createUser"]>[0];

/**
 * ينشئ مستخدم GoTrue جديداً بالبيانات المعطاة ويعيد نتيجة GoTrue كما هي.
 */
export function createAuthUser(attributes: AuthUserAttributes): ReturnType<AdminApi["createUser"]> {
  return supabaseAdmin.auth.admin.createUser(attributes);
}

/**
 * يحدّث بيانات مستخدم GoTrue موجود (البريد، كلمة المرور، الحظر، البيانات الوصفية).
 */
export function updateAuthUserById(
  userId: string,
  attributes: AuthUserAttributes,
): ReturnType<AdminApi["updateUserById"]> {
  return supabaseAdmin.auth.admin.updateUserById(userId, attributes);
}

/**
 * يحذف مستخدم GoTrue نهائياً، ويُستخدم أيضاً للتراجع عند فشل إنشاء الملف الشخصي.
 */
export function deleteAuthUser(userId: string): ReturnType<AdminApi["deleteUser"]> {
  return supabaseAdmin.auth.admin.deleteUser(userId);
}
