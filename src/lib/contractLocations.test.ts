import { describe, expect, test } from "vitest";

import { filterUnitsByLocation } from "@/lib/contractLocations";

describe("filterUnitsByLocation", () => {
  const units = [
    { id: "unit-a", property_id: "property-a", building_id: "building-a" },
    { id: "unit-b", property_id: "property-a", building_id: "building-b" },
    { id: "unit-c", property_id: "property-b", building_id: null },
  ];

  test("keeps only units in the selected property and building", () => {
    expect(filterUnitsByLocation(units, "property-a", "building-a")).toEqual([units[0]]);
  });

  test("keeps every property unit when no building is selected", () => {
    expect(filterUnitsByLocation(units, "property-a", null)).toEqual([units[0], units[1]]);
  });
});
