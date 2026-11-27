import { SignJWT } from "jose";
import { z } from "zod";

import { CompanyContextError } from "@/company/errors";
import { companySubdomainHost } from "@/company/hostCompany.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { parseServerInput } from "@/lib/parseServerInput";
import { writePlatformAudit } from "@/platform/audit";
import { COMPANY_NOT_FOUND } from "@/platform/companyStaffAccount";
import { requirePlatformAdmin } from "@/platform/requirePlatformAdmin.server";

/**
 * إدارة جلسات الدعم الفني (الانتحال) لمشرف المنصة: بدء جلسة مقيّدة بزمن
 * وسبب إلزامي، وإنهاؤها فوراً مع توثيق كلتا العمليتين في سجل تدقيق المنصة.
 */

/** مدة صلاحية جلسة الدعم بالثواني (60 دقيقة). */
const SUPPORT_SESSION_TTL_SECONDS = 60 * 60;

/** رمز الخطأ عند استهداف مستخدم لا ينتمي إلى الشركة المحددة أو غير نشط. */
export const TARGET_USER_NOT_IN_COMPANY = "TARGET_USER_NOT_IN_COMPANY";

/** رمز الخطأ عند محاولة إنهاء جلسة دعم غير موجودة. */
export const SUPPORT_SESSION_NOT_FOUND = "SUPPORT_SESSION_NOT_FOUND";

const startSupportSessionSchema = z.object({
  companyId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  reason: z.string().trim().min(1, "Support session reason is required").max(500),
});

const endSupportSessionSchema = z.object({
  sessionId: z.string().uuid(),
});

/** نتيجة بدء جلسة دعم فني صالحة. */
export interface StartSupportSessionResult {
  sessionId: string;
  token: string;
  expiresAt: string;
  companyHost: string;
}

/** نتيجة إنهاء جلسة دعم فني. */
export interface EndSupportSessionResult {
  sessionId: string;
  endedAt: string;
}

/** صف جلسة الانتحال كما يُرجعه استعلام الإدخال أو القراءة. */
interface ImpersonationSessionRecord {
  id: string;
  company_id: string;
  target_user_id: string;
  expires_at: string;
  ended_at: string | null;
}

/**
 * يقرأ سر توقيع JWT الخاص بـ Supabase لإصدار رمز جلسة الدعم والتحقق منه.
 *
 * One reader for minting and verifying, so the two can never disagree about
 * which secret signs a support token.
 */
export function requireJwtSecret(): Uint8Array {
  const secret = process.env.SUPABASE_JWT_SECRET || process.env.SELF_SUPABASE_JWT_SECRET;
  if (!secret || !secret.trim()) {
    throw new Error("Missing SUPABASE_JWT_SECRET for support session tokens.");
  }
  return new TextEncoder().encode(secret);
}

/**
 * يبدأ جلسة دعم فني لشركة نشطة باسم أحد مستخدميها النشطين ويصدر رمز JWT غير قابل للتجديد.
 *
 * Refuses empty reasons, suspended companies, and target users outside the
 * company. The token carries `impersonator` and `impersonation_session` claims
 * and expires with the database row after 60 minutes.
 */
export async function platformStartSupportSession(input: {
  companyId: string;
  targetUserId: string;
  reason: string;
}): Promise<StartSupportSessionResult> {
  const admin = await requirePlatformAdmin();
  const parsed = parseServerInput(startSupportSessionSchema, input);

  const { data: company, error: companyError } = await supabaseAdmin
    .from("companies")
    .select("id, slug, status")
    .eq("id", parsed.companyId)
    .maybeSingle();

  if (companyError) {
    throw new Error(`company lookup failed: ${companyError.message}`);
  }
  if (!company) {
    throw new Error(COMPANY_NOT_FOUND);
  }
  if (company.status !== "active") {
    throw new CompanyContextError("COMPANY_SUSPENDED");
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("id, company_id, is_active")
    .eq("id", parsed.targetUserId)
    .maybeSingle();

  if (profileError) {
    throw new Error(`target user lookup failed: ${profileError.message}`);
  }
  if (!profile || profile.company_id !== parsed.companyId || !profile.is_active) {
    throw new Error(TARGET_USER_NOT_IN_COMPANY);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = nowSeconds + SUPPORT_SESSION_TTL_SECONDS;
  const startedAtIso = new Date(nowSeconds * 1000).toISOString();
  const expiresAtIso = new Date(expiresAtSeconds * 1000).toISOString();

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("impersonation_sessions")
    .insert({
      platform_admin_id: admin.userId,
      company_id: parsed.companyId,
      target_user_id: parsed.targetUserId,
      reason: parsed.reason,
      started_at: startedAtIso,
      expires_at: expiresAtIso,
    })
    .select("id, expires_at")
    .single();

  const session = inserted as Pick<ImpersonationSessionRecord, "id" | "expires_at"> | null;
  if (insertError || !session) {
    throw new Error(
      `support session insert failed: ${insertError?.message ?? "the insert returned no row"}`,
    );
  }

  const token = await new SignJWT({
    role: "authenticated",
    aud: "authenticated",
    sub: parsed.targetUserId,
    aal: "aal1",
    impersonator: admin.userId,
    impersonation_session: session.id,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expiresAtSeconds)
    .sign(requireJwtSecret());

  await writePlatformAudit({
    action: "support_session.start",
    entity: "impersonation_session",
    entityId: session.id,
    companyId: parsed.companyId,
    actorId: admin.userId,
    before: null,
    after: {
      target_user_id: parsed.targetUserId,
      reason: parsed.reason,
      expires_at: session.expires_at,
    },
  });

  return {
    sessionId: session.id,
    token,
    expiresAt: session.expires_at,
    companyHost: companySubdomainHost(company.slug),
  };
}

/**
 * ينهي جلسة دعم فني فوراً بضبط `ended_at` وتوثيق الإجراء في سجل تدقيق المنصة.
 */
export async function platformEndSupportSession(input: {
  sessionId: string;
}): Promise<EndSupportSessionResult> {
  const admin = await requirePlatformAdmin();
  const parsed = parseServerInput(endSupportSessionSchema, input);

  const { data: existingData, error: lookupError } = await supabaseAdmin
    .from("impersonation_sessions")
    .select("id, company_id, target_user_id, ended_at")
    .eq("id", parsed.sessionId)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`support session lookup failed: ${lookupError.message}`);
  }
  const existing = existingData as ImpersonationSessionRecord | null;
  if (!existing) {
    throw new Error(SUPPORT_SESSION_NOT_FOUND);
  }

  if (existing.ended_at !== null) {
    return {
      sessionId: existing.id,
      endedAt: existing.ended_at,
    };
  }

  const endedAt = new Date().toISOString();
  const { error: updateError } = await supabaseAdmin
    .from("impersonation_sessions")
    .update({ ended_at: endedAt })
    .eq("id", parsed.sessionId)
    .is("ended_at", null);

  if (updateError) {
    throw new Error(`support session end failed: ${updateError.message}`);
  }

  await writePlatformAudit({
    action: "support_session.end",
    entity: "impersonation_session",
    entityId: parsed.sessionId,
    companyId: existing.company_id,
    actorId: admin.userId,
    before: { ended_at: null },
    after: { ended_at: endedAt },
  });

  return {
    sessionId: parsed.sessionId,
    endedAt,
  };
}
