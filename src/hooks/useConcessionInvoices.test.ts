import { beforeEach, describe, expect, test, vi } from "vitest";

import { ID_CHUNK_SIZE } from "@/lib/idChunks";

const from = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: (t: string) => from(t) } }));

const {
  buildConcessionCoverage,
  fetchDiscountableInvoices,
  formatDiscountableInvoiceLabel,
  periodBoundsFromInvoices,
} = await import("@/hooks/useConcessionInvoices");

beforeEach(() => {
  from.mockReset();
});

describe("formatDiscountableInvoiceLabel", () => {
  test("lists the invoice code then the localised month and year", () => {
    expect(
      formatDiscountableInvoiceLabel(
        { code: "INV-0000250", period_year: 2026, period_month: 3 },
        "en",
      ),
    ).toBe("INV-0000250 — March 2026");
  });
});

describe("periodBoundsFromInvoices", () => {
  test("non-contiguous Jan and Mar span from 1 Jan to 31 Mar", () => {
    expect(
      periodBoundsFromInvoices([
        { period_year: 2026, period_month: 1 },
        { period_year: 2026, period_month: 3 },
      ]),
    ).toEqual({ start_date: "2026-01-01", end_date: "2026-03-31" });
  });

  test("returns null when nothing is selected", () => {
    expect(periodBoundsFromInvoices([])).toBeNull();
  });
});

describe("buildConcessionCoverage", () => {
  test("sums the money taken off across a concession's invoices", () => {
    // A fixed discount is applied to *each* invoice it binds, so three months
    // of a 50 KWD concession is 150 off — not 50. Reading the concession's own
    // discount_amount instead would understate it by the number of months.
    const coverage = buildConcessionCoverage(
      [
        { concession_id: "c-1", invoice_id: "i-1" },
        { concession_id: "c-1", invoice_id: "i-2" },
        { concession_id: "c-1", invoice_id: "i-3" },
      ],
      [
        { id: "i-1", code: "INV-001", discount: 50 },
        { id: "i-2", code: "INV-002", discount: 50 },
        { id: "i-3", code: "INV-003", discount: 50 },
      ],
    );
    expect(coverage.get("c-1")).toEqual({
      codes: ["INV-001", "INV-002", "INV-003"],
      months: 3,
      discountTotal: 150,
    });
  });

  test("a clamped invoice contributes what it was actually given", () => {
    // apply_concession_to_invoices clamps each discount at the invoice subtotal,
    // so the total is not percent × subtotal summed — it is what was written.
    const coverage = buildConcessionCoverage(
      [
        { concession_id: "c-1", invoice_id: "i-1" },
        { concession_id: "c-1", invoice_id: "i-2" },
      ],
      [
        { id: "i-1", code: "INV-001", discount: 45 },
        { id: "i-2", code: "INV-002", discount: 12.5 },
      ],
    );
    expect(coverage.get("c-1")?.discountTotal).toBe(57.5);
  });

  test("numeric strings from PostgREST add up instead of concatenating", () => {
    // Supabase hands numerics back as strings; "50" + "50" is "5050".
    const coverage = buildConcessionCoverage(
      [
        { concession_id: "c-1", invoice_id: "i-1" },
        { concession_id: "c-1", invoice_id: "i-2" },
      ],
      [
        { id: "i-1", code: "INV-001", discount: "50" as unknown as number },
        { id: "i-2", code: "INV-002", discount: "50" as unknown as number },
      ],
    );
    expect(coverage.get("c-1")?.discountTotal).toBe(100);
  });

  test("keeps concessions apart rather than pooling their invoices", () => {
    const coverage = buildConcessionCoverage(
      [
        { concession_id: "c-1", invoice_id: "i-1" },
        { concession_id: "c-2", invoice_id: "i-2" },
      ],
      [
        { id: "i-1", code: "INV-001", discount: 10 },
        { id: "i-2", code: "INV-002", discount: 20 },
      ],
    );
    expect(coverage.get("c-1")).toEqual({ codes: ["INV-001"], months: 1, discountTotal: 10 });
    expect(coverage.get("c-2")).toEqual({ codes: ["INV-002"], months: 1, discountTotal: 20 });
  });

  test("a link whose invoice is missing still counts, but adds no code or money", () => {
    // The link is the fact; the invoice row is only how it is described. Losing
    // the count would understate how many invoices the concession holds.
    const coverage = buildConcessionCoverage(
      [
        { concession_id: "c-1", invoice_id: "i-1" },
        { concession_id: "c-1", invoice_id: "gone" },
      ],
      [{ id: "i-1", code: "INV-001", discount: 10 }],
    );
    expect(coverage.get("c-1")).toEqual({ codes: ["INV-001"], months: 2, discountTotal: 10 });
  });

  test("a concession with no links is absent, not present with zeroes", () => {
    // The dialog falls back to the date range when a concession has no coverage
    // entry; an empty entry would report zero months for a free-month row.
    expect(buildConcessionCoverage([], [{ id: "i-1", code: "INV-001", discount: 10 }]).size).toBe(
      0,
    );
  });

  test("a null discount is treated as nothing taken off", () => {
    const coverage = buildConcessionCoverage(
      [{ concession_id: "c-1", invoice_id: "i-1" }],
      [{ id: "i-1", code: "INV-001", discount: null }],
    );
    expect(coverage.get("c-1")?.discountTotal).toBe(0);
  });
});

/**
 * Reported 2026-08-29 on tenant DANA-000040: the concession dialog offered no
 * invoices for CON-00052/54/55, which hold 238 unpaid invoices each. Their ids
 * went into one `in("invoice_id", …)` filter — 8,883 bytes of URL, which
 * production Kong answers with 414 (200 ids, 7,477 bytes, gets through). The
 * dialog rendered the rejection as its empty state, so a broken request read as
 * "this contract has no unpaid invoices".
 */
describe("fetchDiscountableInvoices", () => {
  /** يبني عميلاً وهميًّا يردّ الفواتير المطلوبة ويسجّل أحجام مرشِّحات `in()`. */
  function clientWith(unpaidCount: number) {
    const linkFilterSizes: number[] = [];
    const invoices = Array.from({ length: unpaidCount }, (_, index) => ({
      id: `inv-${index}`,
      code: `INV-${index}`,
      period_year: 2026,
      period_month: (index % 12) + 1,
      paid: 0,
      state: "overdue",
      discount: 0,
    }));
    from.mockImplementation((table: string) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "order"]) builder[method] = vi.fn(() => builder);
      builder.in = vi.fn((column: string, value: string[]) => {
        if (table === "concession_invoices") linkFilterSizes.push(value.length);
        return builder;
      });
      builder.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(
          table === "invoices" ? { data: invoices, error: null } : { data: [], error: null },
        ).then(resolve);
      return builder;
    });
    return linkFilterSizes;
  }

  test("splits the linked-invoice lookup so 238 unpaid invoices stay under the URL limit", async () => {
    const linkFilterSizes = clientWith(238);

    const eligible = await fetchDiscountableInvoices("contract-1");

    expect(linkFilterSizes).toEqual([ID_CHUNK_SIZE, 38]);
    expect(eligible).toHaveLength(238);
    // `subtotal` and `extraCharges` joined the shape in migration 171: the
    // waiver prompt needs to know which of these months would still owe
    // something after a full discount. `extraCharges` is 0 here because this
    // fixture's invoices carry no service-charge lines — a default that must
    // come from the aggregate returning nothing, not from the field being
    // dropped, which is what `toEqual` on the whole object pins.
    expect(eligible[0]).toEqual({
      id: "inv-0",
      code: "INV-0",
      period_year: 2026,
      period_month: 1,
      subtotal: 0,
      extraCharges: 0,
    });
  });

  test("asks for the linked invoices once when the contract fits in a chunk", async () => {
    const linkFilterSizes = clientWith(16);

    expect(await fetchDiscountableInvoices("contract-short")).toHaveLength(16);
    expect(linkFilterSizes).toEqual([16]);
  });

  test("never queries the link table for a contract with nothing unpaid", async () => {
    const linkFilterSizes = clientWith(0);

    expect(await fetchDiscountableInvoices("contract-empty")).toEqual([]);
    expect(linkFilterSizes).toEqual([]);
  });
});
