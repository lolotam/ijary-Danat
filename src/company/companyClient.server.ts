import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";

import { CompanyContextError } from "@/company/errors";
import type { Database } from "@/integrations/supabase/database.types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_TTL_SECONDS = 5 * 60;
const TOKEN_REFRESH_BUFFER_SECONDS = 30;

export interface CompanyClientOptions {
  /** يُسمح بتمريره من مسار تسوية المدفوعات فقط للعمل مع شركة موقوفة. */
  allowSuspended?: boolean;
}

export interface CompanyServiceJwtClaims {
  role: "company_service";
  company_id: string;
  allow_suspended?: true;
}

/**
 * يقرأ عنوان Supabase وقيمة المفتاح العام مع دعم بادئة SELF_ في بيئة معاينة Lovable.
 */
function readSupabasePublicConfig(): { url: string; publishableKey: string } {
  const url = process.env.SUPABASE_URL || process.env.SELF_SUPABASE_URL;
  const publishableKey =
    process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SELF_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    console.warn("[company/companyClient] Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY.");
  }

  return {
    url: url ?? "http://localhost:54321",
    publishableKey: publishableKey ?? "public-anon-key",
  };
}

/**
 * يقرأ سر توقيع JWT الخاص بـ Supabase للتحقق من توفره دون تسريب قيمته في الأخطاء.
 */
function requireJwtSecret(): Uint8Array {
  const secret = process.env.SUPABASE_JWT_SECRET || process.env.SELF_SUPABASE_JWT_SECRET;
  if (!secret || !secret.trim()) {
    throw new Error("Missing SUPABASE_JWT_SECRET for companyClient token signing.");
  }
  return new TextEncoder().encode(secret);
}

/**
 * يتحقق من أن معرف الشركة نص غير فارغ بصيغة UUID صالحة، وإلا يرمي COMPANY_REQUIRED.
 */
function assertValidCompanyId(companyId: string): void {
  if (typeof companyId !== "string" || !UUID_PATTERN.test(companyId)) {
    throw new CompanyContextError("COMPANY_REQUIRED");
  }
}

/**
 * يوقّع رمز JWT قصير العمر (5 دقائق) لدور `company_service` مقيّداً بشركة واحدة.
 *
 * PostgREST switches to `company_service` on the request and `current_company_id()`
 * reads `company_id` (and `allow_suspended` only when explicitly requested by settlement).
 */
export async function signCompanyServiceToken(
  companyId: string,
  opts?: CompanyClientOptions,
): Promise<string> {
  assertValidCompanyId(companyId);
  const secret = requireJwtSecret();

  const claims: Record<string, unknown> = {
    role: "company_service",
    company_id: companyId,
  };
  if (opts?.allowSuspended === true) {
    claims.allow_suspended = true;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + TOKEN_TTL_SECONDS)
    .sign(secret);
}

/**
 * ينشئ موفّر رمز متخفّفاً يعيد استخدام الرمز الموقّع حتى قبيل انتهاء صلاحيته بـ 30 ثانية.
 */
function createCachedTokenProvider(
  companyId: string,
  opts?: CompanyClientOptions,
): () => Promise<string> {
  let cachedToken: string | null = null;
  let expiresAtSeconds = 0;
  let inFlight: Promise<string> | null = null;

  return async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (cachedToken && nowSeconds < expiresAtSeconds - TOKEN_REFRESH_BUFFER_SECONDS) {
      return cachedToken;
    }
    if (inFlight) {
      return inFlight;
    }

    inFlight = signCompanyServiceToken(companyId, opts)
      .then((token) => {
        cachedToken = token;
        expiresAtSeconds = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
        return token;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };
}

/**
 * يُنشئ عميل Supabase مقيّداً بشركة واحدة عبر دور `company_service` الخاضع لسياسات RLS.
 *
 * Never uses `service_role`; every query runs with the anon/publishable `apikey`
 * and a 5-minute HS256 JWT carrying `{ role: "company_service", company_id }`.
 */
export function companyClient(
  companyId: string,
  opts?: CompanyClientOptions,
): SupabaseClient<Database> {
  assertValidCompanyId(companyId);
  // Fail fast at client construction if the JWT signing secret is unconfigured.
  requireJwtSecret();

  const { url, publishableKey } = readSupabasePublicConfig();

  return createClient<Database>(url, publishableKey, {
    accessToken: createCachedTokenProvider(companyId, opts),
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
