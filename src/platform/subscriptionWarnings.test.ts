import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addCalendarDays } from "@/jobs/catalog";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COMPANY_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TODAY = "2026-11-27";

/** سطر اشتراك كما يعرضه الاستعلام، مع تاريخ بدء يحدّد أيّ سطر هو الأحدث. */
interface FakeSubscription {
  company_id: string;
  plan_name: string;
  period_start: string;
  renewal_date: string;
  status: string;
}

const mocks = vi.hoisted(() => ({
  isAdmin: true,
  subscriptions: [] as FakeSubscription[],
  companies: [] as Array<{ id: string; name_ar: string; name_en: string }>,
  from: vi.fn(),
}));

vi.mock("./requirePlatformAdmin.server", () => ({
  requirePlatformAdmin: async () => {
    if (!mocks.isAdmin) throw new Error("PLATFORM_ADMIN_REQUIRED");
    return { userId: ACTOR_ID };
  },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      mocks.from(table);
      if (table === "companies") {
        return {
          select: () => ({
            in: (_column: string, ids: string[]) => ({
              then: (resolve: (value: unknown) => unknown) =>
                Promise.resolve({
                  data: mocks.companies.filter((company) => ids.includes(company.id)),
                  error: null,
                }).then(resolve),
            }),
          }),
        };
      }
      const query = {
        select: () => query,
        order: () => query,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: mocks.subscriptions, error: null }).then(resolve),
      };
      return query;
    },
  },
}));

import { platformListRenewalWarnings } from "./subscriptions";

/** يبني سطر اشتراك حالي لشركة بتاريخ تجديد وحالة محددين. */
function subscription(
  companyId: string,
  renewalDate: string,
  status = "active",
  periodStart = "2026-01-01",
): FakeSubscription {
  return {
    company_id: companyId,
    plan_name: "Business",
    period_start: periodStart,
    renewal_date: renewalDate,
    status,
  };
}

/** يضبط أسماء الشركات التي تعيدها قاعدة البيانات الوهمية. */
function setCompanyNames(): void {
  mocks.companies = [
    { id: COMPANY_A, name_ar: "ألف", name_en: "Alpha" },
    { id: COMPANY_B, name_ar: "باء", name_en: "Beta" },
    { id: COMPANY_C, name_ar: "جيم", name_en: "Gamma" },
  ];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-27T08:00:00.000Z"));
  mocks.isAdmin = true;
  mocks.subscriptions = [];
  mocks.companies = [];
  mocks.from.mockReset();
  setCompanyNames();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("platformListRenewalWarnings (T118)", () => {
  it("lists overdue renewals before upcoming ones and names each company", async () => {
    mocks.subscriptions = [
      subscription(COMPANY_B, addCalendarDays(TODAY, 14)),
      subscription(COMPANY_C, addCalendarDays(TODAY, -3)),
      subscription(COMPANY_A, addCalendarDays(TODAY, -1)),
    ];

    const warnings = await platformListRenewalWarnings();

    expect(warnings.map((warning) => warning.companyId)).toEqual([COMPANY_C, COMPANY_A, COMPANY_B]);
    expect(warnings.map((warning) => warning.daysLeft)).toEqual([-3, -1, 14]);
    expect(warnings[0]).toMatchObject({
      companyNameAr: "جيم",
      companyNameEn: "Gamma",
      renewalDate: addCalendarDays(TODAY, -3),
    });
  });

  it("leaves out a renewal past the 14-day window and a cancelled current row", async () => {
    mocks.subscriptions = [
      subscription(COMPANY_A, addCalendarDays(TODAY, 15)),
      subscription(COMPANY_B, addCalendarDays(TODAY, 7), "cancelled"),
    ];

    expect(await platformListRenewalWarnings()).toEqual([]);
  });

  it("uses the latest row, so a superseded in-window renewal does not warn", async () => {
    // الاستعلام يرتّب الصفوف بالفترة الأحدث أولاً، فالصف الأول هو الحالي.
    mocks.subscriptions = [
      subscription(COMPANY_A, addCalendarDays(TODAY, 30), "active", "2026-02-01"),
      subscription(COMPANY_A, addCalendarDays(TODAY, 7), "active", "2026-01-01"),
    ];

    expect(await platformListRenewalWarnings()).toEqual([]);
  });

  it("refuses a caller without the platform admin claim", async () => {
    mocks.isAdmin = false;

    await expect(platformListRenewalWarnings()).rejects.toThrow("PLATFORM_ADMIN_REQUIRED");
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
