import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/i18n/provider";
import { ClassicInvoicesOverview } from "./ClassicInvoicesOverview";
import type { MonthSummaryItem } from "./AnnualKpiRibbon";

const mockSummaryRows: MonthSummaryItem[] = Array.from({ length: 12 }, (_, i) => ({
  month: i + 1,
  count: 10,
  total: 5000,
  paid: i === 0 ? 5000 : 3000,
  outstanding: i === 0 ? 0 : 2000,
  overdue: i === 1 ? 2 : 0,
}));

describe("ClassicInvoicesOverview", () => {
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
    theme: "classic" as const,
    onThemeChange: vi.fn(),
    propertyId: "",
    propertyOptions: [{ value: "p1", label: "PROP-001 — A" }],
    onSelectProperty: vi.fn(),
  };

  /** يبقي العرض الحقيقي للقائمة وشارة المبنى كي تكشف الاختبارات غيابهما. */
  const renderMarkup = (props: ComponentProps<typeof ClassicInvoicesOverview> = defaultProps) => {
    return renderToStaticMarkup(
      <I18nProvider>
        <ClassicInvoicesOverview {...props} />
      </I18nProvider>,
    );
  };

  it("renders all 12 classic month cards with financial figures", () => {
    const markup = renderMarkup();
    expect(markup).toContain("يناير");
    expect(markup).toContain("فبراير");
    expect(markup).toContain("ديسمبر");
    expect(markup).toContain("المدفوع");
    expect(markup).toContain("المتبقي");
  });

  it("renders the theme switcher dropdown allowing switching back to modern", () => {
    const markup = renderMarkup();
    expect(markup).toContain("مظهر العرض");
  });

  it("renders overdue badge for months with overdue accounts", () => {
    const markup = renderMarkup();
    expect(markup).toContain("animate-pulse ring-2 ring-red-400/60");
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

  it("shows the selected building as a chip beside the year select", () => {
    const markup = renderMarkup({
      ...defaultProps,
      propertyId: "p1",
      propertyLabel: "PROP-001 — A",
    });
    expect(markup).toContain("PROP-001 — A");
    expect(markup.indexOf("PROP-001 — A")).toBeGreaterThan(markup.indexOf("2026"));
  });
});
