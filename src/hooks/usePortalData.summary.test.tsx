/**
 * @vitest-environment jsdom
 *
 * ملخص فواتير البوابة: إجمالي المتأخر يجمع المتأخرة فقط، لا كل المستحق.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invoiceRows = vi.hoisted(() => ({
  rows: [] as Array<{ balance: number; due_date: string; state: string }>,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "invoices") throw new Error(`unexpected table ${table}`);
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        gt: () => chain,
        order: () => Promise.resolve({ data: invoiceRows.rows, error: null }),
      };
      return chain;
    },
  },
}));

const { usePortalInvoiceSummary } = await import("@/hooks/usePortalData");

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let seen: { overdueCount?: number; overdueTotal?: number; nextDue?: string | null } = {};

/** مسبار يعرض الملخص الحقيقي للخطاف كنص قابل للفحص. */
function Probe() {
  const summary = usePortalInvoiceSummary("tenant-1", null);
  if (summary.data) seen = summary.data;
  return (
    <div>
      <span data-testid="count">{summary.data?.overdueCount ?? "…"}</span>
      <span data-testid="total">{summary.data?.overdueTotal ?? "…"}</span>
      <span data-testid="next">{summary.data?.nextDue ?? "none"}</span>
    </div>
  );
}

/** يركّب المسبار داخل مزوّد استعلام بلا إعادة محاولة. */
function mount(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });
}

/** ينتظر حتى يعرض المسبار القيمة المتوقعة. */
async function waitForProbe(testId: string, expected: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (container.querySelector(`[data-testid='${testId}']`)?.textContent === expected) return;
  }
  throw new Error(
    `timed out waiting for ${testId}=${expected}, got ${container.querySelector(`[data-testid='${testId}']`)?.textContent}`,
  );
}

beforeEach(() => {
  seen = {};
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
});

describe("usePortalInvoiceSummary overdue total", () => {
  it("sums only overdue balances, ignoring due and partially-paid rows", async () => {
    // A `due` row with a balance is the trap: summing every outstanding row
    // would show the tenant a total the count card does not share.
    invoiceRows.rows = [
      { balance: 100, due_date: "2026-01-01", state: "overdue" },
      { balance: 75.5, due_date: "2026-02-01", state: "overdue" },
      { balance: 500, due_date: "2026-03-01", state: "due" },
      { balance: 50, due_date: "2026-01-15", state: "partially_paid" },
    ];
    mount();

    await waitForProbe("count", "2");
    await waitForProbe("total", "175.5");
    await waitForProbe("next", "2026-01-01");
    expect(seen).toMatchObject({ overdueCount: 2, overdueTotal: 175.5 });
  });

  it("reports zero, not NaN, when nothing is overdue", async () => {
    invoiceRows.rows = [{ balance: 500, due_date: "2026-03-01", state: "due" }];
    mount();

    await waitForProbe("count", "0");
    await waitForProbe("total", "0");
  });
});
