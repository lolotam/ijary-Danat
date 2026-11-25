import { createMiddleware } from "@tanstack/react-start";
import { getRequest, setResponseStatus } from "@tanstack/react-start/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "./database.types";

/**
 * يرفض الطلب برمز HTTP المناسب ويرمي خطأً، لا استجابة.
 *
 * A `Response` thrown here does NOT reach the browser as a 401. The middleware
 * runner stores it as the call's error, the server-functions handler finds a
 * `Response` there, stamps it `x-tss-raw`, and the client fetcher returns it as
 * the call's resolved value — so an expired session resolved as SUCCESS and
 * the caller's success toast fired over nothing (the same trap `requirePermission`
 * documents for handlers). An `Error` is serialized and rejects on the client;
 * setting the status first keeps the HTTP code a monitor would see.
 *
 * Sign-in redirects are unaffected: the admin and portal layouts redirect on
 * the client session, never on a server-function failure.
 */
function refuse(status: 401 | 500, message: string): never {
  setResponseStatus(status);
  throw new Error(message);
}

/**
 * وسيطة دوال الخادم: تتحقق من رمز الجلسة وتحقن عميل Supabase باسم المستخدم.
 *
 * Reads Authorization: Bearer <access_token>, validates it against Supabase
 * Auth, and injects a per-request client that acts as the signed-in user, so
 * RLS applies to everything the handler reads through it.
 */
export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const request = getRequest();
    const authHeader = request.headers.get("authorization") ?? request.headers.get("Authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      refuse(401, "Unauthorized");
    }
    const token = authHeader.slice("bearer ".length).trim();

    const url = process.env.SUPABASE_URL || process.env.SELF_SUPABASE_URL;
    const publishableKey =
      process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SELF_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !publishableKey) {
      refuse(500, "Server misconfigured: SUPABASE_URL missing");
    }

    const supabase: SupabaseClient<Database> = createClient<Database>(url, publishableKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      refuse(401, "Unauthorized");
    }

    return next({ context: { supabase, userId: data.user.id, claims: data.user } });
  },
);
