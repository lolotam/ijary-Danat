import { describe, expect, test } from "vitest";

import {
  foldPortalPaymentAllocations,
  type PortalFoldAllocation,
  type PortalFoldInvoice,
} from "@/lib/portalPaymentFold";

const SHOP_CONTRACT = "contract-shop";
const ROOF_CONTRACT = "contract-roof";

/** يبني خريطة الفواتير بالشكل الذي يقرأه الطيّ. */
function invoices(entries: Array<[string, PortalFoldInvoice]>) {
  return new Map(entries);
}

/** تخصيص واحد بقيمة افتراضية. */
function allocation(paymentId: string, invoiceId: string, amount = 100): PortalFoldAllocation {
  return { amount, invoice_id: invoiceId, payment_id: paymentId };
}

describe("foldPortalPaymentAllocations", () => {
  test("folds an ordinary payment into its periods, contracts and slice", () => {
    const folded = foldPortalPaymentAllocations({
      allocations: [allocation("pay-1", "inv-jan", 250)],
      hiddenContractIds: new Set(),
      hiddenPaymentIds: new Set(),
      invoicesById: invoices([["inv-jan", { contract_id: SHOP_CONTRACT, month: 1, year: 2026 }]]),
      paymentIds: ["pay-1"],
    });

    expect(folded.get("pay-1")).toEqual({
      allocatedAmount: 250,
      byContract: { [SHOP_CONTRACT]: { amount: 250, periods: [{ month: 1, year: 2026 }] } },
      contractIds: [SHOP_CONTRACT],
      periods: [{ month: 1, year: 2026 }],
    });
  });

  /**
   * Migration 212 stops a tenant reading a hidden contract's invoices, so this
   * payment arrives with allocations that resolve to nothing. The server named
   * it through `portal_hidden_payment_ids`, which is the only thing that makes
   * it droppable — see the next test for why inferring it here was wrong.
   */
  test("drops a payment the server named as belonging to a hidden lease", () => {
    const folded = foldPortalPaymentAllocations({
      allocations: [allocation("pay-roof", "inv-hidden")],
      hiddenContractIds: new Set(),
      hiddenPaymentIds: new Set(["pay-roof"]),
      // Empty exactly as tenant RLS leaves it after migration 212.
      invoicesById: invoices([]),
      paymentIds: ["pay-roof"],
    });

    expect(folded.get("pay-roof")).toBeNull();
  });

  /**
   * Review round 3 on PR #209. An invoice can be unreadable because an admin
   * set `is_visible_to_tenant = false`, which has nothing to do with roofs.
   * Inferring "hidden lease" from an empty resolution swallowed those payments
   * out of the tenant's history entirely — so the decision belongs to the
   * server, and an unresolved allocation on its own must change nothing.
   */
  test("keeps a payment whose invoices are unreadable for some other reason", () => {
    const folded = foldPortalPaymentAllocations({
      allocations: [allocation("pay-invisible", "inv-not-visible")],
      hiddenContractIds: new Set(),
      hiddenPaymentIds: new Set(),
      invoicesById: invoices([]),
      paymentIds: ["pay-invisible"],
    });

    // The amount is still counted, which is what lets the payments screen show
    // the unapplied remainder rather than the whole payment.
    expect(folded.get("pay-invisible")).toEqual({
      allocatedAmount: 100,
      byContract: {},
      contractIds: [],
      periods: [],
    });
  });

  // The staff preview at /portal?tenant= is RLS-exempt, so the invoice DOES
  // resolve there — and the server names the payment either way.
  test("drops a hidden-lease payment in the staff preview, where its invoice resolves", () => {
    const folded = foldPortalPaymentAllocations({
      allocations: [allocation("pay-roof", "inv-roof")],
      hiddenContractIds: new Set([ROOF_CONTRACT]),
      hiddenPaymentIds: new Set(["pay-roof"]),
      invoicesById: invoices([["inv-roof", { contract_id: ROOF_CONTRACT, month: 3, year: 2026 }]]),
      paymentIds: ["pay-roof"],
    });

    expect(folded.get("pay-roof")).toBeNull();
  });

  /**
   * An unallocated payment is the tenant's own money sitting unapplied. It has
   * no allocations to hide, so it stays — which is exactly why "had allocations
   * but none survived" has to be a distinguishable state rather than the same
   * empty result.
   */
  test("keeps a payment that has no allocations at all", () => {
    const folded = foldPortalPaymentAllocations({
      allocations: [],
      hiddenContractIds: new Set(),
      hiddenPaymentIds: new Set(),
      invoicesById: invoices([]),
      paymentIds: ["pay-unapplied"],
    });

    expect(folded.get("pay-unapplied")).toEqual({
      allocatedAmount: 0,
      byContract: {},
      contractIds: [],
      periods: [],
    });
  });

  test("keeps the visible half of a payment split across a shop and a roof lease", () => {
    const folded = foldPortalPaymentAllocations({
      allocations: [
        allocation("pay-mixed", "inv-shop", 200),
        allocation("pay-mixed", "inv-roof", 300),
      ],
      hiddenContractIds: new Set([ROOF_CONTRACT]),
      hiddenPaymentIds: new Set(),
      invoicesById: invoices([
        ["inv-shop", { contract_id: SHOP_CONTRACT, month: 2, year: 2026 }],
        ["inv-roof", { contract_id: ROOF_CONTRACT, month: 2, year: 2026 }],
      ]),
      paymentIds: ["pay-mixed"],
    });

    // The payment survives with only the shop's share: hiding the whole row
    // would make the tenant's own history lie about what they paid.
    expect(folded.get("pay-mixed")).toEqual({
      // Both halves are counted: 200 on the shop, 300 on the roof.
      allocatedAmount: 500,
      byContract: { [SHOP_CONTRACT]: { amount: 200, periods: [{ month: 2, year: 2026 }] } },
      contractIds: [SHOP_CONTRACT],
      periods: [{ month: 2, year: 2026 }],
    });
  });

  test("orders periods chronologically across a payment that covered several months", () => {
    const folded = foldPortalPaymentAllocations({
      allocations: [
        allocation("pay-1", "inv-dec25"),
        allocation("pay-1", "inv-feb26"),
        allocation("pay-1", "inv-jan26"),
      ],
      hiddenContractIds: new Set(),
      hiddenPaymentIds: new Set(),
      invoicesById: invoices([
        ["inv-dec25", { contract_id: SHOP_CONTRACT, month: 12, year: 2025 }],
        ["inv-feb26", { contract_id: SHOP_CONTRACT, month: 2, year: 2026 }],
        ["inv-jan26", { contract_id: SHOP_CONTRACT, month: 1, year: 2026 }],
      ]),
      paymentIds: ["pay-1"],
    });

    expect(folded.get("pay-1")?.periods).toEqual([
      { month: 12, year: 2025 },
      { month: 1, year: 2026 },
      { month: 2, year: 2026 },
    ]);
  });

  // Kuwaiti dinar is 3-decimal, and the slice sum is what a contract-scoped
  // view reports — a fils of float drift would disagree with the receipt.
  test("rounds a running slice total to three decimals", () => {
    const folded = foldPortalPaymentAllocations({
      allocations: [allocation("pay-1", "inv-a", 0.1), allocation("pay-1", "inv-b", 0.2)],
      hiddenContractIds: new Set(),
      hiddenPaymentIds: new Set(),
      invoicesById: invoices([
        ["inv-a", { contract_id: SHOP_CONTRACT, month: 1, year: 2026 }],
        ["inv-b", { contract_id: SHOP_CONTRACT, month: 2, year: 2026 }],
      ]),
      paymentIds: ["pay-1"],
    });

    expect(folded.get("pay-1")?.byContract[SHOP_CONTRACT].amount).toBe(0.3);
  });

  test("reports each contract's own share when one payment settles two visible leases", () => {
    const folded = foldPortalPaymentAllocations({
      allocations: [allocation("pay-1", "inv-shop", 200), allocation("pay-1", "inv-other", 300)],
      hiddenContractIds: new Set(),
      hiddenPaymentIds: new Set(),
      invoicesById: invoices([
        ["inv-shop", { contract_id: SHOP_CONTRACT, month: 1, year: 2026 }],
        ["inv-other", { contract_id: "contract-other", month: 1, year: 2026 }],
      ]),
      paymentIds: ["pay-1"],
    });

    const result = folded.get("pay-1");
    expect(result?.byContract[SHOP_CONTRACT].amount).toBe(200);
    expect(result?.byContract["contract-other"].amount).toBe(300);
    expect(result?.contractIds.sort()).toEqual([SHOP_CONTRACT, "contract-other"].sort());
  });

  /**
   * The case rounds 4 to 6 kept circling. KWD 500 paid, KWD 300 applied to a
   * hidden lease, KWD 200 still unapplied — the server does not name it hidden
   * (there is money left over), and the fold reports the 300 so the screen can
   * subtract it and show 200.
   */
  test("counts allocations onto a hidden lease so the remainder can be worked out", () => {
    const folded = foldPortalPaymentAllocations({
      allocations: [allocation("pay-partial", "inv-roof", 300)],
      hiddenContractIds: new Set(),
      hiddenPaymentIds: new Set(),
      // Unresolvable: migration 212 keeps the hidden lease's invoices from the
      // tenant, so this is what a tenant session actually sees.
      invoicesById: invoices([]),
      paymentIds: ["pay-partial"],
    });

    expect(folded.get("pay-partial")).toEqual({
      allocatedAmount: 300,
      byContract: {},
      contractIds: [],
      periods: [],
    });
  });
});
