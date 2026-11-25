import { describe, expect, it } from "vitest";

import {
  formatBillingPeriod,
  formatIsoDateForDisplay,
  formatPaymentDateTime,
  parseDisplayDateToIso,
  displayDatePlaceholder,
} from "./dateDisplay";

describe("dateDisplay", () => {
  it("formats ISO as dd/mm/yyyy in LTR", () => {
    expect(formatIsoDateForDisplay("2026-03-15", "ltr")).toBe("15/03/2026");
  });

  it("formats ISO as yyyy/mm/dd in RTL", () => {
    expect(formatIsoDateForDisplay("2026-03-15", "rtl")).toBe("2026/03/15");
  });

  it("parses LTR display back to ISO", () => {
    expect(parseDisplayDateToIso("15/03/2026", "ltr")).toBe("2026-03-15");
    expect(parseDisplayDateToIso("1/3/2026", "ltr")).toBe("2026-03-01");
  });

  it("parses RTL display back to ISO", () => {
    expect(parseDisplayDateToIso("2026/03/15", "rtl")).toBe("2026-03-15");
  });

  it("rejects invalid calendar dates", () => {
    expect(parseDisplayDateToIso("31/02/2026", "ltr")).toBeNull();
    expect(parseDisplayDateToIso("2026/02/31", "rtl")).toBeNull();
  });

  it("placeholders match rules", () => {
    expect(displayDatePlaceholder("ltr")).toBe("dd/mm/yyyy");
    expect(displayDatePlaceholder("rtl")).toBe("yyyy/mm/dd");
  });

  it("formats billing period as month/year = Month Year", () => {
    expect(formatBillingPeriod(4, 2026, "en")).toBe("4/2026 = April 2026");
  });

  it("appends clock time from created_at to the payment date", () => {
    const text = formatPaymentDateTime("2026-04-15", "2026-04-15T11:30:00.000Z", "ltr", "en");
    expect(text.startsWith("15/04/2026 ")).toBe(true);
    // Time is locale/timezone dependent; require HH:mm-shaped suffix.
    expect(text).toMatch(/15\/04\/2026 \d{2}:\d{2}/);
  });

  it("falls back to date-only when created_at is missing", () => {
    expect(formatPaymentDateTime("2026-04-15", null, "ltr", "en")).toBe("15/04/2026");
  });
});
