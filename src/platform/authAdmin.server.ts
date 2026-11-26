import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * يعيد واجهة إدارة مستخدمي GoTrue (`auth.admin`) حصراً دون كشف عميل `service_role` الكامل.
 *
 * Isolates the sole GoTrue admin API dependency inside `src/platform/**` so
 * `eslint.platform-allowlist.js` matches `contracts/company-context.md` section 3
 * with zero temporary exceptions in `src/fns/`.
 */
export function getAuthAdmin() {
  return supabaseAdmin.auth.admin;
}
