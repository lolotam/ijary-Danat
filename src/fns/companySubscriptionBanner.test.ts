import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn().mockImplementation(() => {
    const fn: any = async (input?: { data?: unknown }) => {
      const data = fn._schema ? fn._schema.parse(input?.data) : input?.data;
      return fn._handler({ data, context: fn._context });
    };
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.inputValidator = vi.fn().mockImplementation((schema: any) => {
      fn._schema = schema;
      return fn;
    });
    fn.validator = vi.fn().mockReturnValue(fn);
    fn.handler = vi.fn().mockImplementation((handler: any) => {
      fn._handler = handler;
      return fn;
    });
    return fn;
  }),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));

import { companySubscriptionBanner, subscriptionBannerFor } from "@/fns/companySubscriptionBanner";
import type { CompanySubscriptionRow } from "@/platform/subscriptions";

/** ظهر يوم الخميس 2026-11-27 بتوقيت الكويت. */
const NOW = new Date("2026-11-27T08:00:00.000Z");

/** صف اشتراك حالي صالح، يُعدَّل تاريخ تجديده في كل حالة. */
function subscription(renewalDate: string): CompanySubscriptionRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    company_id: "11111111-1111-4111-8111-111111111111",
    plan_name: "Business",
    price: 100,
    period_start: "2026-01-01",
    renewal_date: renewalDate,
    status: "active",
    note: null,
    recorded_by: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("subscriptionBannerFor (T119)", () => {
  const CASES = [
    { name: "14 days", renewalDate: "2026-12-11", daysLeft: 14, overdue: false },
    { name: "7 days", renewalDate: "2026-12-04", daysLeft: 7, overdue: false },
    { name: "1 day", renewalDate: "2026-11-28", daysLeft: 1, overdue: false },
    { name: "overdue", renewalDate: "2026-11-24", daysLeft: -3, overdue: true },
  ] as const;

  test.each(CASES)(
    "reports $name from the current renewal date",
    ({ renewalDate, daysLeft, overdue }) => {
      expect(subscriptionBannerFor(subscription(renewalDate), NOW)).toEqual({
        daysLeft,
        endsOn: renewalDate,
        overdue,
      });
    },
  );

  test("returns null when the company has no subscription record", () => {
    expect(subscriptionBannerFor(null, NOW)).toBeNull();
  });
});

describe("companySubscriptionBanner (T119)", () => {
  const fromMock = vi.fn();

  beforeEach(() => {
    fromMock.mockReset();
    (companySubscriptionBanner as any)._context = {
      userId: "22222222-2222-4222-8222-222222222222",
      supabase: { from: fromMock },
    };
  });

  test("reads the company's current subscription through the caller's RLS client", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: subscription("2026-12-04"),
      error: null,
    });
    const query = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle,
    };
    fromMock.mockReturnValue(query);
    // The server function reads the real clock; pin it so "7 days left" stays true.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);

    const result = await companySubscriptionBanner().finally(() => vi.useRealTimers());

    expect(fromMock).toHaveBeenCalledWith("company_subscriptions");
    expect(query.order).toHaveBeenCalledWith("period_start", { ascending: false });
    expect(result).toEqual({ daysLeft: 7, endsOn: "2026-12-04", overdue: false });
  });

  test("raises when the subscription lookup fails", async () => {
    fromMock.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi
        .fn()
        .mockResolvedValue({ data: null, error: { message: "permission denied" } }),
    });

    await expect(companySubscriptionBanner()).rejects.toThrow(
      "company_subscriptions lookup failed: permission denied",
    );
  });
});
