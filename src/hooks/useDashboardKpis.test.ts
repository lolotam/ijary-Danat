/**
 * مؤشرات لوحة التحكم تُقرأ من استدعاء RPC واحد يجري المجموعات في الخادم.
 *
 * Audit H10 history: this hook used to sum invoices in the browser, and
 * PostgREST answers an unranged read with its first 1,000 rows and no
 * error, so past that line the sums quietly stopped being the portfolio's
 * money. Migration 219 moved the arithmetic server-side into
 * `get_dashboard_aggregates()`; these tests pin the client half — a single
 * RPC call, the snake_case → KpiSet mapping, and error propagation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (fn: string) => rpc(fn) },
}));

const { fetchDashboardKpis } = await import("@/hooks/useDashboardKpis");

beforeEach(() => {
  rpc.mockReset();
});

describe("dashboard money KPIs", () => {
  it("reads the figures from one get_dashboard_aggregates call", async () => {
    rpc.mockResolvedValue({ data: {}, error: null });

    await fetchDashboardKpis();

    // One RPC instead of the nine queries the pre-H10 fix ran — that is
    // the whole point of migration 219.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("get_dashboard_aggregates");
  });

  it("maps every snake_case RPC key onto its KpiSet field", async () => {
    rpc.mockResolvedValue({
      data: {
        outstanding: "1500.5",
        future_outstanding: "98000",
        future_count: "12",
        paid: 42,
        overdue_amount: "7.25",
        overdue_count: 3,
        payments_this_month: "120",
        tenants: 9,
        active_tenants: "8",
        units: 40,
        occupied_units: "36",
        properties: 5,
        employees: "12",
        salaries_paid: 3000,
      },
      error: null,
    });

    const kpis = await fetchDashboardKpis();

    expect(kpis).toEqual({
      invoicesOutstanding: 1500.5,
      invoicesFuture: 98000,
      futureCount: 12,
      invoicesPaid: 42,
      invoicesOverdue: 7.25,
      paymentsThisMonth: 120,
      tenants: 9,
      activeTenants: 8,
      units: 40,
      occupiedUnits: 36,
      properties: 5,
      overdueCount: 3,
      employees: 12,
      salariesPaid: 3000,
    });
  });

  it("propagates the RPC error instead of returning zeroes", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "relation missing" } });

    await expect(fetchDashboardKpis()).rejects.toMatchObject({
      message: "relation missing",
    });
  });

  it("maps a null payload with no error to zeroes rather than NaN", async () => {
    // A successful call that returns no row (RLS-filtered to nothing, or an
    // empty portfolio): every card must read 0, never NaN from Number(undefined).
    rpc.mockResolvedValue({ data: null, error: null });

    const kpis = await fetchDashboardKpis();

    expect(kpis).toEqual({
      invoicesOutstanding: 0,
      invoicesFuture: 0,
      futureCount: 0,
      invoicesPaid: 0,
      invoicesOverdue: 0,
      paymentsThisMonth: 0,
      tenants: 0,
      activeTenants: 0,
      units: 0,
      occupiedUnits: 0,
      properties: 0,
      overdueCount: 0,
      employees: 0,
      salariesPaid: 0,
    });
    for (const value of Object.values(kpis)) {
      expect(Number.isNaN(value)).toBe(false);
    }
  });
});
