import { describe, expect, test } from "vitest";

import { omitDerivedStatus } from "@/hooks/useUnits";

/**
 * Migration 76 made `units.status` a projection of the unit's active contract.
 * The database refuses a contradicting write rather than accepting it silently,
 * so the client must not send the field for an occupied unit — the edit forms
 * disable it but still submit their whole shape.
 */
describe("omitDerivedStatus", () => {
  test("drops status when the unit is occupied, passing everything else through", () => {
    const result = omitDerivedStatus(
      { name: "Shop 4", area: 120, default_rent: 450, status: "vacant" },
      "occupied",
    );
    expect(result).toEqual({ name: "Shop 4", area: 120, default_rent: 450 });
  });

  test("drops status even when the submitted value agrees with reality", () => {
    // The disabled control submits `occupied`, which the trigger would accept —
    // but only because it happens to match. If the contract were terminated in
    // another tab between load and save, the same submission would post a stale
    // status against a unit that no longer has one.
    const result = omitDerivedStatus({ status: "occupied" }, "occupied");
    expect("status" in result).toBe(false);
  });

  test.each(["vacant", "under_maintenance", "archived"] as const)(
    "leaves status alone on a %s unit, which is the operator's to set",
    (currentStatus) => {
      const updates = { name: "Renamed", status: "under_maintenance" } as const;
      expect(omitDerivedStatus(updates, currentStatus)).toEqual(updates);
    },
  );

  test("is a no-op on an update that never carried a status", () => {
    const updates = { name: "Shop 4" };
    expect(omitDerivedStatus(updates, "occupied")).toEqual(updates);
  });
});
