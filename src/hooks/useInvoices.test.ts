import { beforeEach, describe, expect, it, vi } from "vitest";

import { ID_CHUNK_SIZE } from "@/lib/idChunks";

const from = vi.fn();
const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (t: string) => from(t),
    rpc: (name: string, args: Record<string, unknown>) => rpc(name, args),
  },
}));

const {
  fetchInvoicesWithRelations,
  fetchPropertyUnitIds,
  monthlyInvoiceSummaryQuery,
  stripEmbeddedItems,
  resolveUnitIdsByInvoice,
} = await import("@/hooks/useInvoices");

/**
 * Final review I4. The admin invoices list filtered by property with
 * `.in("unit_id", propertyUnitIds)` on `invoices`. `invoices.unit_id` is NULL
 * for a consolidated multi-unit invoice (migration 112) and `in` never matches
 * NULL, so filtering to a property silently dropped every consolidated invoice
 * — a wrong answer presented as a right one for an operator reconciling a
 * property. The resolution now goes through `invoice_items.unit_id`, the same
 * fix already applied to the unit-detail invoices tab.
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

describe("fetchPropertyUnitIds", () => {
  it("returns the property's unit ids, which is what the invoice filter rides on", async () => {
    const unitsQuery = stub({ data: [{ id: "unit-a" }, { id: "unit-b" }], error: null });
    from.mockImplementationOnce(() => unitsQuery);

    expect(await fetchPropertyUnitIds("prop-1")).toEqual(["unit-a", "unit-b"]);
    // Only `units` — resolving the invoice ids here is what broke on real data.
    expect(from.mock.calls.map(([table]) => table)).toEqual(["units"]);
    expect(unitsQuery.eq).toHaveBeenCalledWith("property_id", "prop-1");
  });

  it("returns nothing for a property with no units", async () => {
    from.mockImplementationOnce(() => stub({ data: [], error: null }));

    expect(await fetchPropertyUnitIds("prop-empty")).toEqual([]);
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("propagates a units query error", async () => {
    from.mockImplementationOnce(() => stub({ data: null, error: new Error("units boom") }));
    await expect(fetchPropertyUnitIds("prop-1")).rejects.toThrow("units boom");
  });
});

describe("useMonthlyInvoiceSummary", () => {
  it("asks the RPC for the year and property and maps the rows", async () => {
    // PostgREST hands numeric/bigint columns back as strings; the hook is
    // where they become numbers so every card can sum them.
    rpc.mockResolvedValue({
      data: [{ month: 1, count: 2, total: "500", paid: "100", outstanding: "400", overdue: 1 }],
      error: null,
    });

    const rows = await monthlyInvoiceSummaryQuery(2029, "prop-1")();

    expect(rpc).toHaveBeenCalledWith("get_invoice_month_summary", {
      p_year: 2029,
      p_property_id: "prop-1",
    });
    expect(rows[0]).toEqual({
      month: 1,
      count: 2,
      total: 500,
      paid: 100,
      outstanding: 400,
      overdue: 1,
    });
  });

  it("passes a null property through so the year aggregates whole invoices", async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    await monthlyInvoiceSummaryQuery(2029, null)();

    expect(rpc).toHaveBeenCalledWith("get_invoice_month_summary", {
      p_year: 2029,
      p_property_id: null,
    });
  });

  it("propagates an RPC error", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error("summary boom") });
    await expect(monthlyInvoiceSummaryQuery(2029, null)()).rejects.toThrow("summary boom");
  });
});

/**
 * Measured on production before the change: the largest property holds 1,274
 * `invoice_items` rows, so the unranged lookup that resolved invoice ids came
 * back clipped at PostgREST's 1,000-row cap and yielded **897** of its 1,171
 * invoices — an operator reconciling that property was shown a short list with
 * no indication. Those ids then exceeded what one `in()` filter can carry.
 * Filtering through the embedded relation removes both ceilings: 13 unit ids
 * instead of 1,171 invoice ids, and paging, ordering and the exact count all
 * stay on the server.
 */
describe("stripEmbeddedItems", () => {
  it("removes the invoice_items array the property filter embeds", () => {
    const row = { id: "inv-1", code: "INV-1", invoice_items: [{ unit_id: "unit-a" }] };

    const stripped = stripEmbeddedItems(row);

    expect(stripped).toEqual({ id: "inv-1", code: "INV-1" });
    expect("invoice_items" in stripped).toBe(false);
  });

  it("leaves a row without the embed untouched", () => {
    const row = { id: "inv-1", code: "INV-1" };

    expect(stripEmbeddedItems(row)).toEqual(row);
  });
});

/**
 * The Unit column was empty on every invoice belonging to a multi-unit
 * contract. `invoices.unit_id` is NULL for a consolidated invoice (migration
 * 112) and the enrichment read only that column, so the cell rendered an em
 * dash — indistinguishable from missing data. In this database that is five
 * invoices across a three-unit, two-property contract.
 */
describe("resolveUnitIdsByInvoice", () => {
  it("returns every unit of a consolidated invoice, not just one", () => {
    const resolved = resolveUnitIdsByInvoice(
      [{ id: "inv-1", unit_id: null }],
      [
        { invoice_id: "inv-1", unit_id: "unit-a" },
        { invoice_id: "inv-1", unit_id: "unit-b" },
        { invoice_id: "inv-1", unit_id: "unit-c" },
      ],
    );
    expect(resolved.get("inv-1")).toEqual(["unit-a", "unit-b", "unit-c"]);
  });

  it("counts a unit once when several lines share it", () => {
    // A concession line carries the same unit_id as the rent line it discounts.
    const resolved = resolveUnitIdsByInvoice(
      [{ id: "inv-1", unit_id: null }],
      [
        { invoice_id: "inv-1", unit_id: "unit-a" },
        { invoice_id: "inv-1", unit_id: "unit-a" },
      ],
    );
    expect(resolved.get("inv-1")).toEqual(["unit-a"]);
  });

  it("falls back to the invoice's own column when no line is attributed", () => {
    // Migration 112 backfilled rent lines, but a concession-only or
    // hand-inserted invoice need not have an attributed line.
    const resolved = resolveUnitIdsByInvoice([{ id: "inv-1", unit_id: "unit-a" }], []);
    expect(resolved.get("inv-1")).toEqual(["unit-a"]);
  });

  it("prefers the line items over the invoice column when both exist", () => {
    // The column holds one unit; the lines hold the truth for a consolidated
    // invoice. Preferring the column would show one unit out of three.
    const resolved = resolveUnitIdsByInvoice(
      [{ id: "inv-1", unit_id: "unit-a" }],
      [
        { invoice_id: "inv-1", unit_id: "unit-a" },
        { invoice_id: "inv-1", unit_id: "unit-b" },
      ],
    );
    expect(resolved.get("inv-1")).toEqual(["unit-a", "unit-b"]);
  });

  it("ignores lines carrying no unit and yields nothing for that invoice", () => {
    const resolved = resolveUnitIdsByInvoice(
      [{ id: "inv-1", unit_id: null }],
      [{ invoice_id: "inv-1", unit_id: null }],
    );
    expect(resolved.has("inv-1")).toBe(false);
  });

  it("keeps invoices separate", () => {
    const resolved = resolveUnitIdsByInvoice(
      [
        { id: "inv-1", unit_id: null },
        { id: "inv-2", unit_id: null },
      ],
      [
        { invoice_id: "inv-1", unit_id: "unit-a" },
        { invoice_id: "inv-2", unit_id: "unit-b" },
      ],
    );
    expect(resolved.get("inv-1")).toEqual(["unit-a"]);
    expect(resolved.get("inv-2")).toEqual(["unit-b"]);
  });
});

/**
 * PR #160 review (Codex, P1). Uncapping the tenant and contract invoice fetches
 * meant `fetchInvoicesWithRelations` received 238 invoices at once and asked for
 * their line items in a single `in()` filter. Measured against production Kong:
 * 200 ids is a 7,477-byte URL and gets through, 238 ids is 8,883 bytes and comes
 * back **414** — nginx caps the request line at 8 KB. Uncapping the list without
 * this would have turned a silently short table into a broken one.
 */
describe("fetchInvoicesWithRelations id chunking", () => {
  /** يسجّل حجم كل مرشِّح `in()` أُرسل، ويردّ صفوفًا فارغة. */
  function recordingClient() {
    const inSizes: Array<{ table: string; column: string; size: number }> = [];
    from.mockImplementation((table: string) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "order"]) builder[method] = vi.fn(() => builder);
      builder.in = vi.fn((column: string, ids: string[]) => {
        inSizes.push({ table, column, size: ids.length });
        return builder;
      });
      builder.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve);
      return builder;
    });
    return inSizes;
  }

  it("reads the units and the service charges from one query, not two", async () => {
    // Both are derived from the same lines of the same table for the same
    // invoices. A second round trip would double the chunking cost to answer
    // half the question, and is how the two would drift out of step.
    const inSizes = recordingClient();
    const invoices = [
      { id: "inv-1", tenant_id: "t-1", contract_id: "c-1", unit_id: null },
    ] as unknown as Parameters<typeof fetchInvoicesWithRelations>[0];

    await fetchInvoicesWithRelations(invoices);

    expect(inSizes.filter((call) => call.table === "invoice_items")).toHaveLength(1);
  });

  it("never puts more than ID_CHUNK_SIZE ids in one filter for a 238-invoice lease", async () => {
    const inSizes = recordingClient();
    const invoices = Array.from({ length: 238 }, (_, index) => ({
      id: `inv-${index}`,
      tenant_id: "tenant-1",
      contract_id: "contract-1",
      unit_id: null,
    })) as unknown as Parameters<typeof fetchInvoicesWithRelations>[0];

    await fetchInvoicesWithRelations(invoices);

    const itemFilters = inSizes.filter((call) => call.table === "invoice_items");
    // 238 split at the 200 ceiling: two requests, neither over it.
    expect(itemFilters.map((call) => call.size)).toEqual([ID_CHUNK_SIZE, 38]);
    expect(inSizes.every((call) => call.size <= ID_CHUNK_SIZE)).toBe(true);
  });
});

/**
 * Reported 2026-08-30: a contract's recurring service charge was priced into
 * `invoices.subtotal` and written as its own flagged line, but nothing that
 * rendered an invoice read it, so the printed paper lumped rent and cleaning
 * into one figure.
 */
describe("fetchInvoicesWithRelations service charges", () => {
  /** يردّ بنود الفواتير المعطاة لجدول invoice_items وحده. */
  function clientReturning(items: unknown[]) {
    from.mockImplementation((table: string) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "order", "in"]) builder[method] = vi.fn(() => builder);
      builder.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: table === "invoice_items" ? items : [],
          error: null,
        }).then(resolve);
      return builder;
    });
  }

  const invoices = [
    { id: "inv-1", tenant_id: "t-1", contract_id: "c-1", unit_id: null },
    { id: "inv-2", tenant_id: "t-1", contract_id: "c-1", unit_id: null },
  ] as unknown as Parameters<typeof fetchInvoicesWithRelations>[0];

  it("attaches only the flagged lines, and only to their own invoice", async () => {
    clientReturning([
      {
        invoice_id: "inv-1",
        unit_id: "unit-1",
        line: 1,
        amount: 750,
        is_extra_charge: false,
        description_ar: "إيجار",
        description_en: "Rent",
      },
      {
        invoice_id: "inv-1",
        unit_id: null,
        line: 2,
        amount: 20,
        is_extra_charge: true,
        description_ar: "النظافة",
        description_en: "Cleaning",
      },
    ]);

    const [first, second] = await fetchInvoicesWithRelations(invoices);

    expect(first.extraCharges).toEqual([
      { amount: 20, description_ar: "النظافة", description_en: "Cleaning" },
    ]);
    expect(second.extraCharges).toEqual([]);
  });
});
