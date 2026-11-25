import { describe, expect, it } from "vitest";

import {
  classifyBlockingPayments,
  manualPlaceholderReference,
  type BlockingPayment,
} from "./gatewayReconciliation";

function placeholder(invoiceCode: string, id = `id-${invoiceCode}`): BlockingPayment {
  return {
    id,
    code: `PAY-${invoiceCode}`,
    invoiceCode,
    method: "cash",
    reference: manualPlaceholderReference(invoiceCode),
  };
}

describe("manualPlaceholderReference", () => {
  it("matches the reference set_invoice_paid writes in migration 23", () => {
    expect(manualPlaceholderReference("INV-0000006")).toBe("AUTO-INV:INV-0000006");
  });
});

describe("classifyBlockingPayments", () => {
  it("returns none when nothing is blocking", () => {
    expect(classifyBlockingPayments([])).toEqual({ kind: "none" });
  });

  it("adopts when every blocking payment is an admin placeholder", () => {
    const payments = [placeholder("INV-0000006"), placeholder("INV-0000007")];
    expect(classifyBlockingPayments(payments)).toEqual({ kind: "adopt", payments });
  });

  // Everything that is not exactly this invoice's own placeholder must block
  // adoption. Each row is a different way a payment can fail that test, and the
  // consequence of getting any of them wrong is the same: a real payment gets
  // silently relabelled as a gateway charge.
  it.each([
    {
      why: "a staff-recorded cheque",
      payment: { method: "cheque", reference: "Cheque 4471" },
    },
    {
      why: "a payment with no reference at all",
      payment: { method: "cash", reference: null },
    },
    {
      why: "a placeholder naming a different invoice",
      payment: { method: "cash", reference: manualPlaceholderReference("INV-0000006") },
    },
    {
      why: "a gateway payment from an earlier settlement",
      payment: { method: "knet", reference: "MF:100621810000012471#INV-0000007" },
    },
  ])("refuses to adopt the whole set when one payment is $why", ({ payment }) => {
    const conflicting: BlockingPayment = {
      id: "id-conflict",
      code: "PAY-0000009",
      invoiceCode: "INV-0000007",
      ...payment,
    };

    const decision = classifyBlockingPayments([placeholder("INV-0000006"), conflicting]);

    expect(decision).toEqual({ kind: "conflict", conflicting });
  });
});
