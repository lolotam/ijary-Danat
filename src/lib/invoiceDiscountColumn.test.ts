import { describe, expect, it } from "vitest";

import { invoiceDiscountBadge } from "@/lib/invoiceDiscountColumn";

describe("invoiceDiscountBadge", () => {
  it("renders a fixed discount as an amount", () => {
    const badge = invoiceDiscountBadge(
      100,
      { type: "fixed_discount", discount_percent: null },
      "en",
    );
    expect(badge).toEqual({ kind: "fixed", amount: expect.stringContaining("100") });
  });

  it("renders a percentage discount with both the percentage and the amount", () => {
    const badge = invoiceDiscountBadge(
      30,
      { type: "percentage_discount", discount_percent: 10 },
      "en",
    );
    expect(badge?.kind).toBe("percentage");
    expect(badge).toMatchObject({ percent: 10 });
    expect(badge?.amount).toContain("30");
  });

  it("carries no month count — the Discount column shows money only", () => {
    // The count describes the concession, not this invoice. Repeating it on
    // every row read as a per-invoice quantity it never was.
    const badge = invoiceDiscountBadge(
      100,
      { type: "percentage_discount", discount_percent: 10 },
      "en",
    );
    expect(badge).not.toHaveProperty("months");
  });

  it("takes the amount from the invoice, not from percent times subtotal", () => {
    // The invoice is what the tenant owes. Recomputing 10% of something here
    // could differ from the stored discount by a rounding step and show a
    // number the tenant was never charged.
    const badge = invoiceDiscountBadge(
      33.333,
      { type: "percentage_discount", discount_percent: 10 },
      "en",
    );
    expect(badge?.amount).toContain("33");
  });

  it("shows no badge when the invoice has no discount", () => {
    const none = { type: "fixed_discount", discount_percent: null };
    expect(invoiceDiscountBadge(0, none, "en")).toBeNull();
    expect(invoiceDiscountBadge(null, none, "en")).toBeNull();
    expect(invoiceDiscountBadge(undefined, none, "en")).toBeNull();
  });

  it("still shows the discount when its concession link is missing", () => {
    // A discount on the invoice is real money off. An unresolved link is a
    // reason to fall back to the amount, never a reason to hide it.
    const badge = invoiceDiscountBadge(50, null, "en");
    expect(badge?.kind).toBe("fixed");
    expect(badge?.amount).toContain("50");
  });

  it("falls back to an amount badge when the percentage is not recorded", () => {
    const badge = invoiceDiscountBadge(
      25,
      { type: "percentage_discount", discount_percent: null },
      "en",
    );
    expect(badge?.kind).toBe("fixed");
  });
});
