import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getRequest } from "@tanstack/react-start/server";

import type { Database } from "@/integrations/supabase/database.types";

/**
 * حارس لوحة المنصة: لا تمرّ أي عملية سوبر أدمن إلا بعد أن يؤكد قاعدة البيانات
 * أن المستدعي مشرف منصة نشط ومعه العامل الثاني.
 */

/**
 * الرمز الذي يحمل كل رفضٍ لعمليةٍ في لوحة المنصة.
 *
 * One code for every refusal — no token, no admin row, no second factor — so
 * the answer never says which half of the check failed.
 */
export const PLATFORM_ADMIN_REQUIRED = "PLATFORM_ADMIN_REQUIRED";

/** مشرف المنصة الذي اجتاز الحارس. */
export interface PlatformAdmin {
  /**
   * معرّف مشرف المنصة في `auth.users` — يُكتب في سجل تدقيق المنصة كـ`actor_id`.
   */
  userId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * يقرأ رمز الوصول من ترويسة الطلب، ويرفض كل طلب لا يحمل رمزاً.
 */
function readAccessToken(): string {
  let request: Request;
  try {
    request = getRequest();
  } catch {
    // لا يوجد طلب جارٍ (عملية خلفية أو اختبار): لا مستدعي، إذن لا مشرف.
    throw new Error(PLATFORM_ADMIN_REQUIRED);
  }

  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    throw new Error(PLATFORM_ADMIN_REQUIRED);
  }

  const token = header.slice("bearer ".length).trim();
  if (!token) {
    throw new Error(PLATFORM_ADMIN_REQUIRED);
  }
  return token;
}

/**
 * يبني عميل Supabase يحمل رمز المستدعي نفسه لا مفتاح الخدمة.
 *
 * The publishable key plus the caller's own token is what makes PostgREST run
 * the request as that user, so `is_platform_admin()` reads their real claims —
 * the `aal2` claim included. A service-role client would answer the question
 * for itself and answer it "yes".
 */
function createCallerClient(accessToken: string): SupabaseClient<Database> {
  const url = process.env.SUPABASE_URL || process.env.SELF_SUPABASE_URL;
  const publishableKey =
    process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SELF_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY for the platform panel.");
  }

  return createClient<Database>(url, publishableKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * يقرأ معرّف المستدعي من ادعاء `sub` في رمز الجلسة.
 *
 * The token has already been accepted by PostgREST — `is_platform_admin()`
 * answered with the caller's own claims — so the claim it carries is the one
 * the database matched against `platform_admins.user_id`.
 */
function decodeSubject(accessToken: string): string {
  const payload = accessToken.split(".")[1];
  if (!payload) {
    throw new Error(PLATFORM_ADMIN_REQUIRED);
  }

  let subject: unknown;
  try {
    subject = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown })
      .sub;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    throw new Error(PLATFORM_ADMIN_REQUIRED, { cause: error });
  }

  if (typeof subject !== "string" || !UUID_PATTERN.test(subject)) {
    throw new Error(PLATFORM_ADMIN_REQUIRED);
  }
  return subject;
}

/**
 * يتأكد أن المستدعي مشرف منصة، ويعيد هويته.
 *
 * The check is the database's own: `is_platform_admin()` needs an active
 * `platform_admins` row AND the `aal2` claim (migration 317), and it is called
 * through the caller's own client so it reads the caller's claims and not the
 * service role's. A stolen password alone reaches nothing — the second factor
 * is part of the token.
 *
 * Every platform operation starts with this, and every refusal it raises
 * carries the same code.
 */
export async function requirePlatformAdmin(): Promise<PlatformAdmin> {
  const accessToken = readAccessToken();
  const caller = createCallerClient(accessToken);

  const { data, error } = await caller.rpc("is_platform_admin");
  if (error || data !== true) {
    throw new Error(PLATFORM_ADMIN_REQUIRED);
  }

  return { userId: decodeSubject(accessToken) };
}
