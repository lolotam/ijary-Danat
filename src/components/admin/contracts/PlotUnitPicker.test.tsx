/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm, type UseFormReturn } from "react-hook-form";
import { afterEach, describe, expect, test } from "vitest";

import { t } from "@/i18n/dictionary";
import type { Locale } from "@/i18n/dictionary";
import { buildContractHtml } from "@/lib/contractBuilder/html";
import { FIXTURE_PLOT, validContractValues } from "@/lib/contractBuilder/schema.fixture";
import type { ContractBuilderValues } from "@/lib/contractBuilder/schema";
import type { SelectableUnitRow } from "@/lib/contractBuilder/units";
import { PlotUnitPicker, type PickerProperty } from "./PlotUnitPicker";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const LOCALE: Locale = "en";
const PROPERTY: PickerProperty = { code: "PROP-001", ...FIXTURE_PLOT };

/** صفوف الاختبار: وحدة مؤجرة ووحدة شاغرة ووحدة بلا حالة. */
const UNITS: SelectableUnitRow[] = [
  {
    id: "unit-occupied",
    code: "U-1",
    name: "1",
    name_en: "Shop 1",
    paci_no: "10000001",
    floor: "ground",
    type: "shop_G_Floor",
    property_id: FIXTURE_PLOT.id,
    status: "occupied",
  },
  {
    id: "unit-vacant",
    code: "U-2",
    name: "2",
    name_en: "Shop 2",
    paci_no: "10000002",
    floor: "ground",
    type: "shop_G_Floor",
    property_id: FIXTURE_PLOT.id,
    status: "vacant",
  },
  {
    id: "unit-unknown",
    code: "U-3",
    name: "3",
    name_en: "Shop 3",
    paci_no: "10000003",
    floor: "ground",
    type: "shop_G_Floor",
    property_id: FIXTURE_PLOT.id,
    status: null,
  },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let form: UseFormReturn<ContractBuilderValues>;

/**
 * يركب المنتقي على نموذج حقيقي بلا شبكة، حتى تختبر النقرات قيم النموذج فعلاً.
 */
function Harness({ units }: { units: SelectableUnitRow[] }) {
  form = useForm<ContractBuilderValues>({
    defaultValues: validContractValues({ plots: [FIXTURE_PLOT], units: [] }),
  });
  return (
    <PlotUnitPicker
      form={form}
      t={(key) => t(LOCALE, key)}
      locale={LOCALE}
      properties={[PROPERTY]}
      units={units}
      unitsLoading={false}
    />
  );
}

/**
 * يعزل شجرة DOM لكل سيناريو لتجنب تسرب حالة النموذج.
 */
async function mount(units: SelectableUnitRow[] = UNITS) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness units={units} />));
}

/**
 * يعيد مربعات اختيار الوحدات داخل قائمة القسيمة.
 */
function unitBoxes(): HTMLButtonElement[] {
  return [
    ...container!.querySelectorAll<HTMLButtonElement>(
      '[data-testid="plot-units"] [role="checkbox"]',
    ),
  ];
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("occupancy badges", () => {
  test.each([
    ["occupied", "Occupied"],
    ["vacant", "Vacant"],
  ] as const)("a %s unit shows its unitStatus label", async (status, label) => {
    await mount(UNITS.filter((row) => row.status === status));
    const badge = container!.querySelector('[data-testid="unit-occupancy"]')!;
    expect(badge.textContent).toBe(label);
  });

  test("a unit with no status shows no badge", async () => {
    await mount(UNITS.filter((row) => row.status === null));
    expect(container!.querySelector('[data-testid="unit-occupancy"]')).toBeNull();
  });

  test("badges sit beside their own units in a mixed list", async () => {
    await mount();
    const badges = [...container!.querySelectorAll('[data-testid="unit-occupancy"]')];
    expect(badges.map((badge) => badge.textContent)).toEqual(["Occupied", "Vacant"]);
    const unknownRow = unitBoxes()[2]!.closest("label")!;
    expect(unknownRow.querySelector('[data-testid="unit-occupancy"]')).toBeNull();
  });
});

describe("selection and printed contract", () => {
  test("selecting an occupied unit stores no status on the form line", async () => {
    await mount();
    await act(async () => unitBoxes()[0]!.click());
    const lines = form.getValues("units");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      unit_id: "unit-occupied",
      property_id: FIXTURE_PLOT.id,
      unit_number: "1",
      unit_number_en: "Shop 1",
      paci_no: "10000001",
    });
    expect("status" in lines[0]!).toBe(false);
  });

  test.each([["ar"], ["en"]] as const)(
    "the printed contract for an occupied selection names no status label (%s)",
    async (locale) => {
      await mount();
      await act(async () => unitBoxes()[0]!.click());
      const html = buildContractHtml(
        { ...form.getValues(), plots: [{ ...FIXTURE_PLOT }] },
        locale,
        "data:,",
      );
      for (const label of ["مؤجر", "شاغر", "Occupied", "Vacant"]) {
        expect(html).not.toContain(label);
      }
    },
  );
});
