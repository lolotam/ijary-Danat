import { createServerFn } from "@tanstack/react-start";

import { DEFAULT_MODULE_ENABLED } from "@/company/modules";
import { getRequestHostResolution } from "@/company/requestCompany.server";
import type { HostResolution } from "@/company/requestCompany.server";

/**
 * قرار الصفحة الجذرية `/`: صفحة المنصة المؤقتة، أو صفحة هبوط الشركة، أو تحويل
 * لتسجيل الدخول، أو 404.
 */
export type RootPageDecision =
  | { page: "platform" }
  | { page: "landing" }
  | { page: "signIn" }
  | { page: "notFound" };

/**
 * يحسم ما تعرضه الصفحة الجذرية بحسب مضيف الطلب وحالة قسم صفحة الهبوط.
 *
 * The host is the only thing that routes the page (spec.md US3): a company host
 * shows its landing content only while its landing section is on (US13
 * scenario 2), and otherwise sends every visitor to that company's sign-in —
 * which is the state for every company until US13 (FR-027). The decision is
 * pure so the matrix is unit-testable without a request.
 *
 * `platform_admin` stands on the temporary page only because the super admin
 * panel entry does not exist yet; once `/platform/*` lands its case becomes a
 * redirect there. An `unknown` host is 404'd by the host middleware before the
 * router sees it (T081); the case exists so the function stays total.
 */
export function decideRootPage(
  resolution: HostResolution,
  sections: { landingPage: boolean },
): RootPageDecision {
  switch (resolution.kind) {
    case "company":
      return sections.landingPage ? { page: "landing" } : { page: "signIn" };
    case "platform_root":
    case "platform_admin":
      return { page: "platform" };
    case "unknown":
      return { page: "notFound" };
  }
}

/**
 * يعيد قرار الصفحة الجذرية للطلب الحالي من مضيفه المحلول على الخادم.
 *
 * Unauthenticated on purpose: the decision depends only on the host, which is
 * already public in the address bar, and the root page must decide before
 * anyone signs in. The landing section reads its code default here — off for
 * every company — until the per-company `company_modules` setting exists.
 */
export const getRootPageDecision = createServerFn({ method: "GET" }).handler(
  async (): Promise<RootPageDecision> =>
    decideRootPage(getRequestHostResolution() ?? { kind: "unknown", host: "", company: null }, {
      landingPage: DEFAULT_MODULE_ENABLED.landing_page,
    }),
);
