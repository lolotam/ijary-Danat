import { describe, expect, test } from "vitest";

import { allocatedAmountByPayment, attributePaymentsToContract } from "@/lib/contractPayments";

describe("allocatedAmountByPayment", () => {
  test("a payment split across two contracts contributes only its own share to each", () => {
    const allocations = [
      { payment_id: "payment-1", invoice_id: "invoice-a", amount: 300 },
      { payment_id: "payment-1", invoice_id: "invoice-b", amount: 200 },
    ];

    expect(allocatedAmountByPayment(allocations, ["invoice-a"]).get("payment-1")).toBe(300);
    expect(allocatedAmountByPayment(allocations, ["invoice-b"]).get("payment-1")).toBe(200);
  });

  test("sums several allocations landing on the same contract", () => {
    const allocated = allocatedAmountByPayment(
      [
        { payment_id: "payment-1", invoice_id: "invoice-a", amount: 120.5 },
        { payment_id: "payment-1", invoice_id: "invoice-b", amount: 79.5 },
      ],
      ["invoice-a", "invoice-b"],
    );

    expect(allocated.get("payment-1")).toBe(200);
  });

  test("omits a payment with nothing allocated to this contract", () => {
    const allocated = allocatedAmountByPayment(
      [{ payment_id: "payment-1", invoice_id: "invoice-other", amount: 500 }],
      ["invoice-a"],
    );

    expect(allocated.has("payment-1")).toBe(false);
  });
});

describe("attributePaymentsToContract", () => {
  const payments = [
    { id: "payment-1", payment_date: "2026-01-10", amount: 500 },
    { id: "payment-2", payment_date: "2026-03-10", amount: 250 },
    { id: "payment-3", payment_date: "2026-02-10", amount: 100 },
  ];

  test("reports the allocated amount, not the payment total", () => {
    const rows = attributePaymentsToContract(payments, new Map([["payment-1", 300]]));

    expect(rows).toEqual([
      { id: "payment-1", payment_date: "2026-01-10", amount: 500, allocated: 300 },
    ]);
  });

  test("drops payments allocated to no invoice of this contract", () => {
    const rows = attributePaymentsToContract(payments, new Map([["payment-2", 250]]));

    expect(rows.map((row) => row.id)).toEqual(["payment-2"]);
  });

  test("orders newest payment first", () => {
    const rows = attributePaymentsToContract(
      payments,
      new Map([
        ["payment-1", 500],
        ["payment-2", 250],
        ["payment-3", 100],
      ]),
    );

    expect(rows.map((row) => row.id)).toEqual(["payment-2", "payment-3", "payment-1"]);
  });
});
