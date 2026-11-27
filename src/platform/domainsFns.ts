import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabase } from "@/integrations/supabase/client";
import { parseServerInput } from "@/lib/parseServerInput";
import {
  addCustomDomainSchema,
  platformAddCustomDomain,
  platformListCompanyDomains,
  platformVerifyCustomDomain,
  verifyCustomDomainSchema,
  type AddCustomDomainInput,
  type PlatformCompanyDomain,
  type VerifyCustomDomainInput,
} from "@/platform/domains";

export type { PlatformCompanyDomain };

/**
 * رمز رفض الطلب الذي لا يحمل جلسة مشرف منصة.
 *
 * The platform guard authenticates the caller from the request, and the
 * browser session lives in local storage rather than in a cookie, so the
 * token has to travel with the call. Kept apart from `domains.ts` so the
 * browser bundle never loads the server-only guard and service client.
 */
const NO_PLATFORM_SESSION = "PLATFORM_ADMIN_REQUIRED";

/**
 * ينفّذ عملية لوحة منصة مرفقاً بها رمز جلسة المشرف العام.
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

/** يقرأ نطاقات شركة. */
const listCompanyDomainsFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(z.object({ companyId: z.string().uuid() }), data))
  .handler(async ({ data }) => platformListCompanyDomains(data.companyId));

/** يضيف نطاقاً مخصّصاً لشركة. */
const addCustomDomainFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(addCustomDomainSchema, data))
  .handler(async ({ data }) => platformAddCustomDomain(data));

/** يقرأ حالة نطاق مخصّص من المزوّد ويحدّثها. */
const verifyCustomDomainFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(verifyCustomDomainSchema, data))
  .handler(async ({ data }) => platformVerifyCustomDomain(data));

/** يقرأ نطاقات شركة من المتصفح، مع رمز الجلسة. */
export function fetchPlatformCompanyDomains(input: {
  companyId: string;
}): Promise<PlatformCompanyDomain[]> {
  return callPlatformOperation(listCompanyDomainsFn, input);
}

/** يضيف نطاقاً مخصّصاً من المتصفح، مع رمز الجلسة. */
export function addPlatformCustomDomain(
  input: AddCustomDomainInput,
): Promise<PlatformCompanyDomain> {
  return callPlatformOperation(addCustomDomainFn, input);
}

/** يتحقق من نطاق مخصّص من المتصفح، مع رمز الجلسة. */
export function verifyPlatformCustomDomain(
  input: VerifyCustomDomainInput,
): Promise<PlatformCompanyDomain> {
  return callPlatformOperation(verifyCustomDomainFn, input);
}
