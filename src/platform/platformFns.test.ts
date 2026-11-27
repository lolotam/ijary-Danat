import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  lastServerFnOptions: null as { data: unknown; headers: { Authorization: string } } | null,
  operations: {
    platformListCompanies: vi.fn(),
    platformGetCompany: vi.fn(),
    platformCreateCompany: vi.fn(),
    platformUpdateCompany: vi.fn(),
    platformSetCompanyStatus: vi.fn(),
    platformListUsers: vi.fn(),
    platformCreateUser: vi.fn(),
    platformSetUserActive: vi.fn(),
    platformResetPassword: vi.fn(),
  },
}));

/**
 * يستبدل إطار دوال الخادم باستدعاء داخل العملية نفسها.
 *
 * The wrapper's own contract is what is under test — it validates the input,
 * attaches the session token and hands the request to the operation — so the
 * framework call becomes a direct call that records what it received.
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
      return async (options: { data: unknown; headers: { Authorization: string } }) => {
        mocks.lastServerFnOptions = options;
        const data = validator ? validator(options.data) : options.data;
        return handler({ data, context: {} });
      };
    };
    return builder;
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: mocks.getSession } },
}));

vi.mock("@/platform/companies", async (original) => ({
  ...(await original<typeof import("@/platform/companies")>()),
  platformListCompanies: mocks.operations.platformListCompanies,
  platformGetCompany: mocks.operations.platformGetCompany,
  platformCreateCompany: mocks.operations.platformCreateCompany,
  platformUpdateCompany: mocks.operations.platformUpdateCompany,
}));

vi.mock("@/platform/companyStatus", async (original) => ({
  ...(await original<typeof import("@/platform/companyStatus")>()),
  platformSetCompanyStatus: mocks.operations.platformSetCompanyStatus,
}));

vi.mock("@/platform/users", async (original) => ({
  ...(await original<typeof import("@/platform/users")>()),
  platformListUsers: mocks.operations.platformListUsers,
  platformCreateUser: mocks.operations.platformCreateUser,
  platformSetUserActive: mocks.operations.platformSetUserActive,
  platformResetPassword: mocks.operations.platformResetPassword,
}));

import {
  createPlatformCompany,
  createPlatformCompanyUser,
  fetchPlatformCompanies,
  fetchPlatformCompany,
  fetchPlatformCompanyUsers,
  resetPlatformCompanyUserPassword,
  setPlatformCompanyStatus,
  setPlatformCompanyUserActive,
  updatePlatformCompany,
} from "./platformFns";
import { PLATFORM_ADMIN_REQUIRED } from "./requirePlatformAdmin.server";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

/** عمليات المنصة باسمها، ليمكن تعدادها في فحص واحد. */
const operations = mocks.operations as Record<string, ReturnType<typeof vi.fn>>;

/** يتأكد أن عملية واحدة من عمليات المنصة لم تُستدعى. */
function expectNoOperationCalled(): void {
  for (const operation of Object.values(operations)) {
    expect(operation).not.toHaveBeenCalled();
  }
}

describe("the platform server-function wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lastServerFnOptions = null;
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "test-access-token" } },
    });
  });

  it.each([
    [
      "lists the companies",
      () => fetchPlatformCompanies({ status: "active", limit: 10 }),
      "platformListCompanies",
      { status: "active", limit: 10 },
    ],
    [
      "reads one company",
      () => fetchPlatformCompany({ companyId: COMPANY_ID }),
      "platformGetCompany",
      { companyId: COMPANY_ID },
    ],
    [
      "creates a company",
      () =>
        createPlatformCompany({
          nameAr: "أكمي",
          nameEn: "Acme",
          slug: "acme",
          firstAdmin: { fullName: "Amina", username: "amina" },
        }),
      "platformCreateCompany",
      {
        nameAr: "أكمي",
        nameEn: "Acme",
        slug: "acme",
        firstAdmin: { fullName: "Amina", username: "amina" },
      },
    ],
    [
      "updates a company",
      () => updatePlatformCompany({ companyId: COMPANY_ID, nameEn: "Acme Holding" }),
      "platformUpdateCompany",
      { companyId: COMPANY_ID, nameEn: "Acme Holding" },
    ],
    [
      "changes the status of a company",
      () =>
        setPlatformCompanyStatus({
          companyId: COMPANY_ID,
          status: "suspended",
          reason: "لم تدفع الاشتراك",
        }),
      "platformSetCompanyStatus",
      { companyId: COMPANY_ID, status: "suspended", reason: "لم تدفع الاشتراك" },
    ],
    [
      "lists the accounts of one company",
      () => fetchPlatformCompanyUsers({ companyId: COMPANY_ID }),
      "platformListUsers",
      { companyId: COMPANY_ID },
    ],
    [
      "creates an account",
      () =>
        createPlatformCompanyUser({
          companyId: COMPANY_ID,
          fullName: "Sara",
          role: "accountant",
        }),
      "platformCreateUser",
      { companyId: COMPANY_ID, fullName: "Sara", role: "accountant" },
    ],
    [
      "stops an account",
      () =>
        setPlatformCompanyUserActive({
          companyId: COMPANY_ID,
          userId: USER_ID,
          isActive: false,
        }),
      "platformSetUserActive",
      { companyId: COMPANY_ID, userId: USER_ID, isActive: false },
    ],
    [
      "resets the password of an account",
      () => resetPlatformCompanyUserPassword({ companyId: COMPANY_ID, userId: USER_ID }),
      "platformResetPassword",
      { companyId: COMPANY_ID, userId: USER_ID },
    ],
  ])("%s and hands the input to its operation", async (_label, call, operation, expected) => {
    await call();

    expect(operations[operation]).toHaveBeenCalledWith(expected);
  });

  it("sends the caller's session token with the call", async () => {
    await fetchPlatformCompanies({});

    expect(mocks.lastServerFnOptions?.headers.Authorization).toBe("Bearer test-access-token");
  });

  it("refuses to call the server when the browser holds no session", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null } });

    await expect(fetchPlatformCompanies({})).rejects.toThrow(PLATFORM_ADMIN_REQUIRED);
    expectNoOperationCalled();
  });

  it.each([
    ["a page size below one", () => fetchPlatformCompanies({ limit: 0 })],
    ["a company id that is not a uuid", () => fetchPlatformCompany({ companyId: "not-a-uuid" })],
    [
      "a status change with a reason that is too short",
      () =>
        setPlatformCompanyStatus({
          companyId: COMPANY_ID,
          status: "suspended",
          reason: "ab",
        }),
    ],
    [
      "a user id that is not a uuid",
      () =>
        setPlatformCompanyUserActive({
          companyId: COMPANY_ID,
          userId: "not-a-uuid",
          isActive: false,
        }),
    ],
    [
      "an account without a full name",
      () =>
        createPlatformCompanyUser({
          companyId: COMPANY_ID,
          fullName: "  ",
          role: "readonly",
        }),
    ],
    [
      "a password reset for an account without an id",
      () => resetPlatformCompanyUserPassword({ companyId: COMPANY_ID, userId: "" }),
    ],
  ])("refuses %s before any operation runs", async (_label, call) => {
    await expect(call()).rejects.toThrow();
    expectNoOperationCalled();
  });
});
