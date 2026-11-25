import { describe, expect, test } from "vitest";

import { importSchemas, validateImportRows } from "@/lib/bulkImportSchemas";
import { importTemplateHeaders } from "@/lib/bulkImportTemplates";

describe("maintenance CSV validation", () => {
  test("accepts a request identified by property code", () => {
    const parsed = importSchemas.maintenance.safeParse({
      property_code: "PROP-001",
      title: "Repair lobby light",
      priority: "high",
      status: "open",
    });

    expect(parsed.success).toBe(true);
  });
});

describe("bulk import templates", () => {
  test("uses codes instead of UUIDs for a unit relationship", () => {
    expect(importTemplateHeaders.units).toEqual([
      "code",
      "property_code",
      "building_code",
      "name",
      "type",
      "area",
      "status",
      "electricity_meter_ownership",
      "default_rent",
      "description_ar",
      "description_en",
    ]);
  });
});

describe("expense CSV class", () => {
  const row = (cls: string) => ({
    amount: "25",
    class: cls,
    recurrence: "monthly",
    expense_date: "2026-09-01",
  });

  test("rejects contractual_monthly with a per-row error naming the class and the row", () => {
    // User decision M14: not a real expense class. The expense screen cannot
    // produce it, so an imported one was reclassified on its first save.
    const { errors, validRows } = validateImportRows("expenses", [
      row("regular_recurring"),
      row("contractual_monthly"),
    ]);

    expect(validRows).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].row).toBe(3);
    expect(errors[0].fields).toEqual(["class"]);
    expect(errors[0].message).toContain("contractual_monthly is not an importable expense class");
  });

  test.each(["contractual_annual", "regular_recurring", "sudden_one_time"])(
    "still accepts %s",
    (cls) => {
      expect(importSchemas.expenses.safeParse(row(cls)).success).toBe(true);
    },
  );

  test("still defaults a blank class to regular_recurring", () => {
    const parsed = importSchemas.expenses.safeParse(row(""));
    expect(parsed.success && parsed.data.class).toBe("regular_recurring");
  });
});
