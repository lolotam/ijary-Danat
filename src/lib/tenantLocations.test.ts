import { describe, expect, test } from "vitest";

import {
  dedupeById,
  resolveContractLocation,
  selectActiveContractByTenant,
  selectActiveContractsByTenant,
} from "@/lib/tenantLocations";

describe("selectActiveContractByTenant", () => {
  test("selects the latest active contract for each tenant", () => {
    const selected = selectActiveContractByTenant([
      {
        id: "older",
        tenant_id: "tenant-1",
        unit_ids: ["unit-a"],
        state: "active",
        start_date: "2025-01-01",
        end_date: "2025-12-31",
      },
      {
        id: "latest",
        tenant_id: "tenant-1",
        unit_ids: ["unit-b"],
        state: "active",
        start_date: "2025-02-01",
        end_date: "2026-01-31",
      },
      {
        id: "draft",
        tenant_id: "tenant-2",
        unit_ids: ["unit-c"],
        state: "draft",
        start_date: "2025-03-01",
        end_date: null,
      },
    ]);

    expect(selected.get("tenant-1")?.id).toBe("latest");
    expect(selected.get("tenant-1")?.end_date).toBe("2026-01-31");
    expect(selected.has("tenant-2")).toBe(false);
  });

  test("returns an empty map when no contract is active", () => {
    const selected = selectActiveContractByTenant([
      {
        id: "ended",
        tenant_id: "tenant-1",
        unit_ids: ["unit-a"],
        state: "ended",
        start_date: "2024-01-01",
        end_date: "2024-06-30",
      },
    ]);

    expect(selected.size).toBe(0);
  });

  test("keeps an active contract for every tenant", () => {
    const selected = selectActiveContractByTenant([
      {
        id: "one",
        tenant_id: "tenant-1",
        unit_ids: ["unit-1"],
        state: "active",
        start_date: "2025-01-01",
        end_date: "2025-12-31",
      },
      {
        id: "two",
        tenant_id: "tenant-2",
        unit_ids: ["unit-2"],
        state: "active",
        start_date: "2025-01-01",
        end_date: "2025-12-31",
      },
      {
        id: "three",
        tenant_id: "tenant-3",
        unit_ids: ["unit-3"],
        state: "active",
        start_date: "2025-01-01",
        end_date: "2025-12-31",
      },
    ]);

    expect([...selected.values()].map((contract) => contract.unit_ids)).toEqual([
      ["unit-1"],
      ["unit-2"],
      ["unit-3"],
    ]);
  });

  test("keeps every unit a contract holds, not just the first", () => {
    const selected = selectActiveContractByTenant([
      {
        id: "multi",
        tenant_id: "tenant-1",
        unit_ids: ["unit-a", "unit-b"],
        state: "active",
        start_date: "2025-01-01",
        end_date: "2025-12-31",
      },
    ]);

    expect(selected.get("tenant-1")?.unit_ids).toEqual(["unit-a", "unit-b"]);
  });
});

describe("selectActiveContractsByTenant", () => {
  test("keeps every active contract a tenant holds, newest start first", () => {
    const selected = selectActiveContractsByTenant([
      {
        id: "older",
        tenant_id: "tenant-1",
        unit_ids: ["unit-a"],
        state: "active",
        start_date: "2025-01-01",
        end_date: "2025-12-31",
      },
      {
        id: "latest",
        tenant_id: "tenant-1",
        unit_ids: ["unit-b"],
        state: "active",
        start_date: "2025-02-01",
        end_date: "2026-01-31",
      },
    ]);

    expect(selected.get("tenant-1")?.map((contract) => contract.id)).toEqual(["latest", "older"]);
  });

  test("drops contracts that are not active, whatever the tenant holds beside them", () => {
    const selected = selectActiveContractsByTenant([
      {
        id: "expired",
        tenant_id: "tenant-1",
        unit_ids: ["unit-a"],
        state: "expired",
        start_date: "2024-01-01",
        end_date: "2024-12-31",
      },
      {
        id: "active",
        tenant_id: "tenant-1",
        unit_ids: ["unit-b"],
        state: "active",
        start_date: "2025-01-01",
        end_date: "2025-12-31",
      },
    ]);

    expect(selected.get("tenant-1")?.map((contract) => contract.id)).toEqual(["active"]);
  });

  test("agrees with the singular selector on which contract is primary", () => {
    const contracts = [
      {
        id: "older",
        tenant_id: "tenant-1",
        unit_ids: ["unit-a"],
        state: "active",
        start_date: "2025-01-01",
        end_date: "2025-12-31",
      },
      {
        id: "latest",
        tenant_id: "tenant-1",
        unit_ids: ["unit-b"],
        state: "active",
        start_date: "2025-02-01",
        end_date: "2026-01-31",
      },
    ];

    expect(selectActiveContractByTenant(contracts).get("tenant-1")?.id).toBe(
      selectActiveContractsByTenant(contracts).get("tenant-1")?.[0].id,
    );
  });
});

describe("dedupeById", () => {
  test("shows a building once when two contracts sit in it", () => {
    const building = { id: "building-1", name_ar: "برج" };

    expect(dedupeById([building, building])).toEqual([building]);
  });

  test("keeps distinct buildings in first-seen order and drops nulls", () => {
    const first = { id: "building-1" };
    const second = { id: "building-2" };

    expect(dedupeById([first, null, second, first])).toEqual([first, second]);
  });
});

describe("resolveContractLocation", () => {
  const shopA = { id: "unit-a", property_id: "building-1", name: "Shop A" };
  const shopB = { id: "unit-b", property_id: "building-1", name: "Shop B" };
  const kiosk = { id: "unit-c", property_id: "building-2", name: "Kiosk" };
  const unitById = new Map([shopA, shopB, kiosk].map((unit) => [unit.id, unit]));
  const propertyById = new Map(
    [{ id: "building-1" }, { id: "building-2" }].map((property) => [property.id, property]),
  );

  test("returns every unit of a multi-unit contract, in the order given", () => {
    // The defect: the tenants list resolved unit_ids[0] alone, so a three-unit
    // contract showed one unit while the tenant detail page showed three.
    const { units } = resolveContractLocation(
      ["unit-a", "unit-b", "unit-c"],
      unitById,
      propertyById,
    );

    expect(units).toEqual([shopA, shopB, kiosk]);
  });

  test("returns every building those units span, each once", () => {
    const { properties } = resolveContractLocation(
      ["unit-a", "unit-b", "unit-c"],
      unitById,
      propertyById,
    );

    expect(properties.map((property) => property.id)).toEqual(["building-1", "building-2"]);
  });

  test("keeps the first unit first, because the list still sorts on one value", () => {
    const { units, properties } = resolveContractLocation(
      ["unit-c", "unit-a"],
      unitById,
      propertyById,
    );

    expect(units[0]).toBe(kiosk);
    expect(properties[0]?.id).toBe("building-2");
  });

  test("drops a unit id that resolves to nothing rather than leaving a gap", () => {
    // An unresolvable id is a unit the reader cannot see or that no longer
    // exists; an empty slot in a list of links reads as a bug.
    const { units } = resolveContractLocation(["unit-a", "missing"], unitById, propertyById);

    expect(units).toEqual([shopA]);
  });

  test("is empty for a contract with no units", () => {
    expect(resolveContractLocation([], unitById, propertyById)).toEqual({
      units: [],
      properties: [],
    });
  });
});
