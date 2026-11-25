import { z } from "zod";

import type { UnitRow, UnitStatus } from "@/integrations/supabase/database.types";

/**
 * Sentinel for the optional Floor select. Radix Select cannot use an empty
 * string as a real option value; on submit this becomes `null`, not `""`.
 * Same shape as commercial activity's `__none__` on contracts.
 */
export const NO_UNIT_FLOOR = "__none__";

const optionalNumber = z.preprocess(
  (value) => (value === "" || value == null ? undefined : Number(value)),
  z.number().nonnegative().optional(),
);

/**
 * Shared unit create/edit schema for both the Units section and the property
 * detail page. Type and floor are free text (migrations 103 / 101) — required
 * non-empty type; optional floor so existing units without a floor remain
 * editable.
 */
export const unitFormSchema = z.object({
  property_id: z.string().min(1),
  paci_no: z.string(),
  name: z.string().trim().min(1),
  name_en: z.string(),
  // Free-text after migration 103; must be non-empty (empty selection fails).
  type: z.string().trim().min(1),
  // Optional free-text floor label; empty / sentinel → null on submit.
  floor: z.string().optional().nullable(),
  area: optionalNumber,
  // `occupied` stays in the schema even though nobody may select it: the locked
  // control has to be able to display it. See unit status field options.
  status: z.enum(["occupied", "vacant", "under_maintenance", "archived"]),
  electricity_meter_ownership: z.enum(["company_owned", "tenant_owned"]),
  default_rent: optionalNumber,
  description_ar: z.string(),
  description_en: z.string(),
});

export type UnitFormValues = z.infer<typeof unitFormSchema>;

export const unitFormDefaults: UnitFormValues = {
  property_id: "",
  paci_no: "",
  name: "",
  name_en: "",
  type: "",
  floor: NO_UNIT_FLOOR,
  area: undefined,
  status: "vacant",
  electricity_meter_ownership: "company_owned",
  default_rent: undefined,
  description_ar: "",
  description_en: "",
};

/** Historical seed values — filter fallback labels only; not an allow-list. */
export const unitTypeValues = [
  "apartment",
  "shop",
  "office",
  "commercial",
  "warehouse",
  "villa",
  "other",
] as const;

/**
 * `occupied` is filterable but not settable: migration 76 derives it from the
 * unit's active contract. Editable list is vacant / under_maintenance / archived.
 */
export const unitStatusFilterValues: UnitStatus[] = [
  "occupied",
  "vacant",
  "under_maintenance",
  "archived",
];
export const unitStatusEditableValues: UnitStatus[] = ["vacant", "under_maintenance", "archived"];

/**
 * Pure decision for the Property control when the form opens inside a property
 * page vs the Units section.
 *
 * - locked: field is disabled AND the default value must equal that id (so RHF
 *   form state carries `property_id` even though a disabled native select would
 *   not submit).
 * - unlocked: field is enabled; no forced property.
 */
export function resolvePropertyFieldState(lockedPropertyId?: string | null): {
  disabled: boolean;
  defaultPropertyId: string | undefined;
} {
  if (lockedPropertyId) {
    return { disabled: true, defaultPropertyId: lockedPropertyId };
  }
  return { disabled: false, defaultPropertyId: undefined };
}

/** Defaults / reset values for create or edit, honouring a locked property. */
export function resolveUnitFormValues(
  editing: UnitRow | null,
  lockedPropertyId?: string | null,
): UnitFormValues {
  const { defaultPropertyId } = resolvePropertyFieldState(lockedPropertyId);
  if (editing) {
    return {
      property_id: editing.property_id,
      paci_no: editing.paci_no ?? "",
      name: editing.name,
      name_en: editing.name_en ?? "",
      type: editing.type,
      floor: editing.floor ?? NO_UNIT_FLOOR,
      area: editing.area ?? undefined,
      // Retired enum values should not survive migration 76's backfill, but a
      // stale client or an old import could still carry one.
      status:
        editing.status === "available" || editing.status === "reserved" ? "vacant" : editing.status,
      electricity_meter_ownership: editing.electricity_meter_ownership,
      default_rent: editing.default_rent ?? undefined,
      description_ar: editing.description_ar ?? "",
      description_en: editing.description_en ?? "",
    };
  }
  return {
    ...unitFormDefaults,
    // Locked create: form state holds the property id before the user touches
    // anything. Unlocked create: empty string until they pick one.
    property_id: defaultPropertyId ?? "",
  };
}

/**
 * Build the insert/update payload from form values.
 *
 * `property_id` always comes from form state (or the lock override), never from
 * the DOM. A disabled select does not submit; RHF does. Passing
 * `lockedPropertyId` forces the id so a silently-null create cannot happen if
 * the reset path were ever skipped.
 *
 * Empty floor selection becomes `null`, not `""`.
 */
export function buildUnitSubmitPayload(
  values: UnitFormValues,
  lockedPropertyId?: string | null,
): {
  property_id: string;
  paci_no: string | null;
  name: string;
  name_en: string | null;
  type: string;
  floor: string | null;
  area: number | undefined;
  status: UnitStatus;
  electricity_meter_ownership: "company_owned" | "tenant_owned";
  description_ar: string | null;
  description_en: string | null;
} {
  const property_id = lockedPropertyId || values.property_id;
  const floorRaw = values.floor;
  const floor = !floorRaw || floorRaw === NO_UNIT_FLOOR || floorRaw.trim() === "" ? null : floorRaw;

  return {
    property_id,
    // Nullable free-text identifier: empty box stores null, not "".
    paci_no: values.paci_no.trim() || null,
    name: values.name,
    // Nullable, mirroring properties.name_en: an empty box means "no English
    // name", which the CSV and the UI fall back from, not an empty string.
    name_en: values.name_en.trim() || null,
    type: values.type,
    floor,
    area: values.area,
    status: values.status,
    electricity_meter_ownership: values.electricity_meter_ownership,
    description_ar: values.description_ar.trim() || null,
    description_en: values.description_en.trim() || null,
  };
}

/** Four starter values seeded by migration 101 — for regression tests only. */
export const SEEDED_UNIT_FLOORS = ["ground", "first", "basement", "roof"] as const;

/** Seven historical unit-type seeds — for free-text regression tests only. */
export const SEEDED_UNIT_TYPES = [
  "apartment",
  "shop",
  "office",
  "commercial",
  "warehouse",
  "villa",
  "other",
] as const;
