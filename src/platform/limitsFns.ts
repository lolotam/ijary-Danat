import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabase } from "@/integrations/supabase/client";
import { parseServerInput } from "@/lib/parseServerInput";
import {
  platformGetLimits,
  platformSetLimits,
  setLimitsSchema,
  type PlatformLimits,
  type SetLimitsInput,
} from "@/platform/limits";

/**
 * أغلفة دوال الخادم لحدود الشركة، كما يستدعيها متصفح لوحة المنصة.
 *
 * The operations live in `limits.ts`; this file is only the browser seam. The
 * platform guard reads the caller's bearer token from the request, while the
 * browser session lives in local storage, so the token has to travel with the
 * call. Duplicating the small helper from `platformFns.ts` is deliberate: that
 * file is shared by several slices and its helper is not exported.
 */
const NO_PLATFORM_SESSION = "PLATFORM_ADMIN_REQUIRED";

/** مخطط قراءة حدود شركة واحدة من المتصفح. */
const fetchLimitsSchema = z.object({ companyId: z.string().uuid() });

/**
 * ينفّذ عملية منصة مرفقاً بها رمز جلسة المشرف العام.
 */
async function callPlatformOperation<TOutput>(
  serverFn: (options: { data: unknown; headers: { Authorization: string } }) => Promise<TOutput>,
  input: unknown,
): Promise<TOutput> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error(NO_PLATFORM_SESSION);
  return serverFn({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}

/** يقرأ حدود شركة واحدة على الخادم. */
const fetchLimitsFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(fetchLimitsSchema, data))
  .handler(async ({ data }) => platformGetLimits(data.companyId));

/** يحدّث حدود شركة على الخادم. */
const setLimitsFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(setLimitsSchema, data))
  .handler(async ({ data }) => platformSetLimits(data));

/** يقرأ حدود شركة من المتصفح، مع رمز الجلسة. */
export function fetchPlatformLimits(input: { companyId: string }): Promise<PlatformLimits> {
  return callPlatformOperation(fetchLimitsFn, input);
}

/** يحدّث حدود شركة من المتصفح، مع رمز الجلسة. */
export function setPlatformLimits(input: SetLimitsInput): Promise<PlatformLimits> {
  return callPlatformOperation(setLimitsFn, input);
}
