/**
 * Settings → Lists codes whose `value` is still constrained by a Postgres ENUM
 * column. A catalogue value outside the enum would be rejected by the database
 * on save, so the item editor must only accept these members.
 *
 * MUST stay in step with the enums in db/migrations (04_phase2 for most of
 * these; later migrations that alter enum members). Lists absent from this map
 * are free-text (unit_types / property_types after migration 103, plus
 * commercial_activities, unit_floors, gmail_categories, tenant_categories per
 * product decision).
 */
export const ENUM_BACKED_OPTION_LISTS: Readonly<Record<string, readonly string[]>> = {
  unit_statuses: ["available", "reserved", "occupied", "vacant", "under_maintenance", "archived"],
  contract_types: ["investment", "lease"],
  contract_states: ["draft", "active", "frozen", "suspended", "expired", "renewed", "terminated"],
  payment_methods: [
    "payment_link",
    "bank_transfer",
    "cheque",
    "cash",
    "knet",
    "applepay",
    "googlepay",
    "card",
    "audit_adjustment",
  ],
  tenant_lifecycles: ["active", "inactive", "contract_ended", "blocked"],
} as const;

export type OptionListValueValidation = { ok: true } | { ok: false; allowed: readonly string[] };

/**
 * Pure decision for Settings → Lists item value validation.
 * Free-text lists always accept; enum-backed lists accept only members.
 */
export function validateOptionListItemValue(
  listCode: string,
  value: string,
): OptionListValueValidation {
  const allowed = ENUM_BACKED_OPTION_LISTS[listCode];
  if (!allowed) return { ok: true };
  const trimmed = value.trim();
  if (allowed.includes(trimmed)) return { ok: true };
  return { ok: false, allowed };
}

export function isEnumBackedOptionList(listCode: string): boolean {
  return Object.prototype.hasOwnProperty.call(ENUM_BACKED_OPTION_LISTS, listCode);
}

export function enumMembersForList(listCode: string): readonly string[] | null {
  return ENUM_BACKED_OPTION_LISTS[listCode] ?? null;
}
