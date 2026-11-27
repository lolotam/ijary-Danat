import type { SupabaseClient } from "@supabase/supabase-js";

import { LIMIT_I18N_KEYS, limitErrorCode, type LimitErrorCode } from "@/company/limits";
import type { Database, Json } from "@/integrations/supabase/database.types";
import { validateResolvedLocation } from "@/lib/bulkImportRelations";
import type { ImportEntity, ImportValidationError } from "@/lib/bulkImportSchemas";
import type { ImportBatchRow } from "@/fns/importBatches.server";

/** صف من الملف رفضه حد من حدود الشركة. */
export interface RefusedImportRow {
  code: string | null;
  /** رقم الصف في الملف: السطر 1 هو صف العناوين. */
  row: number;
}

/** رفض دفعة الاستيراد بسبب حد من حدود الشركة. */
export interface BulkImportLimitRefusal {
  code: LimitErrorCode;
  /** مفتاح ترجمة رسالة الحد، كما في `src/company/limits.ts`. */
  i18nKey: `limits.${LimitErrorCode}`;
  refusedRows: number;
  rows: RefusedImportRow[];
  /** عدد الوحدات التي يضيفها الملف، إن كان الحد هو حد الوحدات. */
  unitsAdded: number | null;
  /** عدد الوحدات التي ما زالت تستوعبها الشركة، إن كان الحد هو حد الوحدات. */
  unitsAvailable: number | null;
}

/** نتيجة تنفيذ دفعة استيراد في العامل الخلفي. */
export interface BulkImportRunOutcome {
  inserted: number;
  errors: ImportValidationError[];
  limit: BulkImportLimitRefusal | null;
}

interface ImportReferences {
  buildingByCode: Map<string, { id: string; property_id: string }>;
  categoryByCode: Map<string, { id: string }>;
  companyId: string;
  propertyByCode: Map<string, { id: string }>;
  tenantByCode: Map<string, { id: string }>;
  unitByCode: Map<string, { building_id: string | null; id: string; property_id: string }>;
}

/** صف بعد حل مراجعه، ومعه رقمه في الملف وكوده. */
type ResolvedImportRow = {
  code: string | null;
  /** الصف بعد حذف أكواد العلاقات وإضافة المعرّفات. */
  row: Record<string, unknown>;
  /** رقم الصف في الملف كما أرسله العميل. */
  rowNumber: number;
};

/** كيانات تحمل ملفات التصدير فيها رمزاً مكرراً عبر الصفوف، فيجب طيّها قبل الإدراج. */
export const ENTITIES_DEDUPED_BY_CODE: ReadonlyArray<ImportEntity> = ["tenants", "contracts"];

/** كيانات تحتاج إلى ربط أكوادها بمعرّفات الجداول المرجعية داخل الشركة. */
const ENTITIES_NEEDING_REFERENCES: ReadonlyArray<ImportEntity> = [
  "properties",
  "buildings",
  "units",
  "maintenance",
  "contracts",
];

/** يفهرس السجلات حسب حقل الرمز `code` للبحث السريع. */
function indexByCode<T extends { code: string }>(records: T[]): Map<string, T> {
  return new Map(records.map((record) => [record.code, record]));
}

/** يبني كائن خطأ تحقق لصف معيّن في الملف. */
function importError(row: number, fields: string[], message: string): ImportValidationError {
  return { row, fields, message };
}

/** يستخرج رمزاً نصياً غير فارغ أو يُعيد `null`. */
function optionalCode(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** رقم الصف في الملف كما أرسله العميل، أو ترقيماً افتراضياً إن غاب. */
function rowNumberAt(rowNumbers: number[] | undefined, index: number): number {
  return rowNumbers?.[index] ?? index + 2;
}

/** يجمع الصف بعد حله مع رقمه في الملف وكوده. */
function toResolvedRow(row: Record<string, unknown>, rowNumber: number): ResolvedImportRow {
  return { code: optionalCode(row.code), row, rowNumber };
}

/**
 * يزيل تكرار الصفوف التي تحمل الرمز نفسه قبل الاستيراد الجماعي.
 *
 * Both reworked exports now repeat a code down the rows — tenants.csv emits one
 * row per contract and contracts.csv one row per unit — because that is what
 * makes a multi-contract or multi-unit record readable. `bulk_import_phase6`
 * inserts without an `on conflict` clause against a unique `code`
 * (`db/migrations/113_electricity_and_bulk_import.sql`), so re-importing either
 * file unchanged aborts the whole batch with 23505. First occurrence wins, which
 * reproduces exactly what the old single-row exports round-tripped: the tenant's
 * primary contract, and the contract's primary unit.
 *
 * Rows with a blank (or missing/whitespace-only) code are NOT collapsed: the SQL
 * does `coalesce(nullif(row_data.code,''), public.next_*_code())`, so a blank
 * code means "generate a new record" and collapsing them would silently drop
 * people and contracts.
 */
export function dedupeRowsByCode<T extends Record<string, unknown>>(rows: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const row of rows) {
    const code = optionalCode(row.code);
    if (!code) {
      result.push(row);
      continue;
    }
    if (seen.has(code)) continue;
    seen.add(code);
    result.push(row);
  }
  return result;
}

/** يحمّل مراجع الأكواد المعرّفة داخل الشركة الحالية لحل علاقات الاستيراد الجماعي. */
async function loadImportReferences(
  db: SupabaseClient<Database>,
  companyId: string,
): Promise<ImportReferences> {
  const [propertyResult, buildingResult, unitResult, categoryResult, tenantResult] =
    await Promise.all([
      db.from("properties").select("id, code"),
      db.from("buildings").select("id, code, property_id"),
      db.from("units").select("id, code, property_id, building_id"),
      db.from("building_categories").select("id, code"),
      db.from("tenants").select("id, code"),
    ]);
  if (propertyResult.error) throw new Error(propertyResult.error.message);
  if (buildingResult.error) throw new Error(buildingResult.error.message);
  if (unitResult.error) throw new Error(unitResult.error.message);
  if (categoryResult.error) throw new Error(categoryResult.error.message);
  if (tenantResult.error) throw new Error(tenantResult.error.message);

  return {
    companyId,
    propertyByCode: indexByCode(propertyResult.data),
    buildingByCode: indexByCode(buildingResult.data),
    unitByCode: indexByCode(unitResult.data),
    categoryByCode: indexByCode(categoryResult.data),
    tenantByCode: indexByCode(tenantResult.data),
  };
}

/** يحل معرّف العقار انطلاقاً من `property_code`. */
function resolvePropertyId(
  row: Record<string, unknown>,
  rowNumber: number,
  references: ImportReferences,
): { error: ImportValidationError | null; propertyId: string | null } {
  const propertyCode = optionalCode(row.property_code);
  const property = propertyCode ? references.propertyByCode.get(propertyCode) : null;
  if (!property) {
    return {
      propertyId: null,
      error: importError(rowNumber, ["property_code"], "Unknown property_code."),
    };
  }
  return { propertyId: property.id, error: null };
}

/** يحل موقع العقار والمبنى والوحدة ويتحقق من تناسقها. */
function resolveLocation(
  row: Record<string, unknown>,
  rowNumber: number,
  references: ImportReferences,
): { error: ImportValidationError | null; location: Record<string, string | null> | null } {
  const property = resolvePropertyId(row, rowNumber, references);
  if (property.error || !property.propertyId) return { error: property.error, location: null };

  const buildingCode = optionalCode(row.building_code);
  const unitCode = optionalCode(row.unit_code);
  const building = buildingCode ? (references.buildingByCode.get(buildingCode) ?? null) : null;
  const unit = unitCode ? (references.unitByCode.get(unitCode) ?? null) : null;
  if (buildingCode && !building) {
    return {
      error: importError(rowNumber, ["building_code"], "Unknown building_code."),
      location: null,
    };
  }
  if (unitCode && !unit) {
    return { error: importError(rowNumber, ["unit_code"], "Unknown unit_code."), location: null };
  }

  const locationError = validateResolvedLocation({
    propertyId: property.propertyId,
    building,
    unit,
  });
  if (locationError) {
    const field = locationError.startsWith("building") ? "building_code" : "unit_code";
    return { error: importError(rowNumber, [field], locationError), location: null };
  }

  return {
    error: null,
    location: {
      property_id: property.propertyId,
      building_id: building?.id ?? null,
      unit_id: unit?.id ?? null,
    },
  };
}

/** يحل علاقات صف استيراد واحد وفق نوع الكيان. */
function resolveImportRow(
  entity: ImportEntity,
  row: Record<string, unknown>,
  rowNumber: number,
  references: ImportReferences,
): { error: ImportValidationError | null; row: Record<string, unknown> | null } {
  if (entity === "properties") {
    return { error: null, row: { ...row, company_id: references.companyId } };
  }
  if (entity === "buildings") {
    const property = resolvePropertyId(row, rowNumber, references);
    if (property.error || !property.propertyId) return { error: property.error, row: null };
    const categoryCode = optionalCode(row.category_code);
    const category = categoryCode ? references.categoryByCode.get(categoryCode) : null;
    if (categoryCode && !category) {
      return {
        error: importError(rowNumber, ["category_code"], "Unknown category_code."),
        row: null,
      };
    }
    const { category_code: _categoryCode, property_code: _propertyCode, ...buildingRow } = row;
    return {
      error: null,
      row: { ...buildingRow, property_id: property.propertyId, category_id: category?.id ?? null },
    };
  }
  if (entity === "contracts") {
    // Resolved from codes rather than accepting ids: a contract's tenant and
    // unit are the two things an operator can actually read off a spreadsheet,
    // and both are what the contracts export writes.
    const tenantCode = optionalCode(row.tenant_code);
    const tenant = tenantCode ? references.tenantByCode.get(tenantCode) : null;
    if (!tenant) {
      return { error: importError(rowNumber, ["tenant_code"], "Unknown tenant_code."), row: null };
    }
    const unitCode = optionalCode(row.unit_code);
    const unit = unitCode ? references.unitByCode.get(unitCode) : null;
    if (!unit) {
      return { error: importError(rowNumber, ["unit_code"], "Unknown unit_code."), row: null };
    }
    const { tenant_code: _tenantCode, unit_code: _unitCode, ...contractRow } = row;
    return { error: null, row: { ...contractRow, tenant_id: tenant.id, unit_id: unit.id } };
  }
  if (entity === "units" || entity === "maintenance") {
    const location = resolveLocation(row, rowNumber, references);
    if (location.error || !location.location) return { error: location.error, row: null };
    const {
      building_code: _buildingCode,
      property_code: _propertyCode,
      unit_code: _unitCode,
      ...importRow
    } = row;
    return {
      error: null,
      row:
        entity === "maintenance"
          ? { ...importRow, ...location.location, company_id: references.companyId }
          : {
              ...importRow,
              property_id: location.location.property_id,
              building_id: location.location.building_id,
            },
    };
  }
  return { error: null, row };
}

/** يربط صفوف الاستيراد بسجلات الشركة الحالية عبر المراجع المحمّلة. */
async function resolveImportRows(
  db: SupabaseClient<Database>,
  companyId: string,
  entity: ImportEntity,
  rows: Array<Record<string, unknown>>,
  rowNumbers: number[] | undefined,
): Promise<{ errors: ImportValidationError[]; rows: ResolvedImportRow[] }> {
  if (!ENTITIES_NEEDING_REFERENCES.includes(entity)) {
    return {
      errors: [],
      rows: rows.map((row, index) => toResolvedRow(row, rowNumberAt(rowNumbers, index))),
    };
  }
  const references = await loadImportReferences(db, companyId);
  const errors: ImportValidationError[] = [];
  const resolvedRows: ResolvedImportRow[] = [];
  rows.forEach((row, index) => {
    const rowNumber = rowNumberAt(rowNumbers, index);
    const resolved = resolveImportRow(entity, row, rowNumber, references);
    if (resolved.error) errors.push(resolved.error);
    if (resolved.row) resolvedRows.push(toResolvedRow(resolved.row, rowNumber));
  });
  return { errors, rows: resolvedRows };
}

/**
 * يقرأ كم وحدة تستطيع الشركة استيعابها الآن.
 *
 * The same two sources the `LIMIT_UNITS` trigger reads: the ceiling in
 * `company_limits` and the company's unit count, both through the company
 * client so RLS keeps them inside the company of the request.
 */
async function readUnitsHeadroom(
  db: SupabaseClient<Database>,
  companyId: string,
): Promise<number | null> {
  const [limits, units] = await Promise.all([
    db.from("company_limits").select("max_units").eq("company_id", companyId).maybeSingle(),
    db.from("units").select("id", { count: "exact", head: true }).eq("company_id", companyId),
  ]);
  if (limits.error) throw new Error(`company_limits lookup failed: ${limits.error.message}`);
  if (units.error) throw new Error(`units count failed: ${units.error.message}`);
  const maxUnits = limits.data?.max_units ?? null;
  if (maxUnits === null) return null;
  return Math.max(0, maxUnits - (units.count ?? 0));
}

/** ما يحتاجه وصف رفض دفعة بسبب حد من حدود الشركة. */
interface LimitRefusalInput {
  code: LimitErrorCode;
  companyId: string;
  db: SupabaseClient<Database>;
  rows: ResolvedImportRow[];
}

/**
 * يصف رفض دفعة الاستيراد بسبب حد من حدود الشركة.
 *
 * `bulk_import_phase6` يستورد الكيان الواحد بجملة واحدة — `insert ... select`
 * واحدة هي الدفعة كلها — فإذا رفع مُشغّل الحد (`LIMIT_UNITS`) السطرَ الأول
 * استُرجعت العبارة وتراجعت المعاملة، ولم يُستورد شيء.
 */
async function describeLimitRefusal(input: LimitRefusalInput): Promise<BulkImportLimitRefusal> {
  const unitsLimit = input.code === "LIMIT_UNITS";
  const unitsAvailable = unitsLimit ? await readUnitsHeadroom(input.db, input.companyId) : null;
  return {
    code: input.code,
    i18nKey: LIMIT_I18N_KEYS[input.code],
    refusedRows: input.rows.length,
    rows: input.rows.map((row) => ({ code: row.code, row: row.rowNumber })),
    unitsAdded: unitsLimit ? input.rows.length : null,
    unitsAvailable,
  };
}

/**
 * يعيد حقلَي ربط صف التدقيق بطلب الاستيراد: معرّف الدفعة ومَن طلبها.
 *
 * The worker's audit rows have no actor (`company_service`), so these fields
 * tie them to the `bulk_import_requested` row the requester's client wrote.
 */
function batchLink(batch: ImportBatchRow): { upload_id: string; requested_by: string } {
  return { upload_id: batch.id, requested_by: batch.requested_by };
}

/**
 * يسجّل رفض الاستيراد بسبب حد في سجل التدقيق.
 *
 * The refusal already happened and nothing was imported, so a failed audit write
 * must not replace the limit message the operator needs with an audit outage —
 * the write is best-effort and its failure is logged, like `permissionAudit.ts`.
 */
async function recordLimitRefusal(
  db: SupabaseClient<Database>,
  batch: ImportBatchRow,
  refusal: BulkImportLimitRefusal,
): Promise<void> {
  const entity = batch.entity;
  try {
    const { error } = await db.rpc("write_audit", {
      p_action: `${entity}.bulk_import`,
      p_after: {
        inserted: 0,
        limit: refusal.code,
        refused_rows: refusal.refusedRows,
        units_added: refusal.unitsAdded,
        units_available: refusal.unitsAvailable,
        ...batchLink(batch),
      },
      p_before: null,
      p_entity_id: null,
      p_entity_type: entity,
      p_error_code: refusal.code,
      p_result: "failure",
    });
    if (error) console.error(`Audit write failed for ${entity}.bulk_import`, error.message);
  } catch (error) {
    console.error(`Audit write failed for ${entity}.bulk_import`, error);
  }
}

/** ينفّذ حلّ المراجع وإزالة التكرار والإدراج والتدقيق لدفعة استيراد مرحَّلة. */
export async function runImportBatch(
  db: SupabaseClient<Database>,
  batch: ImportBatchRow,
): Promise<BulkImportRunOutcome> {
  const resolved = await resolveImportRows(
    db,
    batch.company_id,
    batch.entity,
    batch.rows,
    batch.row_numbers ?? undefined,
  );
  if (!resolved.rows.length) {
    return { inserted: 0, errors: resolved.errors, limit: null };
  }

  // Tenants and contracts only: their exports now repeat a code down the rows,
  // and bulk_import_phase6 inserts with no `on conflict` against a unique code.
  const rowsForInsert = ENTITIES_DEDUPED_BY_CODE.includes(batch.entity)
    ? dedupeRowsByCode(resolved.rows)
    : resolved.rows;

  const imported = await db.rpc("bulk_import_phase6", {
    p_created_by: batch.requested_by,
    p_entity: batch.entity,
    p_rows: rowsForInsert.map((row) => row.row) as Json,
  });
  if (imported.error) {
    const code = limitErrorCode(imported.error);
    if (!code) throw new Error(imported.error.message);
    const refusal = await describeLimitRefusal({
      code,
      companyId: batch.company_id,
      db,
      rows: rowsForInsert,
    });
    await recordLimitRefusal(db, batch, refusal);
    return { inserted: 0, errors: resolved.errors, limit: refusal };
  }

  // The rows are committed: an audit failure is logged, never thrown, so the
  // job does not fail after a successful import and invite a second attempt.
  const audit = await db.rpc("write_audit", {
    p_action: `${batch.entity}.bulk_import`,
    p_after: {
      error_count: resolved.errors.length,
      inserted: imported.data,
      ...batchLink(batch),
    },
    p_before: null,
    p_entity_id: null,
    p_entity_type: batch.entity,
    p_error_code: null,
    p_result: "success",
  });
  if (audit.error)
    console.error(`Audit write failed for ${batch.entity}.bulk_import`, audit.error.message);

  return { inserted: imported.data, errors: resolved.errors, limit: null };
}
