import { describe, expect, it } from "vitest";

import { remainingForEdit, type PartialPaymentEditContext } from "./partialPaymentRemaining";

const ownInvoice = {
  id: "inv-own",
  code: "INV-1",
  period_year: 2026,
  period_month: 1,
  balance: 100,
  state: "partially_paid" as const,
};

const context: PartialPaymentEditContext = {
  settled: true,
  credited_amount: 200,
  invoice: ownInvoice,
};

const settleable = [
  { id: "inv-own", balance: 100 },
  { id: "inv-other", balance: 400 },
];

describe("remainingForEdit", () => {
  it("adds the row's own credit on the invoice it currently settles", () => {
    expect(remainingForEdit(context, "inv-own", settleable)).toBe(300);
  });

  it("uses the plain balance of any other invoice", () => {
    expect(remainingForEdit(context, "inv-other", settleable)).toBe(400);
  });

  it("uses the plain balance when the row is unsettled", () => {
    const unsettled: PartialPaymentEditContext = {
      settled: false,
      credited_amount: 0,
      invoice: null,
    };
    expect(remainingForEdit(unsettled, "inv-other", settleable)).toBe(400);
  });

  it("returns null when the dialog has no context yet", () => {
    expect(remainingForEdit(null, "inv-own", settleable)).toBeNull();
    expect(remainingForEdit(undefined, "inv-own", settleable)).toBeNull();
  });
});
