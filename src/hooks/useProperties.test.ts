import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  aggregatePropertyOccupancy,
  fetchProperties,
  monthlyTotalForCard,
  propertyMonthlyTotalsQuery,
} from "@/hooks/useProperties";

const from = vi.fn();
const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => from(table),
    rpc: (name: string, args: Record<string, unknown>) => rpc(name, args),
  },
}));

/** يحاكي حدّ PostgREST بسلسلة فلاتر تنتهي باستجابة محددة دون عزل الخطاف الداخلي. */
function stub(result: { data: unknown; error: unknown; count?: number }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "or", "order", "range"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

beforeEach(() => {
  from.mockReset();
  rpc.mockReset();
});

/**
 * عقار بخمس وحدات: ثلاث على عقد نشط، واحدة على عقد منتهٍ، وواحدة بلا عقد.
 *
 * Occupancy is "named by an active contract", never `units.status`. The expired
 * contract and the unlinked unit must both land in vacant, or the card would
 * disagree with the contracts table.
 */
const PROPERTY = "prop-1";
const units = [
  { id: "u-active-1", property_id: PROPERTY },
  { id: "u-active-2", property_id: PROPERTY },
  { id: "u-active-3", property_id: PROPERTY },
  { id: "u-expired", property_id: PROPERTY },
  { id: "u-none", property_id: PROPERTY },
];

describe("aggregatePropertyOccupancy", () => {
  it("counts a unit as occupied only when an active contract names it", () => {
    const occupancy = aggregatePropertyOccupancy(
      units,
      [
        { unit_id: "u-active-1", contract_id: "c-active" },
        { unit_id: "u-active-2", contract_id: "c-active" },
        { unit_id: "u-active-3", contract_id: "c-active" },
        { unit_id: "u-expired", contract_id: "c-expired" },
      ],
      [
        { id: "c-active", state: "active" },
        { id: "c-expired", state: "expired" },
      ],
    );

    expect(occupancy.get(PROPERTY)).toEqual({ occupiedUnits: 3, vacantUnits: 2 });
  });

  it("counts a unit named by an active and an expired contract once", () => {
    const occupancy = aggregatePropertyOccupancy(
      [{ id: "u-shared", property_id: PROPERTY }],
      [
        { unit_id: "u-shared", contract_id: "c-active" },
        { unit_id: "u-shared", contract_id: "c-expired" },
      ],
      [
        { id: "c-active", state: "active" },
        { id: "c-expired", state: "expired" },
      ],
    );

    expect(occupancy.get(PROPERTY)).toEqual({ occupiedUnits: 1, vacantUnits: 0 });
  });
});

describe("propertyMonthlyTotalsQuery", () => {
  it("asks the RPC for the month and maps string totals to numbers", async () => {
    rpc.mockResolvedValue({
      data: [{ property_id: "prop-a", monthly_total: "750.000" }],
      error: null,
    });

    const totals = await propertyMonthlyTotalsQuery("2026-09-01")();

    expect(rpc).toHaveBeenCalledWith("get_property_monthly_rent_totals", {
      p_period_start: "2026-09-01",
    });
    expect(totals.get("prop-a")).toBe(750);
  });
});

describe("fetchProperties", () => {
  it("orders the list by code ascending so cards follow PROP-001… numeric order", async () => {
    const propertiesQuery = stub({ data: [], error: null, count: 0 });
    from.mockImplementationOnce(() => propertiesQuery);

    await fetchProperties({ page: 1, pageSize: 10, search: "" });

    expect(propertiesQuery.order).toHaveBeenCalledWith("code", { ascending: true });
  });
});

describe("monthlyTotalForCard", () => {
  it("maps a building missing from a successful totals read to 0", () => {
    const totals = new Map([["prop-a", 750]]);
    expect(monthlyTotalForCard(totals, true, "prop-a")).toBe(750);
    expect(monthlyTotalForCard(totals, true, "prop-b")).toBe(0);
  });

  it("returns undefined while the totals read has not succeeded", () => {
    expect(monthlyTotalForCard(undefined, false, "prop-a")).toBeUndefined();
  });
});
