import { describe, expect, test } from "vitest";

import { validateResolvedLocation } from "@/lib/bulkImportRelations";

describe("validateResolvedLocation", () => {
  test("rejects a building outside the selected property", () => {
    expect(
      validateResolvedLocation({
        propertyId: "property-a",
        building: { id: "building-b", property_id: "property-b" },
        unit: null,
      }),
    ).toBe("building_code does not belong to property_code");
  });
});
