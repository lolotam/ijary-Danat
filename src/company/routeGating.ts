import type { HostResolution } from "@/company/requestCompany.server";

/**
 * يتحقق أن المسار يقع تحت بادئة مسار كاملة كجزء من المسار (`/platform` أو `/platform/...`).
 *
 * Segment-boundary matching so look-alike paths such as `/platformx` are never
 * mistaken for the super admin panel.
 */
function isUnderPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * يوحّد شكل المسار قبل فحص الإقفال: فك الترميز، وحروف صغيرة، ودمج الشرطات المتكررة.
 *
 * The router matches paths case-insensitively and decodes them, so the gate
 * must see the same path the router will: otherwise `/PLATFORM/...`,
 * `/%70latform` or `//platform` would reach the panel on a company host. A
 * path that does not decode is refused by mapping it to the panel prefix,
 * which no non-admin host is allowed.
 */
function normalizePathname(pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (error) {
    if (error instanceof URIError) return "/platform";
    throw error;
  }
  return decoded.toLowerCase().replace(/\/{2,}/g, "/");
}

/**
 * يتحقق أن المسار من مسارات Webhook العامة التي تبقى متاحة على كل المضيفين.
 *
 * `/api/public/*` carries the payment and messaging provider callbacks, and
 * they resolve their company from the host themselves; gating them here would
 * silently drop provider callbacks during host misconfiguration, so the gate
 * keeps them exactly as reachable as before T081.
 */
function isPublicWebhookPath(pathname: string): boolean {
  return isUnderPathPrefix(pathname, "/api/public");
}

/**
 * ما يردّ به وسيط المضيف لطلب يقع على مضيف شركة معلّقة.
 *
 * `allowed` — الطلب يمرّ عادياً: صفحة التعليق نفسها، أو استدعاء مزوّد عام،
 * أو ملف ثابت من أصول البناء.
 * `page` — الطلب صفحة تطبيق، فتردّ له صفحة التعليق.
 * `forbidden` — الطلب نداء واجهة أو دالة خادم، فيُرفض برمز `COMPANY_SUSPENDED`.
 */
export type SuspendedRouteDecision = "allowed" | "page" | "forbidden";

/** مسار صفحة الشركة المعلّقة؛ الطلب إليه يصل إلى الصفحة نفسها. */
const SUSPENDED_PAGE_PATH = "/suspended";

/**
 * بادئة نداءات دوال الخادم في TanStack Start (الافتراضي `/_serverFn`).
 *
 * The comparison happens after `normalizePathname` has lowercased the path, so
 * the prefix is written the way it looks at that point.
 */
const SERVER_FUNCTION_PATH = "/_serverfn";

/**
 * هل المسار صفحة الشركة المعلّقة نفسها؟
 *
 * The page is the one path of a suspended company the gate leaves alone, so it
 * reaches the router and renders `src/routes/suspended.tsx`.
 */
export function isSuspendedPagePath(rawPathname: string): boolean {
  return isUnderPathPrefix(normalizePathname(rawPathname), SUSPENDED_PAGE_PATH);
}

/**
 * هل المسار ملف ثابت (ورقة أنماط أو صورة أو نص) لا صفحة تطبيق؟
 *
 * Every built asset carries a file extension and every route in this app ends
 * in an extension-free segment, so the extension is what tells a request for
 * `/assets/app.css` from a request for `/admin/invoices`. Only the last
 * segment counts: a dot in a directory name says nothing about the file the
 * request asks for.
 */
function isStaticAssetPath(pathname: string): boolean {
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return /\.[a-z0-9]{2,8}$/i.test(lastSegment);
}

/**
 * هل الطلب نداء واجهة برمجية أو دالة خادم، لا طلب صفحة؟
 *
 * The path decides it — `/api/*` routes and the `/_serverFn/*` calls the
 * browser makes — and the `Accept` header is the fallback the framework itself
 * uses: a request that does not accept HTML gets JSON, never a rendered page.
 */
function isApiRequest(request: Request, pathname: string): boolean {
  if (isUnderPathPrefix(pathname, "/api")) return true;
  if (isUnderPathPrefix(pathname, SERVER_FUNCTION_PATH)) return true;
  const accept = request.headers.get("accept") ?? "*/*";
  return !/(^|,)\s*(\*\/\*|text\/html)/.test(accept);
}

/**
 * يقرر ما يردّ به وسيط المضيف على طلب يقع على مضيف شركة معلّقة.
 *
 * A suspended company keeps three things open: the suspended page itself, the
 * public provider callbacks (`/api/public/*`, which resolve their own company
 * and must not be dropped), and the static assets the page needs. Everything
 * else is either a page — which gets the suspended page — or an API or
 * server-function call, which is refused with `COMPANY_SUSPENDED`.
 */
export function suspendedRouteDecision(
  request: Request,
  resolution: HostResolution,
  rawPathname: string,
): SuspendedRouteDecision {
  if (resolution.kind !== "company" || resolution.company.status !== "suspended") return "allowed";
  const pathname = normalizePathname(rawPathname);
  if (isSuspendedPagePath(pathname)) return "allowed";
  if (isPublicWebhookPath(pathname)) return "allowed";
  if (isStaticAssetPath(pathname)) return "allowed";
  return isApiRequest(request, pathname) ? "forbidden" : "page";
}

/**
 * يحسم إقفال المسارات على المضيفين: `/platform/*` للوحة المشرف العام فقط،
 * و`/admin/*` و`/portal/*` لمضيفات الشركات فقط، والباقي يُمنع على المضيف المجهول.
 *
 * `ijary.app` is not hard-coded: the host kinds arrive already resolved from
 * config (`PLATFORM_ROOT_HOST` / `PLATFORM_ADMIN_HOST`) by `resolveHostCompany`.
 * Public webhook routes are exempt — see `isPublicWebhookPath`.
 */
export function isRouteAllowedForHost(resolution: HostResolution, rawPathname: string): boolean {
  const pathname = normalizePathname(rawPathname);
  if (isPublicWebhookPath(pathname)) return true;
  if (resolution.kind === "unknown") return false;

  if (isUnderPathPrefix(pathname, "/platform")) {
    return resolution.kind === "platform_admin";
  }
  if (isUnderPathPrefix(pathname, "/admin") || isUnderPathPrefix(pathname, "/portal")) {
    return resolution.kind === "company";
  }
  return true;
}
