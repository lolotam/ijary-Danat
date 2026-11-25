import { describe, expect, test } from "vitest";

import { mapCatalogueOptions } from "@/lib/commercialActivityOptions";
import {
  buildUnitSubmitPayload,
  NO_UNIT_FLOOR,
  resolvePropertyFieldState,
  resolveUnitFormValues,
  SEEDED_UNIT_FLOORS,
  SEEDED_UNIT_TYPES,
  unitFormDefaults,
  unitFormSchema,
  type UnitFormValues,
} from "@/lib/unitForm";
import type { UnitRow } from "@/integrations/supabase/database.types";

const LOCKED_PROPERTY = "prop-complex-one";

function baseValues(overrides: Partial<UnitFormValues> = {}): UnitFormValues {
  return {
    ...unitFormDefaults,
    property_id: LOCKED_PROPERTY,
    name: "A-101",
    ...overrides,
  };
}

describe("resolvePropertyFieldState", () => {
  test("lockedPropertyId set → property field disabled and default equals that id", () => {
    const state = resolvePropertyFieldState(LOCKED_PROPERTY);
    expect(state.disabled).toBe(true);
    expect(state.defaultPropertyId).toBe(LOCKED_PROPERTY);
  });

  test("lockedPropertyId null/undefined → property field enabled, no forced value", () => {
    expect(resolvePropertyFieldState(null)).toEqual({
      disabled: false,
      defaultPropertyId: undefined,
    });
    expect(resolvePropertyFieldState(undefined)).toEqual({
      disabled: false,
      defaultPropertyId: undefined,
    });
    expect(resolvePropertyFieldState("")).toEqual({
      disabled: false,
      defaultPropertyId: undefined,
    });
  });
});

describe("resolveUnitFormValues + buildUnitSubmitPayload — locked create guard", () => {
  test("create with lockedPropertyId puts that id in form defaults", () => {
    const values = resolveUnitFormValues(null, LOCKED_PROPERTY);
    expect(values.property_id).toBe(LOCKED_PROPERTY);
  });

  test("submitted payload carries property_id in the locked case", () => {
    // Simulates: form reset with locked defaults, control disabled, user fills
    // name and saves. RHF state (not the DOM) must still send property_id.
    const values = resolveUnitFormValues(null, LOCKED_PROPERTY);
    values.name = "Shop 3";
    const payload = buildUnitSubmitPayload(values, LOCKED_PROPERTY);
    expect(payload.property_id).toBe(LOCKED_PROPERTY);
    expect(payload.property_id).toBeTruthy();
  });

  test("locked override wins even if form state property_id were empty", () => {
    // Belt-and-suspenders: if reset were skipped, the lock still stamps the id.
    const values = baseValues({ property_id: "" });
    const payload = buildUnitSubmitPayload(values, LOCKED_PROPERTY);
    expect(payload.property_id).toBe(LOCKED_PROPERTY);
  });

  test("unlocked create does not force a property_id", () => {
    const values = resolveUnitFormValues(null, null);
    expect(values.property_id).toBe("");
    const payload = buildUnitSubmitPayload(values);
    expect(payload.property_id).toBe("");
  });
});

describe("floor optional null semantics", () => {
  test("empty / sentinel floor becomes null, not empty string", () => {
    expect(buildUnitSubmitPayload(baseValues({ floor: NO_UNIT_FLOOR })).floor).toBeNull();
    expect(buildUnitSubmitPayload(baseValues({ floor: "" })).floor).toBeNull();
    expect(buildUnitSubmitPayload(baseValues({ floor: null })).floor).toBeNull();
  });

  test("selected floor value is preserved", () => {
    expect(buildUnitSubmitPayload(baseValues({ floor: "mezzanine" })).floor).toBe("mezzanine");
  });

  test("edit without floor maps to sentinel for the select", () => {
    const editing = {
      id: "u1",
      property_id: LOCKED_PROPERTY,
      name: "A-1",
      name_en: null,
      type: "apartment",
      floor: null,
      area: null,
      status: "vacant",
      electricity_meter_ownership: "company_owned",
      default_rent: null,
      description_ar: null,
      description_en: null,
      code: "U-1",
      building_id: null,
      created_at: "",
      updated_at: "",
    } as UnitRow;
    const values = resolveUnitFormValues(editing, LOCKED_PROPERTY);
    expect(values.floor).toBe(NO_UNIT_FLOOR);
  });
});

describe("floor options — no hardcoded allow-list", () => {
  /**
   * Regression guard for the Part C trap: if the form filtered catalogue items
   * against a hardcoded allow-list of the four seeds (as `useListDrivenOptions`
   * does for enum-backed lists), every floor the owner later adds in
   * Settings → Lists would be invisible. This suite fails that bug.
   */
  test("includes a catalogue value that is not one of the four seeds", () => {
    const custom = {
      value: "mezzanine",
      label_ar: "ميزانين",
      label_en: "Mezzanine",
    };
    expect(SEEDED_UNIT_FLOORS).not.toContain(custom.value);

    const options = mapCatalogueOptions(
      [{ value: "ground", label_ar: "الطابق الأرضي", label_en: "Ground" }, custom],
      "en",
    );

    expect(options.map((o) => o.value)).toContain("mezzanine");
    expect(options).toEqual(expect.arrayContaining([{ value: "mezzanine", label: "Mezzanine" }]));
  });
});

describe("unit type options — free text after migration 103", () => {
  /**
   * Regression guard for the reported bug: catalogue items whose value is not
   * an old enum member must still reach the unit type dropdown. Filtering via
   * useListDrivenOptions against the seven seeds would hide them again.
   */
  test("includes a catalogue value that is not an old enum member", () => {
    const custom = {
      value: "commercial_unit",
      label_ar: "وحدة تجارية",
      label_en: "Commercial",
    };
    expect(SEEDED_UNIT_TYPES).not.toContain(custom.value);

    const options = mapCatalogueOptions(
      [{ value: "shop", label_ar: "محل", label_en: "Shop" }, custom],
      "en",
    );

    expect(options.map((o) => o.value)).toContain("commercial_unit");
    expect(options).toEqual(
      expect.arrayContaining([{ value: "commercial_unit", label: "Commercial" }]),
    );
  });

  test("schema accepts free-text type and rejects empty", () => {
    const base = {
      property_id: "p1",
      paci_no: "",
      name: "U1",
      name_en: "",
      floor: NO_UNIT_FLOOR,
      area: undefined,
      status: "vacant" as const,
      electricity_meter_ownership: "company_owned" as const,
      default_rent: undefined,
      description_ar: "",
      description_en: "",
    };
    expect(unitFormSchema.safeParse({ ...base, type: "commercial_unit" }).success).toBe(true);
    expect(unitFormSchema.safeParse({ ...base, type: "" }).success).toBe(false);
    expect(unitFormSchema.safeParse({ ...base, type: "   " }).success).toBe(false);
  });
});

const schemaBase = {
  property_id: "p1",
  paci_no: "",
  name: "U1",
  name_en: "",
  type: "apartment",
  floor: NO_UNIT_FLOOR,
  area: undefined,
  status: "vacant" as const,
  electricity_meter_ownership: "company_owned" as const,
  default_rent: undefined,
  description_ar: "",
  description_en: "",
};

describe("unitFormSchema — paci_no", () => {
  test.each(["", "12345678"] as const)("paci_no %j parses", (paci_no) => {
    const result = unitFormSchema.safeParse({ ...schemaBase, paci_no });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.paci_no).toBe(paci_no);
  });

  test("still rejects empty name (adding paci_no did not loosen the contract)", () => {
    const result = unitFormSchema.safeParse({ ...schemaBase, name: "" });
    expect(result.success).toBe(false);
  });
});

describe("buildUnitSubmitPayload — the form never writes rent", () => {
  test("default_rent is absent from the payload whatever the form holds", () => {
    // The field is read-only on every unit now: it displays the active
    // contract's figure, or nothing. Sending it back would write a number the
    // form was only borrowing over whatever the column actually holds.
    const payload = buildUnitSubmitPayload(baseValues({ default_rent: 750 }), LOCKED_PROPERTY);
    expect("default_rent" in payload).toBe(false);
  });
});
