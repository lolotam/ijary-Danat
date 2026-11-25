import { describe, expect, test } from "vitest";

import { UNIT_FLOOR_TYPE_BINDING } from "@/lib/unitFloorTypeBinding";

import type { ContractPlot } from "./schema";
import { stripBoldMarkers } from "./boldMarkers";
import { FIXTURE_PLOT } from "./schema.fixture";
import {
  formatUnitList,
  isRoofUnit,
  selectableUnits,
  togglePlot,
  toggleUnit,
  type SelectableUnitRow,
} from "./units";

/** يبني صف وحدة كما يعيده استعلام منشئ العقد. */
function row(overrides: Partial<SelectableUnitRow> = {}): SelectableUnitRow {
  return {
    id: "unit-1",
    code: "U-1",
    name: "1",
    name_en: null,
    paci_no: "22023211",
    floor: "ground",
    type: "shop_G_Floor",
    property_id: FIXTURE_PLOT.id,
    status: null,
    ...overrides,
  };
}

const PLOT_B: ContractPlot = { id: "plot-b", name_ar: "مجمع دانة -2", name_en: "Danat -2" };

describe("roof exclusion", () => {
  test.each([
    [{ floor: "roof", type: UNIT_FLOOR_TYPE_BINDING.roof }, true],
    [{ floor: "roof", type: "shop_G_Floor" }, true],
    [{ floor: " Roof ", type: null }, true],
    [{ floor: "ground", type: UNIT_FLOOR_TYPE_BINDING.roof }, true],
    [{ floor: "ground", type: "shop_G_Floor" }, false],
    [{ floor: null, type: "advertise" }, false],
  ])("isRoofUnit(%o) is %s", (markers, expected) => {
    expect(isRoofUnit(markers)).toBe(expected);
  });

  test("selectableUnits keeps every non-roof row in order", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "roof", floor: "roof", type: UNIT_FLOOR_TYPE_BINDING.roof }),
      row({ id: "b", floor: "basement", type: "commercial_unit_basment" }),
    ];
    expect(selectableUnits(rows).map((unit) => unit.id)).toEqual(["a", "b"]);
  });
});

describe("formatUnitList", () => {
  const line = (
    unit_number: string,
    paci_no: string,
    property_id = FIXTURE_PLOT.id,
    unit_number_en = "",
  ) => ({ unit_id: `u-${unit_number}`, property_id, unit_number, unit_number_en, paci_no });

  test("one plot lists units with their PACI number and no plot name", () => {
    const text = formatUnitList(
      { plots: [FIXTURE_PLOT], units: [line("3", "111"), line("4", "")] },
      "ar",
    );
    expect(stripBoldMarkers(text)).toBe("3 (الرقم الآلي 111) و 4");
  });

  test("several plots group units under each plot's name, in selection order", () => {
    const values = {
      plots: [PLOT_B, FIXTURE_PLOT],
      units: [line("3", "111"), line("7", "222", PLOT_B.id), line("4", "333")],
    };
    expect(stripBoldMarkers(formatUnitList(values, "en"))).toBe(
      "7 (PACI No. 222) in Danat -2; and 3 (PACI No. 111) and 4 (PACI No. 333) in Danat Jahra Commercial Complex -1",
    );
    expect(stripBoldMarkers(formatUnitList(values, "ar"))).toBe(
      "7 (الرقم الآلي 222) في مجمع دانة -2، و 3 (الرقم الآلي 111) و 4 (الرقم الآلي 333) في مجمع دانة الجهراء التجاري -1",
    );
  });

  test("each language prints its own unit name, English falling back to Arabic", () => {
    const values = {
      plots: [FIXTURE_PLOT],
      units: [line("جهة تجارية - 10", "", FIXTURE_PLOT.id, "Commercial Unit - 10"), line("5", "")],
    };
    expect(stripBoldMarkers(formatUnitList(values, "en"))).toBe("Commercial Unit - 10 and 5");
    expect(stripBoldMarkers(formatUnitList(values, "ar"))).toBe("جهة تجارية - 10 و 5");
  });

  test("an English document falls back to the Arabic plot name when name_en is empty", () => {
    const unnamed = { ...PLOT_B, name_en: "" };
    const text = formatUnitList(
      { plots: [FIXTURE_PLOT, unnamed], units: [line("3", ""), line("7", "", PLOT_B.id)] },
      "en",
    );
    expect(stripBoldMarkers(text)).toContain("7 in مجمع دانة -2");
  });
});

describe("selection toggles", () => {
  test("removing a plot drops its selected units and keeps the others", () => {
    const units = toggleUnit(
      toggleUnit([], row({ id: "a" }), true, 6),
      row({ id: "b", property_id: PLOT_B.id }),
      true,
      6,
    );
    const next = togglePlot({ plots: [FIXTURE_PLOT, PLOT_B], units }, PLOT_B, false);
    expect(next.plots).toEqual([FIXTURE_PLOT]);
    expect(next.units.map((unit) => unit.unit_id)).toEqual(["a"]);
  });

  test("adding an already selected plot changes nothing", () => {
    const values = { plots: [FIXTURE_PLOT], units: [] };
    expect(togglePlot(values, FIXTURE_PLOT, true)).toBe(values);
  });

  test("a unit line takes its PACI number and display number from the row", () => {
    expect(
      toggleUnit(
        [],
        row({ name: " ", name_en: " Shop 9 ", code: "U-9", paci_no: " 555 " }),
        true,
        6,
      ),
    ).toEqual([
      {
        unit_id: "unit-1",
        property_id: FIXTURE_PLOT.id,
        unit_number: "U-9",
        unit_number_en: "Shop 9",
        paci_no: "555",
      },
    ]);
  });

  test("adding past the limit or twice returns the lines unchanged", () => {
    const one = toggleUnit([], row({ id: "a" }), true, 1);
    expect(toggleUnit(one, row({ id: "b" }), true, 1)).toBe(one);
    expect(toggleUnit(one, row({ id: "a" }), true, 6)).toBe(one);
    expect(toggleUnit(one, row({ id: "a" }), false, 6)).toEqual([]);
  });
});
