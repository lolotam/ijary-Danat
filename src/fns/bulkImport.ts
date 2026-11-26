import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/database.types";
import {
  importEntitySchema,
  validateImportRows,
  type ImportEntity,
  type ImportValidationError,
} from "@/lib/bulkImportSchemas";
import { validateResolvedLocation } from "@/lib/bulkImportRelations";
import { requirePermission } from "@/fns/requirePermission";

const schema = z.object({
  entity: importEntitySchema,
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
});

export type BulkImportInput = z.infer<typeof schema>;
export interface BulkImportResult {
  errors: ImportValidationError[];
  inserted: number;
}

interface ImportReferences {
  buildingByCode: Map<string, { id: string; property_id: string }>;
  categoryByCode: Map<string, { id: string }>;
  companyId: string;
  propertyByCode: Map<string, { id: string }>;
  tenantByCode: Map<string, { id: string }>;
  unitByCode: Map<string, { building_id: string | null; id: string; property_id: string }>;
}

const permissionByEntity = {
  expenses: "expenses.create",
  deposits: "deposits.create",
  tenants: "tenants.create",
  properties: "properties.create",
  buildings: "buildings.create",
  units: "units.create",
  maintenance: "maintenance.create",
  contracts: "contracts.create",
} as const;

/** Entities whose CSV carries codes that must be resolved to foreign keys. */
const ENTITIES_NEEDING_REFERENCES = [
  "properties",
  "buildings",
  "units",
  "maintenance",
  "contracts",
];

function indexByCode<T extends { code: string }>(records: T[]): Map<string, T> {
  return new Map(records.map((record) => [record.code, record]));
}

function importError(row: number, fields: string[], message: string): ImportValidationError {
  return { row, fields, message };
}

function optionalCode(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

function resolveImportRow(
  entity: ImportEntity,
  row: Record<string, unknown>,
  rowNumber: number,
  references: ImportReferences,
): { error: ImportValidationError | null; row: Record<string, unknown> | null } {
  if (entity === "properties")
    return { error: null, row: { ...row, company_id: references.companyId } };
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
): Promise<{ errors: ImportValidationError[]; rows: Array<Record<string, unknown>> }> {
  if (!ENTITIES_NEEDING_REFERENCES.includes(entity)) {
    return { errors: [], rows };
  }
  const references = await loadImportReferences(db, companyId);
  const errors: ImportValidationError[] = [];
  const resolvedRows: Array<Record<string, unknown>> = [];
  rows.forEach((row, index) => {
    const resolved = resolveImportRow(entity, row, index + 2, references);
    if (resolved.error) errors.push(resolved.error);
    if (resolved.row) resolvedRows.push(resolved.row);
  });
  return { errors, rows: resolvedRows };
}

/** Entities whose export now repeats a code across rows, so the import must collapse them. */
export const ENTITIES_DEDUPED_BY_CODE: ReadonlyArray<ImportEntity> = ["tenants", "contracts"];

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
export function dedupeRowsByCode(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const result: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const raw = row.code;
    const code = typeof raw === "string" ? raw.trim() : "";
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

export const bulkImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }): Promise<BulkImportResult> => {
    await requirePermission(context, {
      code: permissionByEntity[data.entity],
      attempted: `import.${data.entity}`,
      refusal: `You do not have permission to import ${data.entity}.`,
    });

    const company = requireRequestCompany();
    const db = companyClient(company.id);

    const validated = validateImportRows(data.entity, data.rows);
    if (!validated.validRows.length) return { inserted: 0, errors: validated.errors };

    const resolved = await resolveImportRows(db, company.id, data.entity, validated.validRows);
    if (!resolved.rows.length)
      return { inserted: 0, errors: [...validated.errors, ...resolved.errors] };

    // Tenants and contracts only: their exports now repeat a code down the rows,
    // and bulk_import_phase6 inserts with no `on conflict` against a unique code.
    // Every other entity keeps every row.
    const rowsForInsert = ENTITIES_DEDUPED_BY_CODE.includes(data.entity)
      ? dedupeRowsByCode(resolved.rows)
      : resolved.rows;

    const imported = await db.rpc("bulk_import_phase6", {
      p_created_by: context.userId,
      p_entity: data.entity,
      p_rows: rowsForInsert as Json,
    });
    if (imported.error) throw new Error(imported.error.message);

    const errors = [...validated.errors, ...resolved.errors];
    const audit = await context.supabase.rpc("write_audit", {
      p_action: `${data.entity}.bulk_import`,
      p_after: { error_count: errors.length, inserted: imported.data },
      p_before: null,
      p_entity_id: null,
      p_entity_type: data.entity,
      p_error_code: null,
      p_result: "success",
    });
    if (audit.error) throw new Error(audit.error.message);

    return { inserted: imported.data, errors };
  });
