import { describe, expect, it } from "vitest";

import { MAX_TIMER_DELAY_MS, currentPeriodStart, msUntilNextKuwaitMonth } from "@/lib/periodStart";

describe("currentPeriodStart", () => {
  it.each([
    // Kuwait is UTC+3 year-round, so the last three hours of a UTC month
    // already belong to the next month there — the case that made a naive
    // UTC implementation serve last month's totals on the 1st.
    ["2026-08-31T21:30:00Z", "2026-09-01"],
    ["2026-08-31T20:59:00Z", "2026-08-01"],
    ["2026-09-14T10:00:00Z", "2026-09-01"],
    ["2026-12-31T21:00:00Z", "2027-01-01"],
  ])("%s in Kuwait falls in the month starting %s", (instant, expected) => {
    expect(currentPeriodStart(new Date(instant))).toBe(expected);
  });
});

describe("msUntilNextKuwaitMonth", () => {
  it.each([
    // 21:00 UTC on the last day of a month is midnight in Kuwait.
    ["2026-09-30T20:59:00Z", 60_000],
    ["2026-09-14T21:00:00Z", 16 * 24 * 60 * 60 * 1000],
    ["2026-12-31T20:00:00Z", 60 * 60 * 1000],
  ])("%s waits until the Kuwait month turns", (instant, expected) => {
    expect(msUntilNextKuwaitMonth(new Date(instant))).toBe(expected);
  });

  it("at the boundary itself the next wake-up is the following month, not zero", () => {
    // 21:00 UTC IS the first of October in Kuwait, so the wait is all of
    // October (31 days) rather than a busy-loop of zero-delay timers.
    expect(msUntilNextKuwaitMonth(new Date("2026-09-30T21:00:00Z"))).toBe(31 * 24 * 60 * 60 * 1000);
  });
});

describe("month-boundary waits against the browser timer limit", () => {
  it("a full 31-day month exceeds what setTimeout can hold in one go", () => {
    // The reason useCurrentPeriodStart chunks the wait: on the first of a long
    // month the remaining time is larger than a 32-bit signed delay, and a
    // single setTimeout with that delay fires immediately instead.
    const atMonthStart = msUntilNextKuwaitMonth(new Date("2026-09-30T21:00:00Z"));
    expect(atMonthStart).toBeGreaterThan(MAX_TIMER_DELAY_MS);
  });

  it("the wait shrinks below the limit well before the boundary", () => {
    expect(msUntilNextKuwaitMonth(new Date("2026-10-20T21:00:00Z"))).toBeLessThan(
      MAX_TIMER_DELAY_MS,
    );
  });
});
