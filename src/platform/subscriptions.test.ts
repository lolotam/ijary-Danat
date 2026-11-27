import { beforeEach, describe, expect, it, vi } from "vitest";

import { addCalendarDays, companyCalendarDate } from "@/jobs/catalog";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const RECORD_INPUT = {
  companyId: COMPANY_ID,
  planName: "Business",
  price: 125.5,
  periodStart: "2026-11-27",
  renewalDate: "2026-12-11",
  status: "active" as const,
  note: "سنة كاملة",
};

const mocks = vi.hoisted(() => ({
  isAdmin: true,
  subscriptions: [] as Record<string, unknown>[],
  auditRows: [] as Record<string, unknown>[],
  subscriptionError: null as { message: string } | null,
  from: vi.fn(),
}));

/**
 * سلسلة قراءة مُرشَّحة تحترم شرط الشركة وتُعيد النتائج مرتبة.
 */
function readQuery(rows: Record<string, unknown>[]) {
  let filtered = rows;
  const query = {
    eq: (column: string, value: unknown) => {
      filtered = filtered.filter((row) => row[column] === value);
      return query;
    },
    order: () => query,
    limit: () => query,
    maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: filtered, error: null }).then(resolve),
  };
  return query;
}

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
      if (table === "company_subscriptions") {
        return {
          insert: (row: Record<string, unknown>) => {
            const error = mocks.subscriptionError;
            let inserted: Record<string, unknown> | null = null;
            if (!error) {
              inserted = {
                ...row,
                id: "33333333-3333-4333-8333-333333333333",
                created_at: "2026-11-27T08:00:00.000Z",
                note: row.note ?? null,
                recorded_by: row.recorded_by ?? null,
              };
              mocks.subscriptions.push(inserted);
            }
            return { select: () => ({ single: async () => ({ data: inserted, error }) }) };
          },
          select: () => {
            if (!mocks.subscriptionError) return readQuery(mocks.subscriptions);
            const failed = {
              order: () => failed,
              then: (resolve: (value: unknown) => unknown) =>
                Promise.resolve({ data: null, error: mocks.subscriptionError }).then(resolve),
            };
            return failed;
          },
        };
      }
      return {
        insert: async (row: Record<string, unknown>) => {
          mocks.auditRows.push(row);
          return { data: null, error: null };
        },
        select: () => readQuery(mocks.auditRows),
      };
    },
  },
}));

import {
  platformDueSubscriptionReminders,
  platformListSubscriptions,
  platformRecordSubscription,
} from "./subscriptions";

/** يضبط ما يقرره حارس المنصة للمستدعي في هذا الاختبار. */
function asCaller(admin: boolean): void {
  mocks.isAdmin = admin;
}

beforeEach(() => {
  mocks.isAdmin = true;
  mocks.subscriptions = [];
  mocks.auditRows = [];
  mocks.subscriptionError = null;
  mocks.from.mockReset();
});

describe("platformRecordSubscription (T117)", () => {
  it("refuses a caller without the platform admin claim before writing", async () => {
    asCaller(false);
    await expect(platformRecordSubscription(RECORD_INPUT)).rejects.toThrow(
      "PLATFORM_ADMIN_REQUIRED",
    );
    expect(mocks.subscriptions).toEqual([]);
    expect(mocks.auditRows).toEqual([]);
  });

  it.each([
    { field: "price", value: -1 },
    { field: "renewalDate", value: "2026-11-01" },
    { field: "planName", value: "" },
  ])("refuses an invalid $field before writing", async ({ field, value }) => {
    await expect(
      platformRecordSubscription({
        ...RECORD_INPUT,
        [field]: value,
      }),
    ).rejects.toThrow();
    expect(mocks.subscriptions).toEqual([]);
  });

  it("appends one row and writes one audit entry naming the recorder", async () => {
    const row = await platformRecordSubscription(RECORD_INPUT);

    expect(row).toMatchObject({
      company_id: COMPANY_ID,
      plan_name: "Business",
      price: 125.5,
      period_start: "2026-11-27",
      renewal_date: "2026-12-11",
      status: "active",
      recorded_by: ACTOR_ID,
    });
    expect(mocks.subscriptions).toHaveLength(1);
    expect(mocks.auditRows).toHaveLength(1);
    expect(mocks.auditRows[0]).toMatchObject({
      action: "subscription.record",
      entity: "company_subscription",
      entity_id: row.id,
      actor_id: ACTOR_ID,
      company_id: COMPANY_ID,
    });
  });

  it("propagates a failed insert instead of auditing a row that was never written", async () => {
    mocks.subscriptionError = { message: "permission denied" };

    await expect(platformRecordSubscription(RECORD_INPUT)).rejects.toThrow(
      "company_subscriptions insert failed: permission denied",
    );
    expect(mocks.auditRows).toEqual([]);
  });
});

describe("platformListSubscriptions (T117)", () => {
  it("returns only the requested company's history, newest period first", async () => {
    mocks.subscriptions = [
      {
        id: "33333333-3333-4333-8333-333333333333",
        company_id: COMPANY_ID,
        plan_name: "Business",
        period_start: "2026-12-11",
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        company_id: "99999999-9999-4999-8999-999999999999",
        plan_name: "Other company",
        period_start: "2027-01-01",
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        company_id: COMPANY_ID,
        plan_name: "Starter",
        period_start: "2026-01-01",
      },
    ];

    const rows = await platformListSubscriptions(COMPANY_ID);

    expect(rows.map((row) => row.plan_name)).toEqual(["Business", "Starter"]);
  });

  it("refuses a caller without the platform admin claim", async () => {
    asCaller(false);
    await expect(platformListSubscriptions(COMPANY_ID)).rejects.toThrow("PLATFORM_ADMIN_REQUIRED");
  });
});

describe("platformDueSubscriptionReminders (T118)", () => {
  const NOW = new Date("2026-11-27T08:00:00.000Z");
  const today = companyCalendarDate(NOW);

  /** سطر اشتراك حالي، يُعدَّل تاريخ تجديده وحالته في كل حالة. */
  function currentRow(renewalDate: string, status = "active") {
    return {
      company_id: COMPANY_ID,
      period_start: "2026-01-01",
      renewal_date: renewalDate,
      status,
    };
  }

  it.each([
    { days: 14, mark: 14 },
    { days: 7, mark: 7 },
    { days: 1, mark: 1 },
    { days: -3, mark: -1 },
  ])("turns a renewal $days days away into the $mark mark", async ({ days, mark }) => {
    mocks.subscriptions = [currentRow(addCalendarDays(today, days))];

    expect(await platformDueSubscriptionReminders(NOW)).toEqual([
      { companyId: COMPANY_ID, renewalDate: addCalendarDays(today, days), offsetDays: mark },
    ]);
  });

  it("ignores a cancelled current row and a superseded row that still has a mark", async () => {
    const otherCompany = "99999999-9999-4999-8999-999999999999";
    mocks.subscriptions = [
      currentRow(addCalendarDays(today, 14), "cancelled"),
      { ...currentRow(addCalendarDays(today, 30)), company_id: otherCompany },
      { ...currentRow(addCalendarDays(today, 7)), company_id: otherCompany },
    ];

    expect(await platformDueSubscriptionReminders(NOW)).toEqual([]);
  });

  it("propagates a failed subscription lookup", async () => {
    mocks.subscriptionError = { message: "permission denied" };

    await expect(platformDueSubscriptionReminders(NOW)).rejects.toThrow(
      "company_subscriptions reminder lookup failed: permission denied",
    );
  });
});
