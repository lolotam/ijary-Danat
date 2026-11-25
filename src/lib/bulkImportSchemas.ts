import { z } from "zod";

export const importEntitySchema = z.enum([
  "expenses",
  "deposits",
  "tenants",
  "properties",
  "buildings",
  "units",
  "maintenance",
  "contracts",
]);
export type ImportEntity = z.infer<typeof importEntitySchema>;

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optionalText = z.preprocess(emptyToUndefined, z.string().trim().optional());
const optionalUuid = z.preprocess(emptyToUndefined, z.string().uuid().optional());
const optionalDate = z.preprocess(emptyToUndefined, z.string().date().optional());
const optionalNumber = z.preprocess((value) => {
  const normalized = emptyToUndefined(value);
  return typeof normalized === "string" ? Number(normalized.replace(/,/g, "")) : normalized;
}, z.number().finite().optional());
const normalizedNumber = (value: unknown) => {
  const normalized = emptyToUndefined(value);
  return typeof normalized === "string" ? Number(normalized.replace(/,/g, "")) : normalized;
};
const nonnegativeNumber = z.preprocess(normalizedNumber, z.number().finite().nonnegative());
const positiveNumber = z.preprocess(normalizedNumber, z.number().finite().positive());
const optionalBoolean = z.preprocess((value) => {
  const normalized = emptyToUndefined(value);
  if (typeof normalized !== "string") return normalized;
  if (["true", "1", "yes"].includes(normalized.toLowerCase())) return true;
  if (["false", "0", "no"].includes(normalized.toLowerCase())) return false;
  return normalized;
}, z.boolean().optional());

export const importSchemas = {
  expenses: z.object({
    code: optionalText,
    company_id: optionalUuid,
    // `contractual_monthly` is refused, not accepted (user decision M14,
    // 2026-09-23). It is in the database enum but the expense screen derives
    // `class` from recurrence and can never produce it, so an imported row
    // carrying it was silently reclassified the first time anyone saved it —
    // and budget reports group by `class`. Monthly contractual costs are
    // `regular_recurring`.
    class: z.preprocess(
      emptyToUndefined,
      z
        .enum(["contractual_monthly", "contractual_annual", "regular_recurring", "sudden_one_time"])
        .refine((value) => value !== "contractual_monthly", {
          message:
            "contractual_monthly is not an importable expense class; use regular_recurring for a monthly contractual expense.",
        })
        .default("regular_recurring"),
    ),
    category_id: optionalUuid,
    payee: optionalText,
    amount: nonnegativeNumber,
    currency: z.preprocess(emptyToUndefined, z.string().trim().min(1).default("KWD")),
    property_id: optionalUuid,
    building_id: optionalUuid,
    unit_id: optionalUuid,
    cost_center: optionalText,
    start_date: optionalDate,
    end_date: optionalDate,
    recurrence: z.preprocess(
      emptyToUndefined,
      z.enum(["monthly", "quarterly", "annual", "one_time"]).optional(),
    ),
    expense_date: z.string().date(),
    status: z.preprocess(
      emptyToUndefined,
      z.enum(["pending", "approved", "cancelled"]).default("approved"),
    ),
    note: optionalText,
  }),
  deposits: z.object({
    code: optionalText,
    company_id: optionalUuid,
    deposit_date: z.string().date(),
    bank_name: z.string().trim().min(1),
    amount: positiveNumber,
    // KWD only, matching `deposits_currency_kwd` (migration 152). Left as free
    // text, a USD row would pass validation and then abort the whole batch
    // insert inside `bulk_import_phase6` — one bad row taking down 200 good
    // ones, with no row number in the error. Rejected here it names the row.
    currency: z.preprocess(emptyToUndefined, z.literal("KWD").default("KWD")),
    deposit_type: z.preprocess(emptyToUndefined, z.enum(["cash", "cheque"]).default("cash")),
    note: optionalText,
    status: z.preprocess(
      emptyToUndefined,
      z.enum(["pending", "confirmed", "cancelled"]).default("confirmed"),
    ),
  }),
  tenants: z.object({
    code: optionalText,
    company_id: optionalUuid,
    name: z.string().trim().min(1),
    category: z.preprocess(
      emptyToUndefined,
      z
        .enum(["vip", "uncommitted", "chronically_distressed", "standard", "custom"])
        .default("standard"),
    ),
    // `lifecycle` is deliberately absent: migration 54 derives it from the
    // tenant's contracts, and a before-insert trigger overwrites whatever an
    // import supplies. Accepting the column would let an importer believe they
    // had set a value that the database silently discards.
    nationality: optionalText,
    preferred_language: z.preprocess(emptyToUndefined, z.enum(["ar", "en"]).default("ar")),
    mobile: optionalText,
    whatsapp: optionalText,
    email: z.preprocess(emptyToUndefined, z.string().email().optional()),
    commercial_name: optionalText,
    authorized_manager: optionalText,
    authorized_manager_civil_id: optionalText,
    owner_civil_id: optionalText,
    commercial_address: optionalText,
    notes: optionalText,
    tenant_portal_enabled: optionalBoolean,
    reminders_enabled: optionalBoolean,
    receipt_visible_to_tenant: optionalBoolean,
  }),
  properties: z.object({
    code: optionalText,
    name_ar: z.string().trim().min(1),
    name_en: optionalText,
    // Free-text after migration 103 — any catalogue value is valid.
    type: z.preprocess(emptyToUndefined, z.string().trim().min(1).default("compound")),
    address_ar: optionalText,
    address_en: optionalText,
    location_url: optionalText,
    area: optionalNumber,
    description_ar: optionalText,
    description_en: optionalText,
    image_url: optionalText,
    status: z.preprocess(
      emptyToUndefined,
      z.enum(["active", "inactive", "archived"]).default("active"),
    ),
  }),
  buildings: z.object({
    code: optionalText,
    property_code: z.string().trim().min(1),
    category_code: optionalText,
    name_ar: z.string().trim().min(1),
    name_en: optionalText,
    address_ar: optionalText,
    address_en: optionalText,
    area: optionalNumber,
    floors: optionalNumber,
    image_url: optionalText,
    description_ar: optionalText,
    description_en: optionalText,
    status: z.preprocess(
      emptyToUndefined,
      z.enum(["active", "inactive", "under_maintenance", "archived"]).default("active"),
    ),
  }),
  units: z.object({
    code: optionalText,
    property_code: z.string().trim().min(1),
    building_code: optionalText,
    name: z.string().trim().min(1),
    // Free-text after migration 103 — any catalogue value is valid.
    type: z.preprocess(emptyToUndefined, z.string().trim().min(1).default("apartment")),
    area: optionalNumber,
    status: z.preprocess(
      emptyToUndefined,
      z
        // All six stay accepted so older import files still validate; migration
        // 76's units trigger folds `available`/`reserved` into `vacant` on
        // insert, and — since a brand-new unit cannot yet have a contract —
        // silently folds an imported `occupied` into `vacant` as well.
        .enum(["available", "reserved", "occupied", "vacant", "under_maintenance", "archived"])
        .default("vacant"),
    ),
    electricity_meter_ownership: z.preprocess(
      emptyToUndefined,
      z.enum(["company_owned", "tenant_owned"]).default("company_owned"),
    ),
    default_rent: optionalNumber,
    description_ar: optionalText,
    description_en: optionalText,
  }),
  maintenance: z.object({
    code: optionalText,
    property_code: z.string().trim().min(1),
    building_code: optionalText,
    unit_code: optionalText,
    title: z.string().trim().min(1),
    description: optionalText,
    priority: z.preprocess(
      emptyToUndefined,
      z.enum(["low", "medium", "high", "urgent"]).default("medium"),
    ),
    status: z.preprocess(
      emptyToUndefined,
      z.enum(["open", "in_progress", "completed", "cancelled"]).default("open"),
    ),
  }),
  contracts: z
    .object({
      code: optionalText,
      tenant_code: z.string().trim().min(1),
      unit_code: z.string().trim().min(1),
      type: z.preprocess(emptyToUndefined, z.enum(["investment", "lease"]).default("investment")),
      // Defaults to `draft`, matching the column default, so an import that
      // omits the column cannot silently activate a lease — and with it, flip
      // the unit to occupied through migration 76's trigger.
      state: z.preprocess(
        emptyToUndefined,
        z
          .enum(["draft", "active", "frozen", "suspended", "expired", "renewed", "terminated"])
          .default("draft"),
      ),
      entry_date: optionalDate,
      start_date: z.string().date(),
      end_date: z.string().date(),
      duration_months: optionalNumber,
      monthly_amount: positiveNumber,
      // 1–28 and >= 0 mirror the column CHECK constraints (migration 04), so a
      // bad value is named on its row instead of aborting the whole batch.
      due_day: z.preprocess(normalizedNumber, z.number().int().min(1).max(28).default(1)),
      grace_days: z.preprocess(normalizedNumber, z.number().int().nonnegative().default(1)),
      deposit: z.preprocess(normalizedNumber, z.number().finite().nonnegative().default(0)),
      notes: optionalText,
    })
    .refine((value) => value.end_date >= value.start_date, { path: ["end_date"] }),
} satisfies Record<ImportEntity, z.ZodTypeAny>;

export interface ImportValidationError {
  fields: string[];
  message: string;
  row: number;
}

export interface ValidatedImportRows {
  errors: ImportValidationError[];
  validRows: Array<Record<string, unknown>>;
}

export function validateImportRows(
  entity: ImportEntity,
  rows: Array<Record<string, unknown>>,
): ValidatedImportRows {
  const errors: ImportValidationError[] = [];
  const validRows: Array<Record<string, unknown>> = [];
  rows.forEach((row, index) => {
    const result = importSchemas[entity].safeParse(row);
    if (result.success) {
      validRows.push(result.data);
    } else {
      errors.push({
        fields: [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "row"))],
        row: index + 2,
        message: result.error.issues
          .map((issue) => `${issue.path.join(".") || "row"}: ${issue.message}`)
          .join("; "),
      });
    }
  });
  return { errors, validRows };
}
