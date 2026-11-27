import { createServerFn } from "@tanstack/react-start";

import { companyClient } from "@/company/companyClient.server";
import { DEFAULT_MODULE_ENABLED } from "@/company/modules";
import { getRequestHostResolution } from "@/company/requestCompany.server";
import type { HostResolution } from "@/company/requestCompany.server";

/**
 * قرار الصفحة الجذرية `/`: صفحة المنصة المؤقتة، أو صفحة هبوط الشركة، أو تحويل
 * لتسجيل الدخول، أو 404.
 */
export type RootPageDecision =
  | { page: "platform" }
  | { page: "landing"; companyId: string }
  | { page: "signIn" }
  | { page: "notFound" };

/** مضيف غير معروف: الحالة التي يكون فيها الطلب خارج نطاق أي شركة. */
const UNKNOWN_HOST: HostResolution = { kind: "unknown", host: "", company: null };

/** مدة بقاء حالة قسم صفحة الهبوط في الذاكرة، بالمللي ثانية. */
const LANDING_SECTION_CACHE_TTL_MS = 60_000;

/** حالة قسم صفحة الهبوط كما حُفظت آخر مرة. */
const landingSectionCache = new Map<string, { enabled: boolean; expiresAt: number }>();

/**
 * يحدّد الشركة التي يخصّها محتوى صفحة الهبوط: صاحبة المضيف الذي وصل منه الطلب.
 *
 * The host is the only thing that can say which company a visitor is looking
 * at: an anonymous browser holds no session, and the host is what the address
 * bar already shows.
 */
export function landingCompanyId(resolution: HostResolution): string | null {
  return resolution.kind === "company" ? resolution.company.id : null;
}

/**
 * يقرأ حالة قسم صفحة الهبوط للشركة من `company_modules`.
 *
 * The section is off for every company until the super admin switches it on
 * (US13), and that decision lives in the database, not in the code. The row is
 * read through `companyClient`, so the company-scoped policy answers it — the
 * read never sees another company's row.
 */
async function readLandingSectionEnabled(companyId: string): Promise<boolean> {
  const cached = landingSectionCache.get(companyId);
  if (cached && cached.expiresAt > Date.now()) return cached.enabled;

  const db = companyClient(companyId);
  const { data, error } = await db
    .from("company_modules")
    .select("enabled")
    .eq("company_id", companyId)
    .eq("module_key", "landing_page")
    .maybeSingle();
  if (error) throw new Error(`company_modules lookup failed: ${error.message}`);

  const enabled = data?.enabled ?? DEFAULT_MODULE_ENABLED.landing_page;
  landingSectionCache.set(companyId, {
    enabled,
    expiresAt: Date.now() + LANDING_SECTION_CACHE_TTL_MS,
  });
  return enabled;
}

/**
 * يفرّغ ذاكرة حالة قسم صفحة الهبوط (يُستخدم في الاختبارات).
 */
export function clearLandingSectionCache(): void {
  landingSectionCache.clear();
}

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
      return sections.landingPage
        ? { page: "landing", companyId: resolution.company.id }
        : { page: "signIn" };
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
 * anyone signs in.
 */
export const getRootPageDecision = createServerFn({ method: "GET" }).handler(
  async (): Promise<RootPageDecision> => {
    const resolution = getRequestHostResolution() ?? UNKNOWN_HOST;
    if (resolution.kind !== "company") {
      return decideRootPage(resolution, { landingPage: false });
    }
    const landingPage = await readLandingSectionEnabled(resolution.company.id);
    return decideRootPage(resolution, { landingPage });
  },
);

/**
 * يعيد معرّف الشركة التي تخصّها صفحة الهبوط في هذا الطلب، أو `null`.
 *
 * The browser asks the server who owns the host it is on: the landing content
 * of a company is read for that company only, and only the server can resolve
 * a host to its owner.
 */
export const getLandingCompanyId = createServerFn({ method: "GET" }).handler(
  async (): Promise<string | null> => landingCompanyId(getRequestHostResolution() ?? UNKNOWN_HOST),
);
