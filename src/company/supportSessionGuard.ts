import { getRequest } from "@tanstack/react-start/server";

import { CompanyContextError } from "@/company/errors";

/**
 * يفحص كائن الادعاءات بحثاً عن معرّف منتحل غير فارغ في جلسة الدعم.
 */
function hasImpersonatorClaim(claims: unknown): boolean {
  if (!claims || typeof claims !== "object") {
    return false;
  }
  const impersonator = (claims as { impersonator?: unknown }).impersonator;
  return typeof impersonator === "string" && impersonator.trim().length > 0;
}

/**
 * يقرأ حمولة رمز Bearer من طلب HTTP النشط إن وُجد، أو يعيد null خارج سياق الطلب.
 *
 * `requireSupabaseAuth` sets `context.claims` to `data.user` from GoTrue, which
 * does not carry custom JWT claims like `impersonator`. Reading the Bearer
 * payload directly ensures the guard catches support-session tokens in production
 * while still allowing unit tests to pass raw claims directly.
 */
function readBearerClaimsFromRequest(): unknown {
  let request: Request;
  try {
    request = getRequest();
  } catch {
    return null;
  }

  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const token = header.slice("bearer ".length).trim();
  const payload = token.split(".")[1];
  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * يرفض العملية الحساسة أثناء جلسة الدعم الفني برمز `SUPPORT_SESSION_FORBIDDEN`.
 *
 * Blocks password changes, user mutations, and payment-gateway credential
 * changes whenever the caller is acting inside a support impersonation session.
 */
export function assertNotSupportSession(claims: unknown): void {
  if (hasImpersonatorClaim(claims) || hasImpersonatorClaim(readBearerClaimsFromRequest())) {
    throw new CompanyContextError("SUPPORT_SESSION_FORBIDDEN", "SUPPORT_SESSION_FORBIDDEN");
  }
}
