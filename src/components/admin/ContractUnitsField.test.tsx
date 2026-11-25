import { describe, expect, it } from "vitest";

import { syncUnitRows, unitsAfterPropertyChange } from "./ContractUnitsField";

describe("syncUnitRows", () => {
  it("adds a rent row when a unit is selected", () => {
    const rows = syncUnitRows([], ["u1"]);
    expect(rows).toEqual([{ unit_id: "u1", monthly_amount: 0 }]);
  });

  it("keeps the amount already typed when another unit is added", () => {
    const rows = syncUnitRows([{ unit_id: "u1", monthly_amount: 400 }], ["u1", "u2"]);
    expect(rows).toEqual([
      { unit_id: "u1", monthly_amount: 400 },
      { unit_id: "u2", monthly_amount: 0 },
    ]);
  });

  it("drops the row and its amount when a unit is deselected", () => {
    const rows = syncUnitRows(
      [
        { unit_id: "u1", monthly_amount: 400 },
        { unit_id: "u2", monthly_amount: 350 },
      ],
      ["u2"],
    );
    expect(rows).toEqual([{ unit_id: "u2", monthly_amount: 350 }]);
  });

  it("orders rows by the selection order, which becomes line_order", () => {
    expect(syncUnitRows([], ["u3", "u1"]).map((r) => r.unit_id)).toEqual(["u3", "u1"]);
  });
});

const units = [
  { id: "u1", property_id: "p1", code: "A101", name: "Shop A" },
  { id: "u2", property_id: "p1", code: "A102", name: "Shop B" },
  { id: "u3", property_id: "p2", code: "B201", name: "Shop C" },
];

describe("unitsAfterPropertyChange", () => {
  it("deselecting a property drops its units and their amount rows", () => {
    const current = [
      { unit_id: "u1", monthly_amount: 400 },
      { unit_id: "u3", monthly_amount: 350 },
    ];
    // p1 (which owns u1) is dropped from the selection; only p2 remains.
    expect(unitsAfterPropertyChange(units, ["p2"], current)).toEqual([
      { unit_id: "u3", monthly_amount: 350 },
    ]);
  });

  it("keeps amounts already typed for units whose property is still selected", () => {
    const current = [{ unit_id: "u1", monthly_amount: 400 }];
    expect(unitsAfterPropertyChange(units, ["p1", "p2"], current)).toEqual([
      { unit_id: "u1", monthly_amount: 400 },
    ]);
  });

  it("selecting no properties clears every row", () => {
    const current = [
      { unit_id: "u1", monthly_amount: 400 },
      { unit_id: "u3", monthly_amount: 350 },
    ];
    expect(unitsAfterPropertyChange(units, [], current)).toEqual([]);
  });

  it("does not resurrect a unit that was manually deselected within a still-selected property", () => {
    // u2 shares p1 with u1 but was never added to `current` — re-confirming p1
    // must not silently select every unit under it.
    const current = [{ unit_id: "u1", monthly_amount: 400 }];
    expect(unitsAfterPropertyChange(units, ["p1"], current).map((r) => r.unit_id)).toEqual(["u1"]);
  });
});
