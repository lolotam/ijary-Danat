import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyOrigin } from "@/company/companyUrl.server";
import { CompanyContextError } from "@/company/errors";
import { getRequestCompany } from "@/company/requestCompany.server";
import { supabase } from "@/integrations/supabase/client";
import { parseServerInput } from "@/lib/parseServerInput";
import { platformEndSupportSession, platformStartSupportSession } from "@/platform/supportSession";
import {
  endCallerSupportSession,
  listCompanyOpenSessions,
  readAdminName,
  readOpenSessionForToken,
  readRequestAccessToken,
} from "@/platform/supportSessionAccess.server";

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
 *
 * The token checks and service-role reads live in
 * `supportSessionAccess.server.ts` and are reached only from handler bodies,
 * so the browser bundle never loads the server-only guard and service client.
 */

/** رمز رفض الطلب الذي لا يحمل جلسة مستدعي. */
const NO_CALLER_SESSION = "NO_CALLER_SESSION";

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
