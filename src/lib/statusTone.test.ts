import { describe, expect, test } from "vitest";

import { contractDurationTone, unitTypeTone } from "@/lib/statusTone";
import { SEEDED_UNIT_TYPES } from "@/lib/unitForm";

/**
 * Unit type is free text after migration 103, so `unitTypeTone` can no longer
 * enumerate its inputs. Before this, every value outside the seven seeds shared
 * the same grey — so a type the owner added in Settings → Lists looked like a
 * different KIND of thing from the seeded types sitting next to it in the table.
 */
describe("unitTypeTone — free-text values after migration 103", () => {
  test("the seven seeds keep the colours operators already know", () => {
    expect(unitTypeTone("apartment")).toBe("info");
    expect(unitTypeTone("shop")).toBe("violet");
    expect(unitTypeTone("office")).toBe("indigo");
    expect(unitTypeTone("commercial")).toBe("teal");
    expect(unitTypeTone("warehouse")).toBe("orange");
    expect(unitTypeTone("villa")).toBe("pink");
    expect(unitTypeTone("other")).toBe("neutral");
  });

  test("an owner-added type is not grey", () => {
    // `commercial_unit` is the value migration 103 normalised into the
    // catalogue, and the one that surfaced this whole bug.
    expect(SEEDED_UNIT_TYPES).not.toContain("commercial_unit");
    expect(unitTypeTone("commercial_unit")).not.toBe("neutral");
  });

  test("the same value always yields the same colour", () => {
    // The property that makes hashing acceptable here. A random pick would
    // recolour every badge on each render.
    for (const value of ["commercial_unit", "mezzanine", "kiosk", "مخزن كبير"]) {
      expect(unitTypeTone(value)).toBe(unitTypeTone(value));
    }
  });

  test("the values actually in the catalogue get distinct colours", () => {
    // Deliberately NOT a general uniqueness claim: eight tones cannot colour
    // nine types apart. This pins the realistic set, and caught a real
    // collision — a char-code sum put "kiosk" and "mezzanine" on one colour
    // because it ignores letter position.
    const tones = ["commercial_unit", "kiosk", "mezzanine"].map(unitTypeTone);
    expect(new Set(tones).size).toBe(tones.length);
  });
});

/**
 * Duration was a bare number in a column of numbers, so "which contracts are on
 * the five-year term" meant reading every row. Colour answers it at a glance —
 * but only if the terms actually in use are coloured apart, which is what these
 * pin.
 */
describe("contractDurationTone", () => {
  const LISTED_TERMS = [6, 12, 24, 36, 60, 120, 180];

  test("every common lease term gets a colour of its own", () => {
    const tones = LISTED_TERMS.map(contractDurationTone);
    expect(new Set(tones).size).toBe(LISTED_TERMS.length);
  });

  test("a term is never the colour this codebase uses for no value", () => {
    // `neutral` is the em-dash grey. A contract on a real term is not that.
    for (const months of [...LISTED_TERMS, 1, 18, 48, 999]) {
      expect(contractDurationTone(months)).not.toBe("neutral");
    }
  });

  test("the same term always yields the same colour", () => {
    // The property that makes this usable across two screens: the contracts
    // table and the tenant's contract details must agree without sharing state.
    for (const months of [24, 60, 180, 18]) {
      expect(contractDurationTone(months)).toBe(contractDurationTone(months));
    }
  });

  test("unlisted multiples of twelve do not collapse onto one colour", () => {
    // The reason the fallback palette's length is prime. Over eight tones every
    // multiple of 12 landed on just two colours, and over the djb2 hash that
    // unit types use, 12/18/24/30/36 were all one colour — both of which defeat
    // the entire point of colouring this column.
    const tones = [48, 72, 84, 96, 144].map(contractDurationTone);
    expect(new Set(tones).size).toBe(5);
  });

  test("a nonsensical count still resolves to a real tone", () => {
    // `%` on a negative is negative in JS, which would index past the array and
    // hand `undefined` to the Badge variant — a crash, not a wrong colour.
    for (const months of [-24, 0, 12.5]) {
      expect(contractDurationTone(months)).toBeTruthy();
    }
  });
});
