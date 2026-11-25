import { describe, expect, it } from "vitest";

import { isRoofContract } from "@/lib/isRoofContract";
import { UNIT_FLOOR_TYPE_BINDING } from "@/lib/unitFloorTypeBinding";

/** يبني وحدة عقد بأقل ما تحتاجه دالة الكشف. */
function unitWith(fields: { floor?: string | null; type?: string | null }) {
  return { unit: { floor: null, type: null, ...fields } };
}

describe("isRoofContract", () => {
  it("recognises a contract whose unit sits on the roof floor", () => {
    expect(isRoofContract([unitWith({ floor: "roof" })])).toBe(true);
  });

  /**
   * The roof unit type is a catalogue value the owner has renamed before
   * (`Roof_Apartment` → `managemental-services`, migration 239); the binding
   * module is the only place that spelling lives — asserting through the binding rather
   * than a retyped literal is what keeps the two from drifting apart.
   */
  it("recognises the bound roof unit type even when the floor says otherwise", () => {
    expect(isRoofContract([unitWith({ type: UNIT_FLOOR_TYPE_BINDING.roof })])).toBe(true);
  });

  it("finds the roof unit in a multi-unit contract that also holds a shop", () => {
    expect(
      isRoofContract([
        unitWith({ floor: "ground", type: "shop_G_Floor" }),
        unitWith({ floor: "roof" }),
      ]),
    ).toBe(true);
  });

  it.each([
    ["a ground-floor shop", unitWith({ floor: "ground", type: "shop_G_Floor" })],
    ["a unit with no floor or type recorded", unitWith({})],
    ["a contract whose unit row failed to load", { unit: null }],
  ])("does not call %s a roof contract", (_scenario, unit) => {
    expect(isRoofContract([unit])).toBe(false);
  });

  // A contract with no units yet must not be badged as roof — the admin has
  // simply not linked one, which says nothing about what it is.
  it("returns false for a contract with no units", () => {
    expect(isRoofContract([])).toBe(false);
  });

  /**
   * Matching is exact on purpose. Lower-casing here would make the helper
   * recognise values the database does not hold, and the badge would then
   * disagree with `unitFloorTypeBinding`, which the unit form actually binds on.
   */
  it("does not match a differently-cased floor value", () => {
    expect(isRoofContract([unitWith({ floor: "Roof" })])).toBe(false);
  });
});
