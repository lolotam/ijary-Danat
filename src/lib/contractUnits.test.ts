import { describe, expect, it } from "vitest";

import {
  aggregateUnitsForProperties,
  cappedOccupancyUnitIds,
  joinLocalizedList,
  OCCUPANCY_UNIT_ID_LIMIT,
  totalMonthlyAmount,
} from "./contractUnits";

const units = [
  { id: "u1", property_id: "p1", code: "A101", name: "Shop A" },
  { id: "u2", property_id: "p2", code: "B205", name: "Shop B" },
  { id: "u3", property_id: "p3", code: "C310", name: "Store C" },
];

describe("aggregateUnitsForProperties", () => {
  it("returns the union of units across every selected property", () => {
    expect(aggregateUnitsForProperties(units, ["p1", "p2"]).map((u) => u.id)).toEqual(["u1", "u2"]);
  });

  it("returns nothing when no property is selected, so the picker starts empty", () => {
    expect(aggregateUnitsForProperties(units, [])).toEqual([]);
  });

  it("ignores a selected property that has no units", () => {
    expect(aggregateUnitsForProperties(units, ["p1", "p9"]).map((u) => u.id)).toEqual(["u1"]);
  });
});

describe("cappedOccupancyUnitIds", () => {
  /** يبني قائمة معرّفات وحدات بالطول المطلوب. */
  const ids = (count: number, prefix = "a") =>
    Array.from({ length: count }, (_, index) => `${prefix}${index}`);

  it("keeps every selected id even when the available list overflows the cap", () => {
    // The one that matters. This list decides which units get checked for an
    // existing active contract; a selected id dropped here is a unit that can
    // be let twice, silently, because the save guard never sees it.
    const selected = ["chosen-1", "chosen-2"];
    const result = cappedOccupancyUnitIds(ids(OCCUPANCY_UNIT_ID_LIMIT * 2), selected);

    expect(result).toEqual(expect.arrayContaining(selected));
    expect(result).toHaveLength(OCCUPANCY_UNIT_ID_LIMIT);
  });

  it("includes a selected unit that is not on offer at all", () => {
    // Reopening a saved contract whose unit fell outside the paginated
    // useUnits page. Filtering to the offered units alone would drop it.
    expect(cappedOccupancyUnitIds(["u1"], ["u9"])).toEqual(expect.arrayContaining(["u9"]));
  });

  it("lists a unit once when it is both selected and on offer", () => {
    expect(cappedOccupancyUnitIds(["u1", "u2"], ["u1"])).toEqual(["u1", "u2"]);
  });

  it("never exceeds the cap, because the ids ride in a GET query string", () => {
    expect(cappedOccupancyUnitIds(ids(OCCUPANCY_UNIT_ID_LIMIT + 50), [])).toHaveLength(
      OCCUPANCY_UNIT_ID_LIMIT,
    );
  });

  it("returns the available units when nothing is selected yet", () => {
    expect(cappedOccupancyUnitIds(["u1", "u2"], [])).toEqual(["u1", "u2"]);
  });

  it("returns nothing when there is nothing to ask about", () => {
    expect(cappedOccupancyUnitIds([], [])).toEqual([]);
  });
});

describe("totalMonthlyAmount", () => {
  it("sums the per-unit rents", () => {
    expect(totalMonthlyAmount([{ monthly_amount: 400 }, { monthly_amount: 350.5 }])).toBe(750.5);
  });

  it("is zero for no units, so an empty form shows no rent", () => {
    expect(totalMonthlyAmount([])).toBe(0);
  });
});

describe("joinLocalizedList", () => {
  it("joins Arabic labels with the Arabic comma", () => {
    expect(joinLocalizedList(["A101", "B205"], "ar")).toBe("A101، B205");
  });

  it("joins English labels with a Latin comma", () => {
    expect(joinLocalizedList(["A101", "B205"], "en")).toBe("A101, B205");
  });

  it("names every unit rather than picking the first", () => {
    expect(joinLocalizedList(["A101", "B205", "C310"], "en")).toBe("A101, B205, C310");
  });

  it("returns a single label unchanged", () => {
    expect(joinLocalizedList(["A101"], "en")).toBe("A101");
  });
});
