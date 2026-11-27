import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/integrations/supabase/database.types";
import type { ImportEntity } from "@/lib/bulkImportSchemas";

/**
 * صلاحية الإنشاء المطلوبة لاستيراد كل نوع، يقرؤها `bulkImport` عند الطلب والعامل عند التنفيذ.
 *
 * One map for both checks: the worker re-checks the requester at run time, and
 * two copies would let the request and the run disagree on what an import needs.
 */
export const IMPORT_PERMISSION_BY_ENTITY = {
  expenses: "expenses.create",
  deposits: "deposits.create",
  tenants: "tenants.create",
  properties: "properties.create",
  buildings: "buildings.create",
  units: "units.create",
  maintenance: "maintenance.create",
  contracts: "contracts.create",
} as const satisfies Record<ImportEntity, string>;

/** دفعة استيراد مرحَّلة في جدول `import_batches`. */
export interface ImportBatchRow {
  id: string;
  company_id: string;
  entity: ImportEntity;
  rows: Array<Record<string, unknown>>;
  row_numbers: number[] | null;
  requested_by: string;
}

/** يحفظ صفوف الاستيراد المصادَق عليها في جدول `import_batches` ويعيد معرّف الدفعة. */
export async function stageImportBatch(
  db: SupabaseClient<Database>,
  input: {
    companyId: string;
    entity: ImportEntity;
    rows: Array<Record<string, unknown>>;
    rowNumbers?: number[];
    requestedBy: string;
  },
): Promise<{ id: string }> {
  const { data, error } = await db
    .from("import_batches")
    .insert({
      company_id: input.companyId,
      entity: input.entity,
      rows: input.rows as Json,
      row_numbers: (input.rowNumbers ?? null) as Json | null,
      requested_by: input.requestedBy,
    })
    .select("id")
    .single();
  if (error) throw new Error(`import_batches insert failed: ${error.message}`);
  return data;
}

/**
 * يستلم دفعة الاستيراد المرحَّلة ويحذفها في خطوة واحدة، ويرمي خطأً إن لم توجد.
 *
 * Claiming with `delete … returning` before the insert runs is deliberate:
 * once `bulk_import_phase6` commits, nothing after it (audit, cleanup) may
 * fail in a way that lets a retry insert the same rows a second time. A
 * transient failure after the claim loses the staged rows instead; the job
 * fails, the requester's notice says so, and the file can be imported again.
 * Losing a staging copy is recoverable; duplicate renters or contracts are not.
 */
export async function claimImportBatch(
  db: SupabaseClient<Database>,
  batchId: string,
): Promise<ImportBatchRow> {
  const { data, error } = await db
    .from("import_batches")
    .delete()
    .eq("id", batchId)
    .select("id, company_id, entity, rows, row_numbers, requested_by")
    .maybeSingle();
  if (error) throw new Error(`import_batches claim failed: ${error.message}`);
  if (!data) throw new Error(`import batch ${batchId} not found or already claimed`);
  return {
    id: data.id,
    company_id: data.company_id,
    entity: data.entity as ImportEntity,
    rows: data.rows as Array<Record<string, unknown>>,
    row_numbers: data.row_numbers as number[] | null,
    requested_by: data.requested_by,
  };
}
