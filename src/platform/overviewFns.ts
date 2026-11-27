import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabase } from "@/integrations/supabase/client";
import { parseServerInput } from "@/lib/parseServerInput";
import { platformOverview, type PlatformOverview } from "@/platform/overview";

/**
 * غلاف المتصفح لعملية لوحة المنصة (قصة المستخدم 12).
 *
 * The browser's Supabase session lives in local storage rather than in a
 * cookie, so the token travels with the call: the platform guard reads the
 * caller's bearer token from the request headers, and a request without one
 * would reach the server as a request with no caller at all.
 *
 * The helper below copies the one in `platformFns.ts`, whose copy is private.
 * Three slices of this batch now carry it; it belongs in a shared module once
 * the batch merges.
 */

/**
 * رمز رفض الطلب الذي لا يحمل جلسة مشرف منصة.
 *
 * Mirrors `PLATFORM_ADMIN_REQUIRED` in `requirePlatformAdmin.server.ts` without
 * pulling server-only request APIs into the browser bundle.
 */
const NO_PLATFORM_SESSION = "PLATFORM_ADMIN_REQUIRED";

/**
 * ينفّذ عملية لوحة المنصة مرفقاً بها رمز جلسة المشرف العام.
 */
async function callPlatformOperation<TOutput>(
  serverFn: (options: { data: unknown; headers: { Authorization: string } }) => Promise<TOutput>,
  input: unknown,
): Promise<TOutput> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error(NO_PLATFORM_SESSION);
  }
  return serverFn({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}

/** يقرأ لوحة المنصة كلها من الخادم. */
const overviewFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(z.object({}), data))
  .handler(async () => platformOverview());

/** يقرأ لوحة المنصة من المتصفح، مع رمز الجلسة. */
export function fetchPlatformOverview(): Promise<PlatformOverview> {
  return callPlatformOperation(overviewFn, {});
}
