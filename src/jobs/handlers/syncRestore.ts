import { companyClient } from "@/company/companyClient.server";
import { runWithRequestCompany } from "@/company/requestCompany.server";
import { performRestore } from "@/fns/restoreBackup";
import type { JobPayload } from "@/jobs/catalog";
import type { JobHandler, JobHandlerContext } from "@/worker/runJob";

import { loadBackupByJobKey, loadSyncJobRequest } from "./sync";

/**
 * يبني معالج مهمة `company.restore`: استعادة تدميرية من نسخة احتياطية بعد
 * إعادة التحقق من مَن طلبها.
 *
 * Restore rewrites the whole database, so the handler refuses to trust the
 * payload alone. The company and the requester come from the `job_requests`
 * row (contracts/jobs.md section 1), and the requester's admin role — the same
 * gate the request passed — is re-checked at run time: a requester demoted (or
 * deactivated) between the click and the run must not get their restore. The
 * payload carries only which backup to take, and the company-scoped read of it
 * finds nothing for another company's id.
 *
 * Idempotent per job id: the pre-restore safety archive `performRestore`
 * creates is keyed to the job id, so its row is the marker a retry reads
 * before restoring twice (contracts/jobs.md section 3).
 */
export function createCompanyRestoreHandler(): JobHandler {
  return async (ctx: JobHandlerContext) => {
    const { requestId: backupId } = ctx.payload as JobPayload<"company.restore">;
    return runWithRequestCompany(
      { id: ctx.companyId, slug: "", status: "active", host: "" },
      async () => {
        const db = companyClient(ctx.companyId);

        const request = await loadSyncJobRequest(db, ctx.jobRequestId);
        if (request.companyId !== ctx.companyId) {
          throw new Error(`job request ${ctx.jobRequestId} belongs to another company`);
        }
        if (!request.requestedBy) {
          throw new Error(`restore job ${ctx.jobRequestId} has no requester to re-check`);
        }

        const { data: stillAdmin, error: roleError } = await db.rpc("has_role", {
          _role: "admin",
          _user_id: request.requestedBy,
        });
        if (roleError) throw new Error(`has_role re-check failed: ${roleError.message}`);
        if (!stillAdmin) {
          throw new Error("the requester is no longer an administrator; the restore was refused");
        }

        const marker = await loadBackupByJobKey(db, "pre_restore", ctx.jobRequestId);
        if (marker) return { safetyBackupId: marker.id, restored: false, skipped: 1 };

        return performRestore({
          companyId: ctx.companyId,
          backupId,
          actor: request.requestedBy,
          jobRequestId: ctx.jobRequestId,
        });
      },
    );
  };
}
