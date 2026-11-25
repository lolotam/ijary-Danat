import type { UnitStatus } from "@/integrations/supabase/database.types";
import { UNIT_FLOOR_TYPE_BINDING } from "@/lib/unitFloorTypeBinding";
import { v } from "./boldMarkers";
import type { ContractBuilderValues, ContractLocale, ContractPlot } from "./schema";

/** الحقول التي يحتاجها منتقي الوحدات من صف `units`. */
export type SelectableUnitRow = {
  id: string;
  code: string;
  name: string | null;
  name_en: string | null;
  paci_no: string | null;
  floor: string | null;
  type: string | null;
  property_id: string;
  status: UnitStatus | null;
};

/**
 * يحدد وحدات السطح، وهي خارج عقد الاستثمار التجاري كلياً.
 *
 * Production marks every roof both ways (`floor = 'roof'` and the bound unit
 * type). Both columns are free text since migrations 101/103, so either marker
 * alone is enough to exclude a row. The type marker is
 * `UNIT_FLOOR_TYPE_BINDING.roof`, so the catalogue spelling lives in one place.
 */
export function isRoofUnit(row: Pick<SelectableUnitRow, "floor" | "type">): boolean {
  return (
    row.floor?.trim().toLowerCase() === "roof" || row.type?.trim() === UNIT_FLOOR_TYPE_BINDING.roof
  );
}

/**
 * يعيد الوحدات القابلة للاختيار في العقد: كل الوحدات ما عدا السطح.
 */
export function selectableUnits<Row extends Pick<SelectableUnitRow, "floor" | "type">>(
  rows: readonly Row[],
): Row[] {
  return rows.filter((row) => !isRoofUnit(row));
}

/** يعرض رقم الوحدة المطبوع: اسمها إن وُجد، وإلا رمزها. */
export function unitDisplayNumber(row: Pick<SelectableUnitRow, "code" | "name">): string {
  return (row.name?.trim() || row.code).trim();
}

/**
 * يبني اسمي الوحدة العربي والإنجليزي لسطر العقد من صف الوحدة.
 *
 * Both are kept so switching the document language after selection prints
 * the right one; `units.name_en` differs from `name` on every production unit.
 */
export function unitLabels(
  row: Pick<SelectableUnitRow, "code" | "name" | "name_en">,
): Pick<ContractBuilderValues["units"][number], "unit_number" | "unit_number_en"> {
  return { unit_number: unitDisplayNumber(row), unit_number_en: row.name_en?.trim() ?? "" };
}

/** يختار اسم الوحدة بلغة الوثيقة، مع الرجوع إلى العربي حين يغيب الإنجليزي. */
function unitLabel(unit: ContractBuilderValues["units"][number], locale: ContractLocale): string {
  return (locale === "en" ? unit.unit_number_en.trim() : "") || unit.unit_number;
}

const PACI_LABEL: Record<ContractLocale, string> = { ar: "الرقم الآلي", en: "PACI No." };
const AND: Record<ContractLocale, string> = { ar: " و ", en: " and " };
const IN_PLOT: Record<ContractLocale, string> = { ar: "في", en: "in" };
const PLOT_SEPARATOR: Record<ContractLocale, string> = { ar: "، و ", en: "; and " };

/**
 * يختار اسم القسيمة بلغة الوثيقة، مع الرجوع إلى الاسم العربي.
 */
function plotName(plot: ContractPlot | undefined, locale: ContractLocale): string {
  if (!plot) return "";
  return (locale === "en" ? plot.name_en.trim() : "") || plot.name_ar.trim();
}

/**
 * يحدد هل تتوزع وحدات العقد على أكثر من قسيمة.
 *
 * One rule for both the grouped unit list and the plural clause wording, so
 * the list can never name several plots inside a sentence that says "the
 * said plot".
 */
export function spansSeveralPlots(values: Pick<ContractBuilderValues, "units">): boolean {
  return new Set(values.units.map((unit) => unit.property_id)).size > 1;
}

/**
 * يبني قائمة الوحدات المطبوعة: رقم كل وحدة ورقمها الآلي، مجمّعة بحسب القسيمة.
 *
 * One plot keeps the scan's wording ("المحلات أرقام 3 و 4 في القسيمة المشار
 * إليها") — the plot is named by the surrounding clause. Only once units span
 * several plots does each group need its plot's name, or the reader cannot
 * tell which shop sits where. Plot order follows the operator's selection.
 * Only the unit label, the PACI number and the plot name are marked for bold;
 * captions, conjunctions and parentheses are fixed copy.
 */
export function formatUnitList(
  values: Pick<ContractBuilderValues, "plots" | "units">,
  locale: ContractLocale,
): string {
  const describe = (unit: ContractBuilderValues["units"][number]) => {
    const paci = unit.paci_no.trim();
    const label = unitLabel(unit, locale);
    return paci ? `${v(label)} (${PACI_LABEL[locale]} ${v(paci)})` : v(label);
  };
  if (!spansSeveralPlots(values)) return values.units.map(describe).join(AND[locale]);
  const groupIds = [...new Set(values.units.map((unit) => unit.property_id))];
  const order = new Map(values.plots.map((plot, index) => [plot.id, index]));
  groupIds.sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity));
  return groupIds
    .map((id) => {
      const units = values.units.filter((unit) => unit.property_id === id);
      const name = plotName(
        values.plots.find((plot) => plot.id === id),
        locale,
      );
      const list = units.map(describe).join(AND[locale]);
      return name ? `${list} ${IN_PLOT[locale]} ${v(name)}` : list;
    })
    .join(PLOT_SEPARATOR[locale]);
}

/**
 * يضيف قسيمة إلى الاختيار أو يزيلها، وتسقط مع إزالتها وحداتها المختارة.
 *
 * Dropping the units with their plot is what keeps `refineUnitsBelongToPlots`
 * from ever firing in the UI: the operator cannot leave behind a shop from a
 * plot no longer on the contract.
 */
export function togglePlot(
  values: Pick<ContractBuilderValues, "plots" | "units">,
  plot: ContractPlot,
  checked: boolean,
): Pick<ContractBuilderValues, "plots" | "units"> {
  if (checked) {
    if (values.plots.some((existing) => existing.id === plot.id)) return values;
    return { plots: [...values.plots, plot], units: values.units };
  }
  return {
    plots: values.plots.filter((existing) => existing.id !== plot.id),
    units: values.units.filter((unit) => unit.property_id !== plot.id),
  };
}

/**
 * يضيف وحدة إلى سطور العقد أو يزيلها، مع رقمها الآلي من قاعدة البيانات مبدئياً.
 *
 * Returns the lines unchanged when adding would pass the six-line limit; the
 * picker disables further boxes at the limit, this is the backstop.
 */
export function toggleUnit(
  units: ContractBuilderValues["units"],
  row: SelectableUnitRow,
  checked: boolean,
  limit: number,
): ContractBuilderValues["units"] {
  if (!checked) return units.filter((unit) => unit.unit_id !== row.id);
  if (units.some((unit) => unit.unit_id === row.id) || units.length >= limit) return units;
  return [
    ...units,
    {
      unit_id: row.id,
      property_id: row.property_id,
      ...unitLabels(row),
      paci_no: row.paci_no?.trim() ?? "",
    },
  ];
}
