import { companyClient } from "@/company/companyClient.server";
import { runWithRequestCompany } from "@/company/requestCompany.server";
import { runBackupJob } from "@/fns/backupJob";
import { BackupInsertError, createBackupArchive } from "@/fns/backupCore";
import type { JobPayload } from "@/jobs/catalog";
import type { JobHandler, JobHandlerContext } from "@/worker/runJob";

import { createCronHandlers } from "./cron";
import { loadBackupByJobKey, loadSyncJobRequest } from "./sync";

/** نتيجة مهمة `company.export` اليدوية: النسخة المنشأة وعدّاداتها. */
interface ManualExportResult {
  backupId: string;
  created: number;
  skipped: number;
}

/**
 * يبني معالج مهمة `company.export`: نسخة احتياطية يدوية عند الطلب، ونسخة
 * الليل التلقائية عند الإطلاق المجدول.
 *
 * Two callers share the kind, and the payload's optional `requestId` is what
 * tells them apart (contracts/jobs.md section 5: dedupe request id):
 *
 * - A staff request always mints one — `src/fns/backup.ts` queues the job and
 *   the handler creates one `manual` backup whose `period_key` is the job's
 *   own id, so a retry of the same job finds that row and creates nothing
 *   twice while a second deliberate click still gets its own backup.
 * - The nightly fan-out (`src/worker/scheduler.ts`, 01:50 Asia/Kuwait) files
 *   no request id, and the run is the old `backup` cron job in full — its
 *   pause switch, its run record, and `runBackupJob`'s daily/weekly toggles
 *   and period keys. That work is borrowed from the cron machinery rather
 *   than copied into this file.
 */
export function createCompanyExportHandler(): JobHandler {
  const nightlyBackup = createCronHandlers({
    "company.export": { registryKey: "backup", work: runBackupJob },
  })["company.export"];
  if (!nightlyBackup) {
    throw new Error("company.export missing from the nightly backup handler map");
  }

  return async (ctx: JobHandlerContext) => {
    const payload = ctx.payload as JobPayload<"company.export">;
    if (!payload.requestId) return nightlyBackup(ctx);
    return runWithRequestCompany({ id: ctx.companyId, slug: "", status: "active", host: "" }, () =>
      runManualExport(ctx),
    );
  };
}

/**
 * ينشئ نسخة احتياطية يدوية واحدة لهذه المهمة، ولا يكررها عند إعادة المحاولة.
 *
 * The job id is the backup's natural key (`period_key`) under the unique
 * `(company_id, kind, period_key)` index. The pre-check below is what a retry
 * normally sees; the 23505 branch is the race a read cannot see (a stalled
 * job taken over mid-insert), where the winner's backup is this job's backup.
 */
async function runManualExport(ctx: JobHandlerContext): Promise<ManualExportResult> {
  const db = companyClient(ctx.companyId);

  const request = await loadSyncJobRequest(db, ctx.jobRequestId);
  if (request.companyId !== ctx.companyId) {
    throw new Error(`job request ${ctx.jobRequestId} belongs to another company`);
  }

  const existing = await loadBackupByJobKey(db, "manual", ctx.jobRequestId);
  if (existing) return { backupId: existing.id, created: 0, skipped: 1 };

  try {
    const record = await createBackupArchive({
      companyId: ctx.companyId,
      kind: "manual",
      createdBy: request.requestedBy,
      periodKey: ctx.jobRequestId,
    });
    return { backupId: record.id, created: 1, skipped: 0 };
  } catch (error) {
    if (error instanceof BackupInsertError && error.code === "23505") {
      const winner = await loadBackupByJobKey(db, "manual", ctx.jobRequestId);
      if (winner) return { backupId: winner.id, created: 0, skipped: 1 };
    }
    throw error;
  }
}
