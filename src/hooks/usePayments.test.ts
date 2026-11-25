import { beforeEach, describe, expect, it, vi } from "vitest";

const from = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: (t: string) => from(t) } }));

const { fetchUnitPaymentIds } = await import("@/hooks/usePayments");

/**
 * Final review M3. The unit page's Payments tab filtered on
 * `payments.unit_id`, which `set_invoice_paid` copies from
 * `invoices.unit_id` — NULL for a consolidated multi-unit invoice (migration
 * 112). So a multi-unit contract's payments appeared under no unit tab at all,
 * the identical gap already fixed for the Invoices tab eight lines above it.
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

describe("fetchUnitPaymentIds", () => {
  it("walks invoice_items to payment_allocations, so a consolidated payment is reachable", async () => {
    const itemsQuery = stub({
      data: [{ invoice_id: "inv-1" }, { invoice_id: "inv-1" }, { invoice_id: "inv-2" }],
      error: null,
    });
    const allocationsQuery = stub({
      data: [{ payment_id: "pay-1" }, { payment_id: "pay-2" }, { payment_id: "pay-1" }],
      error: null,
    });
    from.mockImplementationOnce(() => itemsQuery).mockImplementationOnce(() => allocationsQuery);

    const ids = await fetchUnitPaymentIds("unit-a");

    expect([...ids]).toEqual(["pay-1", "pay-2"]);
    expect(from.mock.calls.map(([table]) => table)).toEqual([
      "invoice_items",
      "payment_allocations",
    ]);
    expect(itemsQuery.eq).toHaveBeenCalledWith("unit_id", "unit-a");
    // Deduplicated before the second round trip.
    expect(allocationsQuery.in).toHaveBeenCalledWith("invoice_id", ["inv-1", "inv-2"]);
  });

  it("returns nothing, and never queries allocations, when the unit has no invoice lines", async () => {
    from.mockImplementationOnce(() => stub({ data: [], error: null }));

    expect([...(await fetchUnitPaymentIds("unit-a"))]).toEqual([]);
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("requires a unit id and queries nothing without one", async () => {
    expect([...(await fetchUnitPaymentIds(""))]).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  it("propagates an invoice_items query error", async () => {
    from.mockImplementationOnce(() => stub({ data: null, error: new Error("items boom") }));
    await expect(fetchUnitPaymentIds("unit-a")).rejects.toThrow("items boom");
  });

  it("propagates an allocations query error", async () => {
    from
      .mockImplementationOnce(() => stub({ data: [{ invoice_id: "inv-1" }], error: null }))
      .mockImplementationOnce(() => stub({ data: null, error: new Error("alloc boom") }));

    await expect(fetchUnitPaymentIds("unit-a")).rejects.toThrow("alloc boom");
  });
});
