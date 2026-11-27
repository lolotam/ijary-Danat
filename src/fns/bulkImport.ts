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
import { IMPORT_PERMISSION_BY_ENTITY, stageImportBatch } from "@/fns/importBatches.server";
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

/**
 * يستورد دفعة صفوف عبر التحقق المتزامن ثم التمرحيل في `import_batches` وحجز مهمة `import.run`.
 *
 * Validation runs synchronously so the dialog gets row-level errors right away;
 * when at least one valid row remains, the rows are staged in Postgres (never
 * in the queue payload — contracts/jobs.md section 1) and handed to the worker.
 *
 * The request is audited here, through the caller's own client, because only
 * this client carries who asked (and the impersonating super admin, if any):
 * the worker runs as `company_service`, whose audit rows have no actor. Its
 * outcome rows carry `upload_id` and `requested_by` to link back to this one.
 * The audit runs before the enqueue and throws, so no import runs unaudited.
 */
export const bulkImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }): Promise<BulkImportResult> => {
    await requirePermission(context, {
      code: IMPORT_PERMISSION_BY_ENTITY[data.entity],
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

    const audit = await context.supabase.rpc("write_audit", {
      p_action: `${data.entity}.bulk_import_requested`,
      p_after: {
        error_count: validated.errors.length,
        staged_rows: validated.validRows.length,
        upload_id: batch.id,
      },
      p_before: null,
      p_entity_id: null,
      p_entity_type: data.entity,
      p_error_code: null,
      p_result: "success",
    });
    if (audit.error) throw new Error(`Audit write failed: ${audit.error.message}`);

    const { jobId } = await enqueueJob(
      db,
      "import.run",
      { uploadId: batch.id },
      { dedupeKey: `import.run:${batch.id}`, requestedBy: context.userId },
    );

    return { queued: true, jobRequestId: jobId, errors: validated.errors };
  });
