import { beforeEach, describe, expect, it, test, vi } from "vitest";

import type { HostResolution } from "@/company/requestCompany.server";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_HOST: HostResolution = {
  kind: "company",
  host: "acme.ijary.app",
  company: {
    id: COMPANY_ID,
    slug: "acme",
    status: "active",
    host: "acme.ijary.app",
  },
};
const PLATFORM_ROOT: HostResolution = { kind: "platform_root", host: "ijary.app", company: null };
const ADMIN_HOST: HostResolution = {
  kind: "platform_admin",
  host: "admin.ijary.app",
  company: null,
};
const UNKNOWN_HOST: HostResolution = { kind: "unknown", host: "", company: null };

/** صف قسم صفحة الهبوط كما يعيده المخزن. */
const mocks = vi.hoisted(() => ({
  moduleRow: null as { enabled: boolean } | null,
  moduleQueries: [] as Array<Record<string, unknown>>,
}));

/**
 * يستبدل إطار دوال الخادم باستدعاء داخل العملية نفسها.
 */
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder: Record<string, unknown> = {};
    let validator: ((data: unknown) => unknown) | null = null;
    builder.validator = (next: (data: unknown) => unknown) => {
      validator = next;
      return builder;
    };
    builder.handler = (handler: (context: { data: unknown; context: unknown }) => unknown) => {
      return async (options?: { data: unknown }) => {
        const data = validator ? validator(options?.data) : options?.data;
        return handler({ data, context: {} });
      };
    };
    return builder;
  },
}));

/**
 * بديل `companyClient` يقرأ صف قسم الشركة من الذاكرة.
 */
vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      };
      builder.maybeSingle = async () => {
        mocks.moduleQueries.push({ table, ...filters });
        return { data: mocks.moduleRow, error: null };
      };
      return builder;
    },
  }),
}));

import {
  clearLandingSectionCache,
  decideRootPage,
  getRootPageDecision,
  landingCompanyId,
} from "@/company/rootPageDecision";
import { runWithHostContext } from "@/company/requestCompany.server";

describe("decideRootPage answers what each host shows at /", () => {
  test.each([
    [
      "the platform root serves the temporary platform page",
      PLATFORM_ROOT,
      false,
      { page: "platform" },
    ],
    [
      "the platform root shows no company landing page even with the section on",
      PLATFORM_ROOT,
      true,
      { page: "platform" },
    ],
    [
      "the super admin host stands on the temporary page until its panel entry exists",
      ADMIN_HOST,
      false,
      { page: "platform" },
    ],
    [
      "a company root goes to sign-in while its landing section is off",
      COMPANY_HOST,
      false,
      { page: "signIn" },
    ],
    [
      "a company root serves its landing page when the section is on",
      COMPANY_HOST,
      true,
      { page: "landing", companyId: COMPANY_ID },
    ],
    ["an unknown host resolves to the not-found page", UNKNOWN_HOST, false, { page: "notFound" }],
  ] as const)("%s", (_scenario, resolution, landingPage, expected) => {
    expect(decideRootPage(resolution, { landingPage })).toEqual(expected);
  });
});

describe("landingCompanyId names the company that owns the host", () => {
  test.each([
    ["a company host", COMPANY_HOST, COMPANY_ID],
    ["the platform root", PLATFORM_ROOT, null],
    ["the super admin host", ADMIN_HOST, null],
    ["an unknown host", UNKNOWN_HOST, null],
  ] as const)("%s", (_scenario, resolution, expected) => {
    expect(landingCompanyId(resolution)).toBe(expected);
  });
});

describe("getRootPageDecision reads the landing section of the host's own company", () => {
  beforeEach(() => {
    clearLandingSectionCache();
    mocks.moduleRow = null;
    mocks.moduleQueries = [];
  });

  test.each([
    ["on", { enabled: true }, { page: "landing", companyId: COMPANY_ID }],
    ["off", { enabled: false }, { page: "signIn" }],
  ])(
    "serves the landing page when the company has the section %s",
    async (_label, moduleRow, expected) => {
      mocks.moduleRow = moduleRow;

      const decision = await runWithHostContext(COMPANY_HOST, () => getRootPageDecision());

      expect(decision).toEqual(expected);
    },
  );

  it("reads the section of the host's company only", async () => {
    mocks.moduleRow = { enabled: true };

    await runWithHostContext(COMPANY_HOST, () => getRootPageDecision());

    expect(mocks.moduleQueries).toEqual([
      { table: "company_modules", company_id: COMPANY_ID, module_key: "landing_page" },
    ]);
  });

  it("keeps the landing page off for a company with no row for the section", async () => {
    mocks.moduleRow = null;

    const decision = await runWithHostContext(COMPANY_HOST, () => getRootPageDecision());

    expect(decision).toEqual({ page: "signIn" });
  });

  it("serves the platform page on the platform root without asking any company", async () => {
    const decision = await runWithHostContext(PLATFORM_ROOT, () => getRootPageDecision());

    expect(decision).toEqual({ page: "platform" });
    expect(mocks.moduleQueries).toEqual([]);
  });
});
