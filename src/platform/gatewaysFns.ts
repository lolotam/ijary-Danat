import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabase } from "@/integrations/supabase/client";
import type { PlatformGatewayLaunchRow } from "@/integrations/supabase/database.types";
import { parseServerInput } from "@/lib/parseServerInput";
import {
  platformListGatewayLaunch,
  platformSetGatewayLiveAllowed,
  setGatewayLiveAllowedSchema,
  type GatewayLaunchStatus,
  type SetGatewayLiveAllowedInput,
} from "@/platform/gateways";

/**
 * رمز رفض الطلب الذي لا يحمل جلسة مشرف منصة.
 *
 * Mirrors `PLATFORM_ADMIN_REQUIRED` in `requirePlatformAdmin.server.ts` without
 * pulling server-only request APIs into the browser bundle.
 */
const NO_PLATFORM_SESSION = "PLATFORM_ADMIN_REQUIRED";

/**
 * ينفّذ عملية إطلاق بوابات المنصة مرفقاً بها رمز جلسة المشرف العام.
 */
async function callPlatformGatewayOperation<TOutput>(
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

/** يسرد حالة السماح بالوضع الفعلي لجميع مزوّدي بوابات الدفع. */
const listGatewayLaunchFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(z.object({}), data))
  .handler(async () => platformListGatewayLaunch());

/** يحدّث إذن الوضع الفعلي لمزوّد بوابة دفع محدّد. */
const setGatewayLiveAllowedFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(setGatewayLiveAllowedSchema, data))
  .handler(async ({ data }) => platformSetGatewayLiveAllowed(data));

/** يقرأ حالة إطلاق بوابات الدفع من المتصفح مع رمز الجلسة. */
export function fetchPlatformGatewayLaunch(): Promise<GatewayLaunchStatus[]> {
  return callPlatformGatewayOperation(listGatewayLaunchFn, {});
}

/** يحدّث إذن الوضع الفعلي لمزوّد بوابة دفع من المتصفح مع رمز الجلسة. */
export function setPlatformGatewayLiveAllowed(
  input: SetGatewayLiveAllowedInput,
): Promise<PlatformGatewayLaunchRow> {
  return callPlatformGatewayOperation(setGatewayLiveAllowedFn, input);
}
