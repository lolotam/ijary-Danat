import { describe, expect, it } from "vitest";

import { contractCsvRows, type ContractExportItem } from "@/lib/contractCsv";

/**
 * Minimal multi-unit contract fixture for CSV row-shape tests.
 * Only the fields the exporter reads — full table rows are not required.
 */
function contractWithThreeUnits(): ContractExportItem {
  return {
    code: "CTR-M",
    type: "lease",
    state: "active",
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    entry_date: "2026-01-01",
    duration_months: 12,
    monthly_amount: 450,
    deposit: 900,
    due_day: 1,
    grace_days: 5,
    concessionMonths: 0,
    end_date_override_reason: null,
    notes: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    tenant: { code: "T-1", name: "أحمد" },
    units: [
      {
        monthlyAmount: 100,
        unit: { code: "U-1", name: "محل 1" },
        property: { code: "P-1", name_ar: "مجمع أ", name_en: "Mall A" },
      },
      {
        monthlyAmount: 150,
        unit: { code: "U-2", name: "محل 2" },
        property: { code: "P-1", name_ar: "مجمع أ", name_en: "Mall A" },
      },
      {
        monthlyAmount: 200,
        unit: { code: "U-3", name: "محل 3" },
        property: { code: "P-2", name_ar: "مجمع ب", name_en: "Mall B" },
      },
    ],
  };
}

/**
 * Contract with no unit links — must still appear once in the export.
 */
function contractWithNoUnits(): ContractExportItem {
  return {
    ...contractWithThreeUnits(),
    code: "CTR-EMPTY",
    monthly_amount: 0,
    units: [],
  };
}

describe("contractCsvRows", () => {
  it("emits one row per unit on a multi-unit contract", () => {
    const rows = contractCsvRows([contractWithThreeUnits()]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.unit_code)).toEqual(["U-1", "U-2", "U-3"]);
  });

  it("repeats the contract's own columns on every unit row", () => {
    const rows = contractCsvRows([contractWithThreeUnits()]);
    expect(new Set(rows.map((r) => r.code)).size).toBe(1);
    expect(rows.every((r) => r.code === "CTR-M")).toBe(true);
    expect(rows.every((r) => r.tenant_code === "T-1")).toBe(true);
    expect(rows.every((r) => r.monthly_amount === "450")).toBe(true);
  });

  it("numbers the unit lines from 1", () => {
    expect(contractCsvRows([contractWithThreeUnits()]).map((r) => r.unit_line_order)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("still emits one row for a contract with no units", () => {
    // A contract must never vanish from its own export because a unit link is missing.
    const rows = contractCsvRows([contractWithNoUnits()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].unit_code).toBe("");
    expect(rows[0].unit_line_order).toBe("");
    expect(rows[0].code).toBe("CTR-EMPTY");
  });

  it("carries each unit's own monthly amount, not the contract total", () => {
    expect(contractCsvRows([contractWithThreeUnits()]).map((r) => r.unit_monthly_amount)).toEqual([
      "100",
      "150",
      "200",
    ]);
  });

  it("reads property columns from each unit's own property", () => {
    const rows = contractCsvRows([contractWithThreeUnits()]);
    expect(rows.map((r) => r.property_code)).toEqual(["P-1", "P-1", "P-2"]);
    expect(rows[2].property_name_en).toBe("Mall B");
  });
});
