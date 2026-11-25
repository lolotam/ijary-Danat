import { describe, expect, test } from "vitest";

import { defaultInvoiceAction, reseedUntouched } from "@/lib/closeoutInvoiceActions";

describe("defaultInvoiceAction", () => {
  test("a month after the move-out month is written off", () => {
    expect(
      defaultInvoiceAction({ period_year: 2026, period_month: 10, state: "due" }, "2026-09-13"),
    ).toBe("write_off");
    expect(
      defaultInvoiceAction({ period_year: 2027, period_month: 1, state: "due" }, "2026-09-13"),
    ).toBe("write_off");
  });
  test("the move-out month itself and earlier months are left", () => {
    expect(
      defaultInvoiceAction({ period_year: 2026, period_month: 9, state: "due" }, "2026-09-13"),
    ).toBe("leave");
    expect(
      defaultInvoiceAction({ period_year: 2026, period_month: 8, state: "due" }, "2026-09-13"),
    ).toBe("leave");
  });
  test("an unparseable move-out date leaves everything", () => {
    expect(defaultInvoiceAction({ period_year: 2027, period_month: 1, state: "due" }, "")).toBe(
      "leave",
    );
  });
});

describe("reseedUntouched", () => {
  const invoices = [
    { id: "a", period_year: 2026, period_month: 9, state: "due" },
    { id: "b", period_year: 2026, period_month: 10, state: "due" },
  ];
  test("recomputes rows the operator never touched and keeps the ones they did", () => {
    const rows = [
      { invoice_id: "a", action: "leave" as const, amount: 0 },
      { invoice_id: "b", action: "cancel" as const, amount: 0 },
    ];
    const next = reseedUntouched(rows, invoices, "2026-08-01", new Set(["b"]));
    expect(next).toEqual([
      { invoice_id: "a", action: "write_off", amount: 0 },
      { invoice_id: "b", action: "cancel", amount: 0 },
    ]);
  });
});

describe("terminal invoices", () => {
  test.each(["cancelled", "waived"])(
    "a %s month after the move-out is left, never written off",
    (state) => {
      expect(
        defaultInvoiceAction({ period_year: 2027, period_month: 1, state }, "2026-09-13"),
      ).toBe("leave");
    },
  );
});
