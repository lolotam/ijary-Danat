import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { errors, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";

import { companyOrigin } from "@/company/companyUrl.server";
import { CompanyContextError } from "@/company/errors";
import { getRequestCompany } from "@/company/requestCompany.server";
import { supabase } from "@/integrations/supabase/client";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { parseServerInput } from "@/lib/parseServerInput";
import { writePlatformAudit } from "@/platform/audit";
import { requirePlatformAdmin } from "@/platform/requirePlatformAdmin.server";
import {
  platformEndSupportSession,
  platformStartSupportSession,
  requireJwtSecret,
  SUPPORT_SESSION_NOT_FOUND,
} from "@/platform/supportSession";

/**
 * أغلفة دوال الخادم لجلسات الدعم الفني: بدء الجلسة من لوحة المنصة، وقراءتها
 * وإنهاؤها من داخل لوحة الشركة.
 *
 * The lifecycle itself lives in `supportSession.ts`; this file is the seam
 * between those operations and the browser. Three callers sit on the two sides
 * of a session: the super admin starts and ends it from the platform panel,
 * the company panel reads the session it is inside, and the entry page installs
 * the token it was handed.
 *
 * The browser's Supabase session lives in local storage rather than in a
 * cookie, so the caller's token travels with every call as a bearer header:
 * the platform guard reads it from the request, and the company-side
 * functions verify its signature before they answer.
 */

/** رمز رفض الطلب الذي لا يحمل جلسة مستدعي. */
const NO_CALLER_SESSION = "NO_CALLER_SESSION";

/** نمط معرّف UUID؛ يُستخدم قبل أي استعلام بالادعاءات المقروءة من الرمز. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** مدخلات بدء جلسة الدعم كما تقبلها لوحة المنصة. */
export interface StartSupportSessionInput {
  companyId: string;
  targetUserId: string;
  reason: string;
}

/** جلسة دعم مفتوحة كما تعرضها لوحة المنصة. */
export interface OpenSupportSession {
  id: string;
  targetUserId: string;
  reason: string;
  startedAt: string;
  expiresAt: string;
}

/** نتيجة بدء جلسة دعم، مع رابط الدخول الذي يُعرض مرة واحدة. */
export interface StartedSupportSession {
  sessionId: string;
  token: string;
  expiresAt: string;
  companyHost: string;
  link: string;
}

/** سياق جلسة الدعم كما تحتاجه لوحة الشركة. */
export type SupportSessionContext =
  | { active: false }
  | {
      active: true;
      sessionId: string;
      reason: string;
      adminName: string;
      expiresAt: string;
    };

/** ادعاءات رمز جلسة الدعم كما يقرأها التحقق من التوقيع. */
export interface SupportTokenClaims {
  /** معرّف المستخدم المستهدف: صاحب الجلسة داخل لوحة الشركة. */
  targetUserId: string;
  /** معرّف مشرف المنصة الذي فتح الجلسة. */
  impersonatorId: string;
  /** معرّف صف جلسة الانتحال في قاعدة البيانات. */
  sessionId: string;
}

const startSupportSessionSchema = z.object({
  companyId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
});

const endSupportSessionSchema = z.object({
  sessionId: z.string().uuid(),
});

const companySessionsSchema = z.object({
  companyId: z.string().uuid(),
});

const acceptSupportSessionSchema = z.object({
  token: z.string().min(1).max(4000),
});

/**
 * يبني رابط دخول جلسة الدعم: الرمز في جزء العنوان، لا في سلسلة الاستعلام.
 *
 * A fragment never reaches the server, so the token stays out of the access
 * logs, the referrer and the query string of the page it opens.
 */
export function supportSessionLink(origin: string, token: string): string {
  return `${origin}/support-session#token=${encodeURIComponent(token)}`;
}

/**
 * يقرأ رمز الرفض من الخطأ: رمز سياق الشركة، أو نص يطابق نمط الرموز.
 *
 * Anything else is a real failure rather than a refusal, and it gets the
 * generic sentence instead of a raw code on screen.
 */
function refusalCode(cause: unknown): string | null {
  if (cause instanceof CompanyContextError) return cause.code;
  const message = cause instanceof Error ? cause.message : "";
  return /^[A-Z][A-Z_]*$/.test(message) ? message : null;
}

/**
 * يحوّل خطأ عملية جلسة الدعم إلى رسالة مترجمة.
 */
export function supportSessionErrorMessage(t: (key: string) => string, cause: unknown): string {
  const code = refusalCode(cause);
  const key = code ? `supportSession.error.${code}` : "";
  const translated = key ? t(key) : "";
  return translated && translated !== key ? translated : t("supportSession.platform.error.generic");
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
function readRequestAccessToken(): string | null {
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
async function readOpenSessionForToken(
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
async function readAdminName(impersonatorId: string): Promise<string> {
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
async function listCompanyOpenSessions(companyId: string): Promise<OpenSupportSession[]> {
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
async function endCallerSupportSession(
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

/** يبدأ جلسة دعم ويبني رابط الدخول الذي يُعرض مرة واحدة. */
const startSupportSessionFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(startSupportSessionSchema, data))
  .handler(async ({ data }) => {
    const started = await platformStartSupportSession(data);
    return {
      ...started,
      link: supportSessionLink(companyOrigin(started.companyHost), started.token),
    };
  });

/** ينهي جلسة دعم بصفها. */
const endSupportSessionFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(endSupportSessionSchema, data))
  .handler(async ({ data }) => platformEndSupportSession(data));

/** يسرد جلسات الدعم المفتوحة لشركة. */
const listOpenSupportSessionsFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(companySessionsSchema, data))
  .handler(async ({ data }) => listCompanyOpenSessions(data.companyId));

/** يتحقق من رمز جلسة الدعم ويقرّر إن كان يخصّ شركة الطلب. */
const acceptSupportSessionFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(acceptSupportSessionSchema, data))
  .handler(async ({ data }) => {
    const company = getRequestCompany();
    if (!company) return { accepted: false as const };

    const open = await readOpenSessionForToken(data.token, company.id);
    return { accepted: open !== null };
  });

/** يقرأ سياق جلسة الدعم التي يحملها رمز المستدعي. */
const readSupportSessionContextFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(z.object({}), data))
  .handler(async (): Promise<SupportSessionContext> => {
    const company = getRequestCompany();
    if (!company) return { active: false };

    const token = readRequestAccessToken();
    if (!token) return { active: false };

    const open = await readOpenSessionForToken(token, company.id);
    if (!open) return { active: false };

    return {
      active: true,
      sessionId: open.row.id,
      reason: open.row.reason,
      adminName: await readAdminName(open.claims.impersonatorId),
      expiresAt: open.row.expires_at,
    };
  });

/** ينهي جلسة الدعم التي داخلها المستدعي. */
const endSupportSessionFromPanelFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(z.object({}), data))
  .handler(async () => {
    const token = readRequestAccessToken();
    if (!token) throw new Error(NO_CALLER_SESSION);
    return endCallerSupportSession(token);
  });

/**
 * ينفّذ عملية جلسة دعم مرفقاً بها رمز جلسة المستدعي.
 *
 * The token travels as a bearer header because the platform guard and the
 * company-side functions both read the caller from the request, and the
 * browser's session lives in local storage rather than in a cookie.
 */
async function callWithCallerToken<TOutput>(
  serverFn: (options: { data: unknown; headers: { Authorization: string } }) => Promise<TOutput>,
  input: unknown,
): Promise<TOutput> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error(NO_CALLER_SESSION);
  }
  return serverFn({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}

/** يبدأ جلسة دعم من لوحة المنصة، ويعيد رابط الدخول. */
export function startPlatformSupportSession(input: StartSupportSessionInput) {
  return callWithCallerToken(startSupportSessionFn, input);
}

/** ينهي جلسة دعم من لوحة المنصة. */
export function endPlatformSupportSession(input: { sessionId: string }) {
  return callWithCallerToken(endSupportSessionFn, input);
}

/** يسرد جلسات الدعم المفتوحة لشركة من لوحة المنصة. */
export function listOpenSupportSessions(input: { companyId: string }) {
  return callWithCallerToken(listOpenSupportSessionsFn, input);
}

/** يتحقق من رمز جلسة الدعم على مضيف الشركة. */
export function acceptSupportSessionToken(input: { token: string }) {
  return acceptSupportSessionFn({ data: input });
}

/** يقرأ سياق جلسة الدعم من داخل لوحة الشركة. */
export function readSupportSessionContext() {
  return callWithCallerToken(readSupportSessionContextFn, {});
}

/** ينهي جلسة الدعم من داخل لوحة الشركة. */
export function endSupportSessionFromPanel() {
  return callWithCallerToken(endSupportSessionFromPanelFn, {});
}
