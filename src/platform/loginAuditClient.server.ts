import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/database.types";

/** الترويسات المُعاد إرسالها إلى PostgREST ليقرأها write_audit. */
export type LoginAuditHeaders = Record<string, string>;

/**
 * يبني عميلاً بصلاحية service_role مخصصاً لكتابة صفوف تدقيق الدخول وحدها.
 *
 * Lives under `src/platform/**` because it holds the service_role key, and the
 * platform allow-list is the only place allowed to. Sign-in has no company
 * session yet and `write_audit` trusts forwarded client IP, path and
 * `p_actor_id` only from service_role; it derives the row's company from the
 * actor's profile, so callers cannot pick a company.
 *
 * `autoRefreshToken: false` because auth-js starts its refresh ticker off-browser,
 * and a ticker outliving a per-request client once revoked whole browser session
 * families as suspected token reuse. Returns null when the env is not set, so a
 * missing key skips the audit row instead of breaking the login form.
 */
export function loginAuditClient(headers: LoginAuditHeaders) {
  const url = process.env.SUPABASE_URL || process.env.SELF_SUPABASE_URL;
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SELF_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;

  return createClient<Database>(url, serviceRoleKey, {
    global: { headers },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
