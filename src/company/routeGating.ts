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
