import { describe, expect, it } from "vitest";

import type { PortalPayment } from "@/hooks/usePortalData";
import { filterPaymentsByContract, paymentSliceForContract } from "@/lib/portalPaymentContracts";

const spanning = { id: "p1", contractIds: ["A", "B"] } as unknown as PortalPayment;
const single = { id: "p2", contractIds: ["A"] } as unknown as PortalPayment;
const orphan = { id: "p3", contractIds: [], allocatedAmount: 0 } as unknown as PortalPayment;

describe("filterPaymentsByContract", () => {
  it("shows a payment under every contract it settled", () => {
    expect(filterPaymentsByContract([spanning, single], "B").map((p) => p.id)).toEqual(["p1"]);
  });

  /**
   * Review round 5 on PR #209. This used to assert the opposite, on the premise
   * that such a payment "shows only in the all view" — but there is no all
   * view: `resolvePortalContractId` falls back to the first contract, so a
   * null selection means the tenant has no contracts at all. Hiding it was a
   * disappearance, and what disappeared was the tenant's own unapplied money.
   */
  it("keeps a payment that resolves to no contract, since there is no all view", () => {
    expect(filterPaymentsByContract([orphan], "A").map((p) => p.id)).toEqual(["p3"]);
  });

  // It must not, however, start showing under a contract it did settle nothing
  // on while other payments are correctly scoped.
  it("still scopes payments that do resolve to a contract", () => {
    expect(filterPaymentsByContract([spanning, single, orphan], "B").map((p) => p.id)).toEqual([
      "p1",
      "p3",
    ]);
  });

  it("shows everything, including unallocated payments, when no contract is selected", () => {
    expect(filterPaymentsByContract([spanning, single, orphan], null)).toHaveLength(3);
  });
});

describe("paymentSliceForContract", () => {
  const spanning = {
    id: "p1",
    amount: 900,
    contractIds: ["A", "B"],
    periods: [
      { month: 1, year: 2026 },
      { month: 5, year: 2026 },
    ],
    byContract: {
      A: { amount: 300, periods: [{ month: 1, year: 2026 }] },
      B: { amount: 600, periods: [{ month: 5, year: 2026 }] },
    },
  } as unknown as PortalPayment;

  it("reports only the amount allocated to the selected contract", () => {
    // 900 under both A and B would double-count a single 900 transaction.
    expect(paymentSliceForContract(spanning, "A").amount).toBe(300);
    expect(paymentSliceForContract(spanning, "B").amount).toBe(600);
  });

  it("reports only the periods that contract's invoices covered", () => {
    expect(paymentSliceForContract(spanning, "B").periods).toEqual([{ month: 5, year: 2026 }]);
  });

  it("reports the whole transaction when no contract is selected", () => {
    const all = paymentSliceForContract(spanning, null);
    expect(all.amount).toBe(900);
    expect(all.periods).toHaveLength(2);
  });

  it("falls back to the whole payment when the contract has no allocated slice", () => {
    // A caller reaching here must not get 0 and read it as "paid nothing".
    const orphan = {
      id: "p3",
      amount: 50,
      allocatedAmount: 0,
      contractIds: [],
      periods: [],
      byContract: {},
    } as unknown as PortalPayment;
    expect(paymentSliceForContract(orphan, "A").amount).toBe(50);
  });

  /**
   * The deploy window, which this test found by being written before the field
   * existed: a TanStack Query entry filled by the previous bundle carries no
   * `allocatedAmount`, and `amount - undefined` renders NaN. Missing reads as
   * "nothing allocated", which is what that bundle was showing a moment before.
   */
  it("shows the full amount when a cached payment predates allocatedAmount", () => {
    const stale = {
      id: "p6",
      amount: 500,
      contractIds: [],
      periods: [],
      byContract: {},
    } as unknown as PortalPayment;

    expect(paymentSliceForContract(stale, "A").amount).toBe(500);
  });

  /**
   * Review round 6 on PR #209. KWD 500 paid, KWD 300 applied to a lease the
   * portal hides, KWD 200 unapplied. Reporting `payment.amount` here would put
   * the withheld 300 back on screen under a contract it was never paid
   * against, and count it again in any total the tenant takes.
   */
  it("reports only the unapplied remainder for a payment with withheld allocations", () => {
    const partial = {
      id: "p4",
      amount: 500,
      allocatedAmount: 300,
      contractIds: [],
      byContract: {},
      periods: [{ month: 1, year: 2026 }],
    } as unknown as PortalPayment;

    expect(paymentSliceForContract(partial, "A")).toEqual({ amount: 200, periods: [] });
  });

  // A genuinely unallocated payment has allocated nothing, so the remainder is
  // the whole thing — unchanged from before.
  it("still reports the full amount for a payment that allocated nothing", () => {
    const unapplied = {
      id: "p5",
      amount: 500,
      allocatedAmount: 0,
      contractIds: [],
      byContract: {},
      periods: [],
    } as unknown as PortalPayment;

    expect(paymentSliceForContract(unapplied, "A")).toEqual({ amount: 500, periods: [] });
  });
});
