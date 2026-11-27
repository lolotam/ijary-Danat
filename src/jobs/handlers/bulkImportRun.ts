import { companyClient } from "@/company/companyClient.server";
import { runWithRequestCompany } from "@/company/requestCompany.server";
import { runImportBatch } from "@/fns/bulkImportRun.server";
import { claimImportBatch } from "@/fns/importBatches.server";
import type { JobPayload } from "@/jobs/catalog";
import type { JobHandler, JobHandlerContext } from "@/worker/runJob";

/**
 * يبني معالج مهمة `import.run`: يستلم الدفعة المرحَّلة من `import_batches` ويحذفها،
 * ثم ينفّذ حلّ المراجع والإدراج عبر `bulk_import_phase6` ويعيد العدّادات.
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
