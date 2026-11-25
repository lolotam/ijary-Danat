import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

import {
  DashboardKpiCards,
  DepositsKpiCards,
  ExpensesKpiCards,
  UnitsKpiCards,
} from "@/components/admin/ownedPageKpis";
import { dictionaries } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

const emptyDeposits = {
  total: { amount: 10, count: 1 },
  confirmed: { amount: 8, count: 1 },
  pending: { amount: 2, count: 1 },
  thisMonth: { amount: 4, count: 1 },
};

const emptyExpenses = {
  total: { amount: 10, count: 1 },
  approved: { amount: 8, count: 1 },
  pending: { amount: 2, count: 1 },
  thisMonth: { amount: 4, count: 1 },
};

const ZERO_KPIS = {
  invoicesOutstanding: 0,
  invoicesFuture: 0,
  futureCount: 0,
  invoicesPaid: 0,
  invoicesOverdue: 0,
  overdueCount: 0,
  paymentsThisMonth: 0,
  tenants: 0,
  activeTenants: 0,
  units: 0,
  occupiedUnits: 0,
  properties: 0,
  employees: 0,
  salariesPaid: 0,
};

const unitsSummary = {
  total: 5,
  occupied: 3,
  vacant: 2,
  underMaintenance: 0,
  rentPotential: 100,
};

/**
 * يرسم مجموعة بطاقات الصفحة داخل مزوّد الترجمة الافتراضي (العربية).
 */
function renderGroup(node: ReactElement): string {
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
}

describe("page KPI gating", () => {
  it("renders the dashboard outstanding card only while it is visible", () => {
    const shown = renderGroup(
      <DashboardKpiCards isCardVisible={(id) => id === "dashboard.outstanding"} />,
    );
    expect(shown).toContain("الرصيد المستحق");
    expect(shown).not.toContain("المقبوضات هذا الشهر");

    const hidden = renderGroup(<DashboardKpiCards isCardVisible={() => false} />);
    expect(hidden).not.toContain("الرصيد المستحق");
  });

  it("shows overdue invoices as a count, with their KWD total as the hint", () => {
    // Production 2026-09-24: the card printed 205,195 with no unit — the KWD
    // total of 106 overdue invoices — so it read as 205,195 invoices.
    const html = renderGroup(
      <DashboardKpiCards
        kpis={{ ...ZERO_KPIS, overdueCount: 106, invoicesOverdue: 205195 }}
        isCardVisible={(id) => id === "dashboard.overdue"}
      />,
    );
    expect(html).toContain(">106<");
    expect(html).not.toContain(">205,195<");
    expect(html).toMatch(/205,195[^<]*(KWD|د\.ك)/);
  });

  it("shows the not-yet-due contract balance beside the due-to-date balance", () => {
    const html = renderGroup(
      <DashboardKpiCards
        kpis={{
          ...ZERO_KPIS,
          invoicesOutstanding: 205195,
          invoicesFuture: 10789585,
          futureCount: 3238,
        }}
        isCardVisible={(id) => id === "dashboard.outstanding"}
      />,
    );
    expect(html).toMatch(/205,195/);
    expect(html).toMatch(/10,789,585[^<]*(KWD|د\.ك)/);
    expect(html).toContain("3,238");
  });

  it("renders the units total card only while it is visible", () => {
    const shown = renderGroup(
      <UnitsKpiCards summary={unitsSummary} isCardVisible={(id) => id === "units.total"} />,
    );
    expect(shown).toContain(dictionaries.ar["summary.units.total"]);
    expect(shown).not.toContain(dictionaries.ar["summary.units.occupied"]);

    const hidden = renderGroup(
      <UnitsKpiCards summary={unitsSummary} isCardVisible={() => false} />,
    );
    expect(hidden).not.toContain(dictionaries.ar["summary.units.total"]);
  });

  it("renders the deposits total card only while it is visible", () => {
    const shown = renderGroup(
      <DepositsKpiCards summary={emptyDeposits} isCardVisible={(id) => id === "deposits.total"} />,
    );
    expect(shown).toContain(dictionaries.ar["summary.deposits.total"]);
    expect(shown).not.toContain(dictionaries.ar["summary.deposits.confirmed"]);

    const hidden = renderGroup(
      <DepositsKpiCards summary={emptyDeposits} isCardVisible={() => false} />,
    );
    expect(hidden).not.toContain(dictionaries.ar["summary.deposits.total"]);
  });

  it("renders the expenses total card only while it is visible", () => {
    const shown = renderGroup(
      <ExpensesKpiCards summary={emptyExpenses} isCardVisible={(id) => id === "expenses.total"} />,
    );
    expect(shown).toContain(dictionaries.ar["summary.expenses.total"]);
    expect(shown).not.toContain(dictionaries.ar["summary.expenses.approved"]);

    const hidden = renderGroup(
      <ExpensesKpiCards summary={emptyExpenses} isCardVisible={() => false} />,
    );
    expect(hidden).not.toContain(dictionaries.ar["summary.expenses.total"]);
  });
});
