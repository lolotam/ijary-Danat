import { beforeEach, describe, expect, it, vi } from "vitest";

const from = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: (t: string) => from(t) } }));

const { fetchPaymentAllocations, paymentAllocationsKey } =
  await import("@/hooks/usePaymentAllocations");

/**
 * `fetchPaymentAllocations` was extracted from the hook so the portal's row
 * actions can await the allocations as a return value. Previously they called
 * `refetch()` on a query that was still disabled (`paymentId = null`), so the
 * receipt printed with an empty breakdown on the first click. These tests pin
 * the extracted contract.
 */

/** Minimal PostgREST builder stub: every filter returns `this`, awaiting resolves. */
function stub(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

beforeEach(() => {
  from.mockReset();
});

describe("paymentAllocationsKey", () => {
  it("is stable and scoped to the payment", () => {
    expect(paymentAllocationsKey("pay-1")).toEqual(["payment-allocations", "pay-1"]);
    expect(paymentAllocationsKey("pay-2")).not.toEqual(paymentAllocationsKey("pay-1"));
  });
});

describe("fetchPaymentAllocations", () => {
  it("requires a payment id and never pages the child collection", async () => {
    // Empty payment id returns immediately — the hook is also disabled without one.
    // Allocations for a payment are parent-scoped; truncating them would corrupt
    // receipt totals and paid balances.
    expect(await fetchPaymentAllocations("")).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  it("joins each allocation to its invoice", async () => {
    const allocations = [
      { id: "a1", invoice_id: "inv-1", amount: 500 },
      { id: "a2", invoice_id: "inv-2", amount: 250 },
    ];
    const invoices = [
      { id: "inv-1", code: "INV-1" },
      { id: "inv-2", code: "INV-2" },
    ];
    const allocationsQuery = stub({ data: allocations, error: null });
    const invoicesQuery = stub({ data: invoices, error: null });
    from
      .mockImplementationOnce(() => allocationsQuery)
      .mockImplementationOnce(() => invoicesQuery)
      .mockImplementationOnce(() => stub({ data: [], error: null }));

    const result = await fetchPaymentAllocations("pay-1");

    expect(result).toHaveLength(2);
    expect(result[0].invoice?.code).toBe("INV-1");
    expect(result[1].invoice?.code).toBe("INV-2");
    // Filtered by the real payment id — never the null the disabled query used.
    expect(allocationsQuery.eq).toHaveBeenCalledWith("payment_id", "pay-1");
  });

  it("returns an empty list without querying invoices when there are no allocations", async () => {
    from.mockImplementationOnce(() => stub({ data: [], error: null }));

    expect(await fetchPaymentAllocations("pay-1")).toEqual([]);
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("leaves invoice null when the join finds no matching row", async () => {
    from
      .mockImplementationOnce(() =>
        stub({ data: [{ id: "a1", invoice_id: "missing", amount: 10 }], error: null }),
      )
      .mockImplementationOnce(() => stub({ data: [], error: null }))
      .mockImplementationOnce(() => stub({ data: [], error: null }));

    const result = await fetchPaymentAllocations("pay-1");
    expect(result[0].invoice).toBeNull();
  });

  it("attaches each invoice's service-charge lines, and only those", async () => {
    // The receipt's service-charge column reads this. Rent lines share the
    // table and must not reach it: a 750 rent line arriving as an "extra
    // expense" would print the whole invoice twice on one receipt.
    from
      .mockImplementationOnce(() =>
        stub({
          data: [
            { id: "a1", invoice_id: "inv-1", amount: 770 },
            { id: "a2", invoice_id: "inv-2", amount: 500 },
          ],
          error: null,
        }),
      )
      .mockImplementationOnce(() =>
        stub({
          data: [
            { id: "inv-1", code: "INV-1" },
            { id: "inv-2", code: "INV-2" },
          ],
          error: null,
        }),
      )
      .mockImplementationOnce(() =>
        stub({
          data: [
            {
              invoice_id: "inv-1",
              line: 1,
              amount: 750,
              is_extra_charge: false,
              description_ar: "إيجار",
              description_en: "Rent",
            },
            {
              invoice_id: "inv-1",
              line: 2,
              amount: 20,
              is_extra_charge: true,
              description_ar: "النظافة",
              description_en: "Cleaning",
            },
          ],
          error: null,
        }),
      );

    const result = await fetchPaymentAllocations("pay-1");

    expect(result[0].extraCharges).toEqual([
      { amount: 20, description_ar: "النظافة", description_en: "Cleaning" },
    ]);
    // An invoice with no charge gets an empty list, not the other one's.
    expect(result[1].extraCharges).toEqual([]);
  });

  it("propagates an allocations query error", async () => {
    from.mockImplementationOnce(() => stub({ data: null, error: new Error("boom") }));
    await expect(fetchPaymentAllocations("pay-1")).rejects.toThrow("boom");
  });

  it("propagates an invoices query error", async () => {
    from
      .mockImplementationOnce(() =>
        stub({ data: [{ id: "a1", invoice_id: "inv-1", amount: 10 }], error: null }),
      )
      .mockImplementationOnce(() => stub({ data: null, error: new Error("invoice boom") }));

    await expect(fetchPaymentAllocations("pay-1")).rejects.toThrow("invoice boom");
  });
});
