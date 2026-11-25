import { UNIT_FLOOR_TYPE_BINDING } from "@/lib/unitFloorTypeBinding";

/**
 * قيمة الطابق ونوع الوحدة اللتان تدلّان على شقة سطح.
 *
 * Both are read from `UNIT_FLOOR_TYPE_BINDING` rather than retyped, so the
 * roof unit type is whatever `UNIT_FLOOR_TYPE_BINDING.roof` holds (currently
 * `managemental-services`, set by migration 239) — one home, no stale literal.
 */
const ROOF_FLOOR = "roof";
const ROOF_UNIT_TYPE = UNIT_FLOOR_TYPE_BINDING[ROOF_FLOOR];

/** ما تحتاجه دالة الكشف من الوحدة — الطابق والنوع فقط. */
export interface RoofDetectableUnit {
  unit: { floor?: string | null; type?: string | null } | null;
}

/**
 * يخمّن ما إذا كان العقد عقد سطح، لعرض شارة أو تلميح فقط.
 *
 * **A hint, never a rule.** `units.floor` and `units.type` are operator-editable
 * free text whose vocabulary lives in Settings → Lists — one seeded value even
 * carries a typo the owner owns (see `unitFloorTypeBinding.ts`). Migration 173
 * refused to hang billing behaviour off them for exactly that reason, and
 * migration 210 kept the refusal: what a tenant may see is decided solely by
 * the stored `contracts.hide_from_portal` flag.
 *
 * So this exists to tell an admin "this looks like a roof contract, you
 * probably want the switch below", and to nothing else. Renaming a list value
 * can then cost a badge — never a contract silently reappearing in a tenant's
 * portal, and never a hidden contract stranded with no way to unhide it.
 */
export function isRoofContract(units: readonly RoofDetectableUnit[]): boolean {
  return units.some(
    (entry) => entry.unit?.floor === ROOF_FLOOR || entry.unit?.type === ROOF_UNIT_TYPE,
  );
}
