import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * صف companies الجاهز لكل شركة، يقرأه عميل Supabase الوهمي لشركتها فقط —
 * فقراءة شركة أخرى تعيد صفّها هي، ويكشف الخطأ في تحديد الشركة.
 */
const rowsByCompany: Record<string, { data: unknown; error: { message: string } | null }> = {};

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({ handler: (handler: unknown) => handler }),
}));
vi.mock("@/company/companyClient.server", () => ({
  companyClient: (companyId: string) => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve(rowsByCompany[companyId] ?? { data: null, error: null }),
        }),
      }),
    }),
  }),
}));

const { runWithHostContext } = await import("@/company/requestCompany.server");
const { brandStyleFor, getPublicBranding, PLATFORM_BRANDING } = await import("./publicBranding");
const { clearPublicBrandingCache } = await import("./publicBranding.server");

// The mocked createServerFn hands back the raw handler, same as the sign-in
// tests drive theirs.
const readBranding = getPublicBranding as unknown as () => Promise<unknown>;

const COMPANY_A = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  slug: "acme",
  status: "active" as const,
  host: "acme.ijary.app",
};
const COMPANY_B = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  slug: "beta",
  status: "active" as const,
  host: "beta.ijary.app",
};

/** صف companies كامل كما يعيده قاعدة البيانات لشركة بعلامتها. */
function companyRow(overrides: Record<string, unknown>) {
  return {
    name_ar: "دانة المستقبل",
    name_en: "Danat Al Mustaqbal",
    brand_primary: null,
    brand_accent: null,
    logo_url: null,
    favicon_url: null,
    portal_bg_url: null,
    email_logo_url: null,
    ...overrides,
  };
}

const PLATFORM_DISPLAY = {
  nameAr: "إيجاري",
  nameEn: "IJARY",
  brandPrimary: null,
  brandAccent: null,
  logoUrl: null,
  faviconUrl: null,
  portalBgUrl: null,
  emailLogoUrl: null,
};

beforeEach(() => {
  clearPublicBrandingCache();
  for (const companyId of Object.keys(rowsByCompany)) delete rowsByCompany[companyId];
});

describe("getPublicBranding returns only the host company's public display data", () => {
  test.each([
    [
      "colours and logos are all set",
      companyRow({
        brand_primary: "#0f766e",
        brand_accent: "#134e4a",
        logo_url: "https://cdn.test/logo.png",
        favicon_url: "https://cdn.test/favicon.png",
        portal_bg_url: "https://cdn.test/bg.png",
        email_logo_url: "https://cdn.test/email.png",
      }),
      {
        nameAr: "دانة المستقبل",
        nameEn: "Danat Al Mustaqbal",
        brandPrimary: "#0f766e",
        brandAccent: "#134e4a",
        logoUrl: "https://cdn.test/logo.png",
        faviconUrl: "https://cdn.test/favicon.png",
        portalBgUrl: "https://cdn.test/bg.png",
        emailLogoUrl: "https://cdn.test/email.png",
      },
    ],
    [
      "a company with no colours or logos keeps them null",
      companyRow({}),
      {
        nameAr: "دانة المستقبل",
        nameEn: "Danat Al Mustaqbal",
        brandPrimary: null,
        brandAccent: null,
        logoUrl: null,
        faviconUrl: null,
        portalBgUrl: null,
        emailLogoUrl: null,
      },
    ],
  ])("returns the host company's branding when %s", async (_scenario, row, expected) => {
    rowsByCompany[COMPANY_A.id] = { data: row, error: null };

    await expect(
      runWithHostContext({ kind: "company", host: COMPANY_A.host, company: COMPANY_A }, () =>
        readBranding(),
      ),
    ).resolves.toEqual(expected);
  });

  test("a second company never sees the first company's branding", async () => {
    // Each company's client can only read its own row; a shared cache slot or a
    // mis-scoped read would hand beta's visitors acme's name and logo.
    rowsByCompany[COMPANY_A.id] = {
      data: companyRow({ name_ar: "ألف", name_en: "Alpha", logo_url: "https://cdn.test/a.png" }),
      error: null,
    };
    rowsByCompany[COMPANY_B.id] = {
      data: companyRow({ name_ar: "باء", name_en: "Beta", logo_url: "https://cdn.test/b.png" }),
      error: null,
    };

    const alpha = await runWithHostContext(
      { kind: "company", host: COMPANY_A.host, company: COMPANY_A },
      () => readBranding(),
    );
    const beta = await runWithHostContext(
      { kind: "company", host: COMPANY_B.host, company: COMPANY_B },
      () => readBranding(),
    );

    expect(alpha).toMatchObject({ nameEn: "Alpha", logoUrl: "https://cdn.test/a.png" });
    expect(beta).toMatchObject({ nameEn: "Beta", logoUrl: "https://cdn.test/b.png" });
  });

  test.each(["platform_root", "platform_admin", "unknown"] as const)(
    "a %s host gets the platform branding and no company data",
    async (kind) => {
      await expect(
        runWithHostContext({ kind, host: "somewhere.test", company: null }, () => readBranding()),
      ).resolves.toEqual(PLATFORM_DISPLAY);
    },
  );

  test("a failed companies read surfaces the error instead of demoting the company", async () => {
    // Swallowing it here once rendered a company's sign-in page with the
    // platform's identity on a transient database failure.
    rowsByCompany[COMPANY_A.id] = { data: null, error: { message: "connection refused" } };

    await expect(
      runWithHostContext({ kind: "company", host: COMPANY_A.host, company: COMPANY_A }, () =>
        readBranding(),
      ),
    ).rejects.toThrow("connection refused");
  });
});

describe("brandStyleFor turns set brand colours into theme variables", () => {
  test.each([
    [
      "both colours are valid",
      { brandPrimary: "#ffffff", brandAccent: "#04201d" },
      {
        "--primary": "#ffffff",
        "--primary-foreground": "#04201d",
        "--accent": "#04201d",
        "--accent-foreground": "#ffffff",
      },
    ],
    [
      "short hex expands to six digits",
      { brandPrimary: "#abc", brandAccent: null },
      { "--primary": "#aabbcc", "--primary-foreground": "#04201d" },
    ],
    [
      "a malformed colour is ignored rather than fed to CSS",
      { brandPrimary: "red; background: url(x)", brandAccent: "chartreuse" },
      {},
    ],
  ])("%s", (_scenario, colours, expected) => {
    expect(brandStyleFor({ ...PLATFORM_DISPLAY, ...colours })).toEqual(expected);
  });
});
