import type { SupabaseClient } from "@supabase/supabase-js";

import { companyClient } from "@/company/companyClient.server";
import { runWithRequestCompany } from "@/company/requestCompany.server";
import { runImportBatch } from "@/fns/bulkImportRun.server";
import {
  claimImportBatch,
  IMPORT_PERMISSION_BY_ENTITY,
  type ImportBatchRow,
} from "@/fns/importBatches.server";
import type { Database } from "@/integrations/supabase/database.types";
import type { JobPayload } from "@/jobs/catalog";
import type { JobHandler, JobHandlerContext } from "@/worker/runJob";

import { loadSyncJobRequest } from "./sync";

/**
 * يتحقق وقت التنفيذ من أن طالب الاستيراد هو صاحب الدفعة وما زال يملك صلاحية الإنشاء.
 *
 * Same discipline as `syncRestore`: the requester comes from the `job_requests`
 * row, not the payload, and must match the batch's `requested_by`; a staff
 * member whose permission was removed between the click and the run must not
 * get the import. Runs after the claim on purpose, so a refused batch is gone
 * instead of lingering for a later retry to pick up.
 */
async function assertRequesterMayImport(
  db: SupabaseClient<Database>,
  ctx: JobHandlerContext,
  batch: ImportBatchRow,
): Promise<void> {
  const request = await loadSyncJobRequest(db, ctx.jobRequestId);
  if (request.companyId !== ctx.companyId || batch.company_id !== ctx.companyId) {
    throw new Error(`import job ${ctx.jobRequestId} does not belong to this company`);
  }
  if (!request.requestedBy || request.requestedBy !== batch.requested_by) {
    throw new Error(`import job ${ctx.jobRequestId} was not requested by the batch's owner`);
  }
  const { data: allowed, error } = await db.rpc("has_permission", {
    _code: IMPORT_PERMISSION_BY_ENTITY[batch.entity],
    _user_id: request.requestedBy,
  });
  if (error) throw new Error(`has_permission re-check failed: ${error.message}`);
  if (!allowed) {
    throw new Error("the requester can no longer import these records; the import was refused");
  }
}

/**
 * يبني معالج مهمة `import.run`: يستلم الدفعة المرحَّلة من `import_batches` ويحذفها،
 * ويعيد التحقق من صلاحية طالبها، ثم ينفّذ الإدراج عبر `bulk_import_phase6` ويعيد العدّادات.
 *
 * The batch is claimed (deleted) before the insert so a retry can never insert
 * the same rows twice; see `claimImportBatch`. The result carries `created` and
 * `failed` next to the import's own fields because the requester's notice reads
 * those two names (`noticeCountsFrom` in src/worker/runJob.ts).
 */
export function createBulkImportRunHandler(): JobHandler {
  return async (ctx: JobHandlerContext) => {
    const { uploadId } = ctx.payload as JobPayload<"import.run">;
    return runWithRequestCompany(
      { id: ctx.companyId, slug: "", status: "active", host: "" },
      async () => {
        const db = companyClient(ctx.companyId);
        const batch = await claimImportBatch(db, uploadId);
        await assertRequesterMayImport(db, ctx, batch);
        const outcome = await runImportBatch(db, batch);
        return {
          ...outcome,
          created: outcome.inserted,
          failed: outcome.errors.length + (outcome.limit?.refusedRows ?? 0),
        };
      },
    );
  };
}
