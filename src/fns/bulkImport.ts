import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import {
  dedupeRowsByCode,
  ENTITIES_DEDUPED_BY_CODE,
  type BulkImportLimitRefusal,
  type RefusedImportRow,
} from "@/fns/bulkImportRun.server";
import { stageImportBatch } from "@/fns/importBatches.server";
import { requirePermission } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { enqueueJob } from "@/jobs/enqueue";
import {
  importEntitySchema,
  validateImportRows,
  type ImportValidationError,
} from "@/lib/bulkImportSchemas";

export { dedupeRowsByCode, ENTITIES_DEDUPED_BY_CODE };
export type { BulkImportLimitRefusal, RefusedImportRow };

const schema = z.object({
  entity: importEntitySchema,
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
  /**
   * أرقام الصفوف في الملف الأصلي، بنفس ترتيب `rows`.
   *
   * The browser knows which CSV line every row came from; without these numbers
   * the server's line numbers drift from the file as soon as a row above is invalid.
   */
  rowNumbers: z.array(z.number().int().min(2)).optional(),
});

export type BulkImportInput = z.infer<typeof schema>;

/** نتيجة فورية لعملية استيراد لم تُرحَّل إلى الطابور (عدم وجود صفوف صالحة). */
export interface BulkImportImmediateResult {
  queued?: false;
  errors: ImportValidationError[];
  inserted: number;
  /** رفض دفعة الاستيراد بسبب حد من حدود الشركة، إن رفضها حد. */
  limit: BulkImportLimitRefusal | null;
}

/** نتيجة حجز مهمة استيراد جماعي في الطابور الخلفي. */
export interface BulkImportQueuedResult {
  queued: true;
  jobRequestId: string;
  errors: ImportValidationError[];
}

export type BulkImportResult = BulkImportImmediateResult | BulkImportQueuedResult;

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

/**
 * يستورد دفعة صفوف عبر التحقق المتزامن ثم التمرحيل في `import_batches` وحجز مهمة `import.run`.
 *
 * Validation runs synchronously so the dialog gets row-level errors right away;
 * when at least one valid row remains, the rows are staged in Postgres (never
 * in the queue payload — contracts/jobs.md section 1) and handed to the worker.
 */
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
    if (!validated.validRows.length) {
      return { queued: false, inserted: 0, errors: validated.errors, limit: null };
    }

    const batch = await stageImportBatch(db, {
      companyId: company.id,
      entity: data.entity,
      rows: validated.validRows,
      rowNumbers: data.rowNumbers,
      requestedBy: context.userId,
    });

    const { jobId } = await enqueueJob(
      db,
      "import.run",
      { uploadId: batch.id },
      { dedupeKey: `import.run:${batch.id}`, requestedBy: context.userId },
    );

    return { queued: true, jobRequestId: jobId, errors: validated.errors };
  });
