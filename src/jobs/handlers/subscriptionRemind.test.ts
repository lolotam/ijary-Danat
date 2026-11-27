import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addCalendarDays,
  companyCalendarDate,
  SUBSCRIPTION_OVERDUE_MARK,
  SUBSCRIPTION_REMINDER_MARKS,
  type JobPayload,
} from "@/jobs/catalog";

/** اللحظة التي تُحسب عليها العلامات في كل اختبار، بتوقيت الشركة. */
const NOW = new Date("2026-11-27T08:00:00.000Z");
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const SUBSCRIPTION_ID = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  subscriptionRow: null as Record<string, unknown> | null,
  existingAuditRows: [] as Record<string, unknown>[],
  insertedAuditRows: [] as Record<string, unknown>[],
  companyFrom: vi.fn(),
}));

/**
 * باني سلسلة استعلام مقيّد بشركة واحدة، ينتهي بصف واحد أو لا شيء.
 */
function companyQuery() {
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    limit: () => query,
    maybeSingle: async () => ({ data: mocks.subscriptionRow, error: null }),
  };
  return query;
}

/**
 * باني سلسلة قراءة سجل المنصة: كل شرط يبقي السلسلة قابلة للانتظار.
 *
 * The chain is awaitable because the production reader awaits the filtered
 * query directly; returning a plain promise here would hide a missing `eq`.
 */
function auditReadQuery() {
  const query = {
    eq: () => query,
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: mocks.existingAuditRows, error: null }).then(resolve),
  };
  return query;
}

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({ from: mocks.companyFrom }),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      return {
        select: () => auditReadQuery(),
        insert: async (row: Record<string, unknown>) => {
          mocks.insertedAuditRows.push(row);
          return { data: null, error: null };
        },
      };
    },
  },
}));

import { createSubscriptionRemindHandler } from "./subscriptionRemind";

/** حمولة علامة تذكير صحيحة لمعرّف الشركة والتاريخ الممرَّرين. */
function payloadFor(renewalDate: string, offsetDays: number): JobPayload<"subscription.remind"> {
  return { renewalDate, offsetDays };
}

/** يستدعي المعالج بحمولة علامة واحدة ويعيد نتيجته. */
async function runReminder(renewalDate: string, offsetDays: number) {
  const handler = createSubscriptionRemindHandler(() => NOW);
  return handler({
    jobRequestId: "44444444-4444-4444-8444-444444444444",
    companyId: COMPANY_ID,
    payload: payloadFor(renewalDate, offsetDays),
    attempt: 1,
  });
}

beforeEach(() => {
  mocks.subscriptionRow = {
    id: SUBSCRIPTION_ID,
    company_id: COMPANY_ID,
    plan_name: "Business",
    price: 120,
    period_start: "2026-01-01",
    renewal_date: addCalendarDays(companyCalendarDate(NOW), 14),
    status: "active",
    note: null,
    recorded_by: null,
    created_at: NOW.toISOString(),
  };
  mocks.existingAuditRows = [];
  mocks.insertedAuditRows = [];
  mocks.companyFrom.mockReset();
  mocks.companyFrom.mockImplementation(() => companyQuery());
});

describe("subscription.remind records one warning per renewal mark (T115)", () => {
  const today = companyCalendarDate(NOW);

  it.each(SUBSCRIPTION_REMINDER_MARKS)(
    "at the %i day mark it records one warning naming the renewal date",
    async (offsetDays) => {
      const renewalDate = addCalendarDays(today, offsetDays);
      mocks.subscriptionRow = { ...mocks.subscriptionRow, renewal_date: renewalDate };

      const result = (await runReminder(renewalDate, offsetDays)) as Record<string, unknown>;

      expect(result).toMatchObject({
        companyId: COMPANY_ID,
        subscriptionId: SUBSCRIPTION_ID,
        renewalDate,
        offsetDays,
        daysLeft: offsetDays,
        reminded: true,
      });
      expect(mocks.insertedAuditRows).toHaveLength(1);
      expect(mocks.insertedAuditRows[0]).toMatchObject({
        action: "subscription.remind",
        entity: "company_subscription",
        entity_id: SUBSCRIPTION_ID,
        company_id: COMPANY_ID,
      });
      expect((mocks.insertedAuditRows[0].after as Record<string, unknown>).overdue).toBe(false);
    },
  );

  it("a renewal already past records a warning flagged overdue", async () => {
    const renewalDate = addCalendarDays(today, -3);
    mocks.subscriptionRow = { ...mocks.subscriptionRow, renewal_date: renewalDate };

    const result = (await runReminder(renewalDate, SUBSCRIPTION_OVERDUE_MARK)) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({
      overdue: true,
      daysLeft: -3,
      reminded: true,
    });
    expect((mocks.insertedAuditRows[0].after as Record<string, unknown>).overdue).toBe(true);
  });

  it("a second run for the same mark records nothing new", async () => {
    const renewalDate = addCalendarDays(today, 7);
    mocks.subscriptionRow = { ...mocks.subscriptionRow, renewal_date: renewalDate };
    mocks.existingAuditRows = [
      {
        id: "55555555-5555-4555-8555-555555555555",
        action: "subscription.remind",
        company_id: COMPANY_ID,
        entity_id: SUBSCRIPTION_ID,
        after: { renewalDate, offsetDays: 7 },
      },
    ];

    const result = (await runReminder(renewalDate, 7)) as Record<string, unknown>;

    expect(result.reminded).toBe(false);
    expect(result.skipped).toBe("already_reminded");
    expect(mocks.insertedAuditRows).toEqual([]);
  });

  it("a job whose renewal date no longer matches the mark records nothing", async () => {
    const renewalDate = addCalendarDays(today, 1);
    mocks.subscriptionRow = { ...mocks.subscriptionRow, renewal_date: renewalDate };

    const result = (await runReminder(renewalDate, 14)) as Record<string, unknown>;

    expect(result.skipped).toBe("stale_mark");
    expect(mocks.insertedAuditRows).toEqual([]);
  });
});
