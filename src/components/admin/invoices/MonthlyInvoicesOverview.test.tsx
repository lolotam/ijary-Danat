import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/i18n/provider";
import { MonthlyInvoicesOverview } from "./MonthlyInvoicesOverview";
import type { MonthSummaryItem } from "./AnnualKpiRibbon";

const mockSummaryRows: MonthSummaryItem[] = Array.from({ length: 12 }, (_, i) => ({
  month: i + 1,
  count: 10,
  total: 5000,
  paid: i === 0 ? 5000 : 3000,
  outstanding: i === 0 ? 0 : 2000,
  overdue: i === 1 ? 2 : 0,
}));

describe("MonthlyInvoicesOverview", () => {
  const defaultProps = {
    year: 2026,
    years: [2026, 2025, 2024],
    summaryRows: mockSummaryRows,
    isLoading: false,
    isError: false,
    canCreate: true,
    onSelectYear: vi.fn(),
    onSelectMonth: vi.fn(),
    onAddYear: vi.fn().mockResolvedValue(undefined),
    isAddYearPending: false,
    theme: "modern" as const,
    onThemeChange: vi.fn(),
    propertyId: "",
    propertyOptions: [{ value: "p1", label: "PROP-001 — A" }],
    onSelectProperty: vi.fn(),
  };

  /** يبقي العرض الحقيقي للقائمة والشريط كي تكشف الاختبارات فقدان مرشح المبنى. */
  const renderMarkup = (props: ComponentProps<typeof MonthlyInvoicesOverview> = defaultProps) => {
    return renderToStaticMarkup(
      <I18nProvider>
        <MonthlyInvoicesOverview {...props} />
      </I18nProvider>,
    );
  };

  it("renders the annual KPI banner with aggregate totals and currency", () => {
    const markup = renderMarkup();
    expect(markup).toContain("الأداء المالي السنوي");
    expect(markup).toContain("120 فاتورة");
    expect(markup).toContain("2026");
    expect(markup).toContain("د.ك");
  });

  it("renders month cards with collection efficiency metrics and formatting", () => {
    const markup = renderMarkup();
    expect(markup).toContain("يناير");
    expect(markup).toContain("فبراير");
    expect(markup).toContain("ديسمبر");
    expect(markup).toContain("نسبة التحصيل");
    expect(markup).toContain("عرض التفاصيل");
  });

  it("renders overdue indicators when overdue invoices exist in a month", () => {
    const markup = renderMarkup();
    expect(markup).toContain("2 الفواتير المتأخرة");
  });

  it("renders 100% fully collected badge when a month has zero outstanding balance", () => {
    const markup = renderMarkup();
    expect(markup).toContain("مكتمل التحصيل");
  });

  it("renders year dropdown options and add year trigger", () => {
    const markup = renderMarkup();
    expect(markup).toContain("إضافة سنة");
    expect(markup).toContain("السنة السابقة");
    expect(markup).toContain("السنة التالية");
  });

  it("renders the theme switcher dropdown in the toolbar", () => {
    const markup = renderMarkup();
    expect(markup).toContain("مظهر العرض");
  });

  it("renders the property filter inline, labelled Property rather than Building", () => {
    // The toolbar's other controls carry no stacked label; a <label> above this
    // trigger is what pushed it half a row below the year select.
    const markup = renderMarkup();
    expect(markup).toMatch(
      /<button[^>]*aria-label="العقار"[^>]*id="invoices-property"|<button[^>]*id="invoices-property"[^>]*aria-label="العقار"/,
    );
    expect(markup).not.toContain('for="invoices-property"');
    expect(markup).not.toContain("المبنى");
  });

  it("renders the property filter right after the add-year trigger", () => {
    // Radix never mounts SelectContent in static markup, so presence is
    // asserted on the trigger id the FilterSelect carries.
    const markup = renderMarkup();
    expect(markup).toContain('id="invoices-property"');
    expect(markup.indexOf('id="invoices-property"')).toBeGreaterThan(markup.indexOf("إضافة سنة"));
  });

  it("shows the selected building beside the year chip in the KPI ribbon", () => {
    const markup = renderMarkup({
      ...defaultProps,
      propertyId: "p1",
      propertyLabel: "PROP-001 — A",
    });
    expect(markup).toContain("PROP-001 — A");
    expect(markup.indexOf("PROP-001 — A")).toBeGreaterThan(markup.indexOf("2026"));
  });
});
