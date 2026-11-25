import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import {
  UNIT_FLOOR_TYPE_BINDING,
  boundUnitTypeFor,
  isCodeBoundValue,
  resolveUnitTypeBinding,
} from "@/lib/unitFloorTypeBinding";

const DOCUMENTED_PAIRS = [
  ["first", "commercial_unit_1st_floor"],
  ["basement", "commercial_unit_basment"],
  ["roof", "managemental-services"],
  ["ground", "shop_G_Floor"],
] as const;

const ACTIVE_TYPE_VALUES = DOCUMENTED_PAIRS.map(([, typeValue]) => typeValue);

describe("boundUnitTypeFor", () => {
  test.each(DOCUMENTED_PAIRS)("floor %j maps to %j", (floor, typeValue) => {
    expect(boundUnitTypeFor(floor)).toBe(typeValue);
  });

  test("unknown floor, null and undefined return null", () => {
    expect(boundUnitTypeFor("mezzanine")).toBeNull();
    expect(boundUnitTypeFor(null)).toBeNull();
    expect(boundUnitTypeFor(undefined)).toBeNull();
  });
});

describe("resolveUnitTypeBinding", () => {
  test.each(DOCUMENTED_PAIRS)(
    "floor %j locks to %j when the catalogue still has that type",
    (floor, typeValue) => {
      expect(resolveUnitTypeBinding({ floor, activeTypeValues: ACTIVE_TYPE_VALUES })).toEqual({
        boundType: typeValue,
        locked: true,
      });
    },
  );

  test("unknown floor, null and undefined return null / locked: false", () => {
    expect(
      resolveUnitTypeBinding({ floor: "mezzanine", activeTypeValues: ACTIVE_TYPE_VALUES }),
    ).toEqual({ boundType: null, locked: false });
    expect(resolveUnitTypeBinding({ floor: null, activeTypeValues: ACTIVE_TYPE_VALUES })).toEqual({
      boundType: null,
      locked: false,
    });
    expect(
      resolveUnitTypeBinding({ floor: undefined, activeTypeValues: ACTIVE_TYPE_VALUES }),
    ).toEqual({ boundType: null, locked: false });
  });

  test("locked is false when the mapped type is absent from the catalogue", () => {
    expect(
      resolveUnitTypeBinding({
        floor: "roof",
        activeTypeValues: ["shop_G_Floor"],
      }),
    ).toEqual({ boundType: "managemental-services", locked: false });
    expect(resolveUnitTypeBinding({ floor: "first", activeTypeValues: [] })).toEqual({
      boundType: "commercial_unit_1st_floor",
      locked: false,
    });
  });
});

describe("isCodeBoundValue", () => {
  test.each(["first", "basement", "roof", "ground"])(
    "unit_floors value %j is code-bound",
    (floor) => {
      expect(isCodeBoundValue("unit_floors", floor)).toBe(true);
    },
  );

  test.each([
    "commercial_unit_1st_floor",
    "commercial_unit_basment",
    "managemental-services",
    "shop_G_Floor",
  ])("unit_types value %j is code-bound", (typeValue) => {
    expect(isCodeBoundValue("unit_types", typeValue)).toBe(true);
  });

  test("an unrelated list is never code-bound", () => {
    // A rename guard that fires on every list would block ordinary catalogue
    // maintenance; the binding only covers the two lists it reads.
    expect(isCodeBoundValue("property_types", "shop_G_Floor")).toBe(false);
    expect(isCodeBoundValue("gmail_categories", "first")).toBe(false);
  });

  test('"toString" on unit_floors is not code-bound', () => {
    // `value in OBJ` walks the prototype chain, so "toString" would read as
    // bound and its input would lock for no reason. Object.hasOwn is the fix;
    // this pins it.
    expect(isCodeBoundValue("unit_floors", "toString")).toBe(false);
  });
});

describe("UNIT_FLOOR_TYPE_BINDING stays in step with migration 239", () => {
  /**
   * يحقّق أن قيمة السطح المربوطة هي نفس القيمة التي تصلحها الترحيلة 239.
   *
   * The binding literal and the migration repair literal name the same value
   * from opposite sides: change one without the other and the floor lock
   * reads a value the database no longer stores (or vice versa).
   */
  test("roof equals the value migration 239 repairs units to", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "db/migrations/239_option_list_value_rename.sql"),
      "utf8",
    );
    const repaired = migration.match(/update public\.units set type = '([^']+)'/);
    expect(repaired?.[1]).toBeTruthy();
    expect(UNIT_FLOOR_TYPE_BINDING.roof).toBe(repaired![1]);
  });
});

describe("UNIT_FLOOR_TYPE_BINDING stays in step with migration 148", () => {
  /**
   * يحقّق أن قيم الربط غير المُعاد تسميتها موجودة في بذرة قاعدة البيانات.
   *
   * Migration 148 seeded the old `Roof_Apartment` roof value, and migration
   * 239 deliberately renames that seeded row and cascades the stored units —
   * so the roof pair can no longer be asserted against the seed it replaces.
   * The Tests lane asserts the roof value against migration 239's repair
   * literal instead (plan Task 7 Step 7).
   */
  test("every unrenamed bound type value appears in the seed SQL", () => {
    const seed = readFileSync(
      resolve(process.cwd(), "db/migrations/148_seed_bound_unit_types.sql"),
      "utf8",
    );
    for (const [floor, typeValue] of DOCUMENTED_PAIRS) {
      if (floor === "roof") continue;
      expect(seed).toContain(`"value": "${typeValue}"`);
    }
  });
});
