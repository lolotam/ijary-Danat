import { describe, expect, it } from "vitest";

import { partialPaymentErrorKey } from "./partialPaymentErrors";

describe("partialPaymentErrorKey", () => {
  it.each([
    ["partial_payment_exceeds_balance", "partialPayments.exceedsBalance"],
    ["partial_payment_invoice_out_of_order", "partialPayments.outOfOrder"],
    ["partial_payment_invoice_terminal_state", "partialPayments.invoiceTerminal"],
    ["partial_payment_settled_immutable", "partialPayments.settledImmutable"],
    ["partial_payment_bulk_edit_unsupported", "partialPayments.bulkUnsupported"],
    ["40P01", "partialPayments.retry"],
  ])("maps %s to its dictionary key", (code, key) => {
    expect(partialPaymentErrorKey({ message: code })).toBe(key);
  });

  it("maps a 40P01 SQLSTATE on the error code even when the message is prose", () => {
    expect(partialPaymentErrorKey({ code: "40P01", message: "deadlock detected" })).toBe(
      "partialPayments.retry",
    );
  });

  it("finds the code inside a wrapped PostgREST message", () => {
    // PostgREST does not hand back the bare identifier; it arrives inside a
    // constraint-violation sentence.
    expect(
      partialPaymentErrorKey({
        message: 'new row for relation "partial_payments" violates partial_payment_exceeds_balance',
      }),
    ).toBe("partialPayments.exceedsBalance");
  });

  it.each([{ message: "connection reset by peer" }, {}, null, undefined])(
    "returns null for %o, so the caller keeps its own fallback",
    (error) => {
      expect(partialPaymentErrorKey(error)).toBeNull();
    },
  );
});
