import { getRequest } from "@tanstack/react-start/server";
import { errors, jwtVerify, type JWTPayload } from "jose";

import { getRequestCompany } from "@/company/requestCompany.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writePlatformAudit } from "@/platform/audit";
import { requirePlatformAdmin } from "@/platform/requirePlatformAdmin.server";
import { requireJwtSecret, SUPPORT_SESSION_NOT_FOUND } from "@/platform/supportSession";
import type { OpenSupportSession } from "@/platform/supportSessionFns";

/**
 * التحقق من رمز جلسة الدعم وقراءة صفوفها وإنهاؤها بصلاحية الخادم.
 *
 * Server-only half of `supportSessionFns.ts`: every function here uses the
 * service client or the request, so the browser must never load this file.
 */

/** نمط معرّف UUID؛ يُستخدم قبل أي استعلام بالادعاءات المقروءة من الرمز. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ادعاءات رمز جلسة الدعم كما يقرأها التحقق من التوقيع. */
export interface SupportTokenClaims {
  /** معرّف المستخدم المستهدف: صاحب الجلسة داخل لوحة الشركة. */
  targetUserId: string;
  /** معرّف مشرف المنصة الذي فتح الجلسة. */
  impersonatorId: string;
  /** معرّف صف جلسة الانتحال في قاعدة البيانات. */
  sessionId: string;
}

/**
 * يتحقق أن نصاً مقروءاً من الرمز هو معرّف UUID قبل استخدامه في استعلام.
 */
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * يتحقق من توقيع رمز جلسة الدعم ويقرأ ادعاءاته، أو يعيد null إن لم يكن صالحاً.
 *
 * A forged token would let its bearer name any session, so the signature is
 * checked here instead of trusted from the browser. Every failure answers the
 * same null: a bad signature, an expired token and a token without its claims
 * are all a refusal, and none of them says which.
 */
export async function verifySupportToken(token: string): Promise<SupportTokenClaims | null> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, requireJwtSecret()));
  } catch (error) {
    if (error instanceof errors.JOSEError) return null;
    throw error;
  }

  const targetUserId = payload.sub;
  const impersonatorId = payload.impersonator;
  const sessionId = payload.impersonation_session;
  if (!isUuid(targetUserId) || !isUuid(impersonatorId) || !isUuid(sessionId)) return null;

  return { targetUserId, impersonatorId, sessionId };
}

/**
 * يقرأ رمز الوصول من ترويسة الطلب الحالي، أو يعيد null إن لم يكن هناك طلب.
 */
export function readRequestAccessToken(): string | null {
  let request: Request;
  try {
    request = getRequest();
  } catch {
    return null;
  }

  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice("bearer ".length).trim() || null;
}

/** صف جلسة الانتحال كما تقرؤه عمليات هذا الملف. */
interface ImpersonationSessionShape {
  id: string;
  company_id: string;
  target_user_id: string;
  reason: string;
  expires_at: string;
  ended_at: string | null;
}

/**
 * يقرأ جلسة الدعم التي يسمّيها الرمز، إذا كانت مفتوحة وتخصّ الشركة المطلوبة.
 *
 * The row is read with the service role because the company panel may not
 * read this table: its policy answers the platform admin only. What the
 * caller gets back is limited to the row its own token names, and only while
 * that row is open for the company the request came from.
 */
export async function readOpenSessionForToken(
  token: string,
  companyId: string,
): Promise<{ claims: SupportTokenClaims; row: ImpersonationSessionShape } | null> {
  const claims = await verifySupportToken(token);
  if (!claims) return null;

  const { data: row, error } = await supabaseAdmin
    .from("impersonation_sessions")
    .select("id, company_id, target_user_id, reason, expires_at, ended_at")
    .eq("id", claims.sessionId)
    .maybeSingle();
  if (error) {
    throw new Error(`impersonation_sessions lookup failed: ${error.message}`);
  }
  if (!row) return null;
  if (row.target_user_id !== claims.targetUserId) return null;
  if (row.company_id !== companyId) return null;
  if (row.ended_at !== null) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  return { claims, row };
}

/**
 * يقرأ اسم مشرف المنصة الذي فتح الجلسة.
 */
export async function readAdminName(impersonatorId: string): Promise<string> {
  const { data: admin, error } = await supabaseAdmin
    .from("platform_admins")
    .select("full_name")
    .eq("user_id", impersonatorId)
    .single();
  if (error) {
    throw new Error(`platform_admins lookup failed: ${error.message}`);
  }
  return admin.full_name;
}

/**
 * يسرد جلسات الدعم المفتوحة لشركة واحدة.
 */
export async function listCompanyOpenSessions(companyId: string): Promise<OpenSupportSession[]> {
  await requirePlatformAdmin();

  const { data: rows, error } = await supabaseAdmin
    .from("impersonation_sessions")
    .select("id, target_user_id, reason, started_at, expires_at")
    .eq("company_id", companyId)
    .is("ended_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("started_at", { ascending: false });
  if (error) {
    throw new Error(`impersonation_sessions lookup failed: ${error.message}`);
  }

  return (rows ?? []).map((row) => ({
    id: row.id,
    targetUserId: row.target_user_id,
    reason: row.reason,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
  }));
}

/**
 * يضع `ended_at` في صف جلسة الدعم، ويعيد لحظة الإنهاء.
 *
 * The update carries `ended_at is null` so a session that was ended twice —
 * from the panel and from the platform at the same moment — is closed once.
 */
async function endSessionRow(sessionId: string): Promise<string> {
  const endedAt = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("impersonation_sessions")
    .update({ ended_at: endedAt })
    .eq("id", sessionId)
    .is("ended_at", null);
  if (error) {
    throw new Error(`support session end failed: ${error.message}`);
  }
  return endedAt;
}

/**
 * ينهي جلسة الدعم التي يحملها رمز المستدعي، ويوثّق الإنهاء في سجل المنصة.
 *
 * The panel's caller holds the support token, not the platform admin's own
 * session, so the platform guard cannot be the one that authorizes this. The
 * token itself names the session, and the row it names is the row ended here
 * — the same row the platform panel ends through `platformEndSupportSession`.
 */
export async function endCallerSupportSession(
  token: string,
): Promise<{ sessionId: string; endedAt: string }> {
  const company = getRequestCompany();
  if (!company) throw new Error(SUPPORT_SESSION_NOT_FOUND);

  const open = await readOpenSessionForToken(token, company.id);
  if (!open) throw new Error(SUPPORT_SESSION_NOT_FOUND);

  const endedAt = await endSessionRow(open.row.id);

  await writePlatformAudit({
    action: "support_session.end",
    entity: "impersonation_session",
    entityId: open.row.id,
    companyId: open.row.company_id,
    actorId: open.claims.impersonatorId,
    before: { ended_at: null },
    after: { ended_at: endedAt },
  });

  return { sessionId: open.row.id, endedAt };
}
