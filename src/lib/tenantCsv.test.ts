import { describe, expect, it } from "vitest";

import { tenantCsvRows, type TenantExportItem } from "@/lib/tenantCsv";

/**
 * Minimal multi-contract tenant fixture for CSV row-shape tests.
 */
function tenantWithTwoContracts(): TenantExportItem {
  return {
    code: "T-1",
    name: "أحمد",
    category: "standard",
    lifecycle: "active",
    nationality: "KW",
    preferred_language: "ar",
    mobile: "50000000",
    whatsapp: null,
    email: "a@example.com",
    commercial_name: null,
    commercial_name_ar: null,
    commercial_name_en: null,
    authorized_manager: null,
    authorized_manager_civil_id: null,
    owner_civil_id: null,
    commercial_address: null,
    notes: null,
    tenant_portal_enabled: true,
    reminders_enabled: true,
    receipt_visible_to_tenant: false,
    activeContracts: [
      {
        contract: {
          code: "CTR-1",
          state: "active",
          start_date: "2026-01-01",
          end_date: "2026-12-31",
          monthly_amount: 250,
        },
        units: [
          { code: "U-1", name: "محل 1", name_en: "Shop 1" },
          { code: "U-2", name: "محل 2", name_en: "Shop 2" },
        ],
        properties: [
          { code: "P-1", name_ar: "مجمع أ", name_en: "Mall A" },
          { code: "P-2", name_ar: "مجمع ب", name_en: "Mall B" },
        ],
      },
      {
        contract: {
          code: "CTR-2",
          state: "active",
          start_date: "2026-03-01",
          end_date: "2027-02-28",
          monthly_amount: 100,
        },
        units: [{ code: "U-9", name: "محل 9", name_en: "Shop 9" }],
        properties: [{ code: "P-9", name_ar: "مجمع ت", name_en: "Mall C" }],
      },
    ],
  };
}

/**
 * Tenant with no contracts — must still appear once in the export.
 */
function tenantWithNoContracts(): TenantExportItem {
  return {
    ...tenantWithTwoContracts(),
    code: "T-EMPTY",
    activeContracts: [],
  };
}

describe("tenantCsvRows", () => {
  it("emits one row per contract for a multi-contract tenant", () => {
    const rows = tenantCsvRows([tenantWithTwoContracts()]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.contract_code)).toEqual(["CTR-1", "CTR-2"]);
  });

  it("numbers the contracts from 1 so the reader can order them", () => {
    expect(tenantCsvRows([tenantWithTwoContracts()]).map((r) => r.contract_index)).toEqual([
      "1",
      "2",
    ]);
  });

  it("repeats the tenant's own columns on every contract row", () => {
    const rows = tenantCsvRows([tenantWithTwoContracts()]);
    expect(new Set(rows.map((r) => r.code)).size).toBe(1);
    expect(rows.every((r) => r.code === "T-1")).toBe(true);
    expect(rows.every((r) => r.name === "أحمد")).toBe(true);
  });

  it("scopes properties and units to the contract on that row", () => {
    const rows = tenantCsvRows([tenantWithTwoContracts()]);
    expect(rows[0].connected_unit_code).toBe("U-1; U-2"); // contract 1 only
    expect(rows[1].connected_unit_code).toBe("U-9"); // contract 2 only
    expect(rows[0].connected_property_code).toBe("P-1; P-2");
    expect(rows[1].connected_property_code).toBe("P-9");
  });

  it("still emits one row for a tenant with no contracts", () => {
    // A tenant must never disappear from the tenant export.
    const rows = tenantCsvRows([tenantWithNoContracts()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].contract_code).toBe("");
    expect(rows[0].contract_index).toBe("");
    expect(rows[0].code).toBe("T-EMPTY");
  });

  it("exports the civil-ID and address columns instead of the retired ones", () => {
    const rows = tenantCsvRows([
      {
        ...tenantWithNoContracts(),
        owner_civil_id: "289123456789",
        authorized_manager_civil_id: "280111222333",
        commercial_address: "السالمية",
      },
    ]);
    expect(rows[0].owner_civil_id).toBe("289123456789");
    expect(rows[0].authorized_manager_civil_id).toBe("280111222333");
    expect(rows[0].commercial_address).toBe("السالمية");
    expect(rows[0]).not.toHaveProperty("owner_name");
    expect(rows[0]).not.toHaveProperty("alternate_contacts");
  });

  it("emits per-contract dates and state instead of joined active_contract_* cells", () => {
    const rows = tenantCsvRows([tenantWithTwoContracts()]);
    expect(rows[0].contract_start_date).toBe("2026-01-01");
    expect(rows[1].contract_start_date).toBe("2026-03-01");
    expect(rows[0].contract_state).toBe("active");
    expect(rows[0].contract_monthly_amount).toBe("250");
    // Dropped columns must not reappear — joined multi-contract cells are gone.
    expect(rows[0]).not.toHaveProperty("connected_contract_codes");
    expect(rows[0]).not.toHaveProperty("active_contract_start_date");
    expect(rows[0]).not.toHaveProperty("active_contract_end_date");
    expect(rows[0]).not.toHaveProperty("connected_contract_states");
  });
});
