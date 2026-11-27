import { redirect } from "@tanstack/react-router";

import { supabase } from "@/integrations/supabase/client";

/**
 * يحرس فتح لوحة الإدارة أو بوابة المستأجر خلف تغيير كلمة المرور المؤقتة.
 *
 * The first admin of a company signs in with a temporary password and must
 * change it (FR-032). The flag lives on the profile, and the route guard is
 * where that becomes true: a signed-in person whose flag is set is sent to the
 * change-password screen and nothing else of the product loads.
 */

/** الوجهة التي يعود إليها المستخدم بعد تغيير كلمة المرور. */
export type PasswordChangeDestination = "/admin" | "/portal";

/**
 * يوجّه المستخدم إلى شاشة تغيير كلمة المرور إذا كانت علامته مفعّلة.
 *
 * The profile is read with the browser's own client, so the answer is scoped
 * to the signed-in person by RLS — `profiles_select_own_or_admin` lets a user
 * read their own row and nobody else's.
 *
 * A profile that cannot be read leaves the route open: an unreachable database
 * must not lock every signed-in person out of the product, and the change is
 * enforced again the moment the flag can be read. The failure is logged, not
 * hidden.
 */
export async function requirePasswordChange(destination: PasswordChangeDestination): Promise<void> {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user.id;
  // Not signed in: the layout sends them to the sign-in page, which is the
  // answer for a person who has no account on this host.
  if (!userId) return;

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("must_change_password")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.error("[auth] reading the password-change flag failed:", error.message);
    return;
  }
  if (!profile?.must_change_password) return;

  throw redirect({ to: "/reset-password", search: { change: "1", next: destination } });
}
