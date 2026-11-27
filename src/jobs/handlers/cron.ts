import { runWithRequestCompany } from "@/company/requestCompany.server";
import { JOBS } from "@/fns/cronJobs";
import { isWorkflowPaused, recordWorkflowRun } from "@/fns/workflowRegistry";
import type { JobKind } from "@/jobs/catalog";
import type { JobHandler, JobHandlerContext } from "@/worker/runJob";

/** ما تشغّله مهمة دورية: التاريخ المرجعي وشركة التنفيذ. */
export type CronWork = (asOf: string | null, companyId: string) => Promise<unknown>;

/** وصف مهمة دورية: مفتاح إيقافها في السجل، والعمل القائم الذي تنفّذه. */
export interface CronJobSpec {
  /** مفتاح صف `cron_jobs` الذي يحمل مفتاح الإيقاف ونتيجة آخر تشغيل. */
  registryKey: string;
  /** العمل القائم الذي تنفّذه هذه المهمة. */
  work: CronWork;
}

/** خريطة أنواع المهام الدورية على عملها ومفتاح سجلّها. */
export type CronJobTable = Partial<Record<JobKind, CronJobSpec>>;

/**
 * المهام الدورية التي يوزّعها العامل، وكل نوع يشير إلى المفتاح نفسه في سجل
 * `cron_jobs` الذي تقرأه لوحة "/admin/settings/cron"، وإلى العمل القائم نفسه
 * الذي تشغّله ضغطة "تشغيل الآن".
 *
 * The work comes from the `JOBS` map and not from a second copy of it: a job
 * that the admin can run by hand and a job the worker fans out must be the
 * same function, or one of the two paths drifts and nothing says so.
 */
export const CRON_JOBS: CronJobTable = {
  "overdue.evaluate": { registryKey: "overdue", work: JOBS.overdue },
  "overdue.remind": { registryKey: "overdue-reminders", work: JOBS["overdue-reminders"] },
  "contract.expiry": { registryKey: "contract-expiry", work: JOBS["contract-expiry"] },
  "notification.drain": { registryKey: "notification-drain", work: JOBS["notification-drain"] },
  "log.retention": { registryKey: "log-retention", work: JOBS["log-retention"] },
  "salaries.generate": { registryKey: "salaries", work: JOBS.salaries },
  "payment.reconcile": { registryKey: "payment-reconcile", work: JOBS["payment-reconcile"] },
  "gmail.sync": { registryKey: "gmail-sync", work: JOBS["gmail-sync"] },
};

/**
 * التاريخ المرجعي للمهمة، من حمولتها: يومٌ أو شهرٌ أو لا شيء.
 *
 * The monthly payroll names the month it pays, and the job derives the year
 * and the month from it. The ten-minute jobs name no day at all: they act on
 * the present, so there is nothing to pass.
 */
function referenceDate(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const fields = payload as { date?: unknown; month?: unknown };
  if (typeof fields.date === "string") return fields.date;
  if (typeof fields.month === "string") return `${fields.month}-01`;
  return null;
}

/**
 * ينفّذ عمل المهمة شركةً واحدة، ويسجّل نتيجته في سجلّها.
 *
 * The run is recorded before the failure travels on: `last_error` is the only
 * trace of why a job stopped, and a record that cannot be written must not
 * hide it.
 */
async function runCronWork(
  spec: CronJobSpec,
  ctx: JobHandlerContext,
  asOf: string | null,
): Promise<unknown> {
  const startedAt = Date.now();
  try {
    const result = await spec.work(asOf, ctx.companyId);
    const durationMs = Date.now() - startedAt;
    await recordWorkflowRun(spec.registryKey, "success", durationMs, null);
    return { companyId: ctx.companyId, skipped: false, durationMs, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Job failed.";
    await recordWorkflowRun(spec.registryKey, "error", Date.now() - startedAt, message);
    throw error;
  }
}

/**
 * يبني معالج مهمة دورية: ينفّذ العمل لشركة واحدة، ويكتب نتيجته في سجلّها.
 *
 * The job runs inside the company's own context: the work reads the company
 * through `companyClient(companyId)`, and the registry read and the run record
 * need a request company. The pause switch is honoured here as well as in the
 * fan-out, because an admin can pause the workflow between the two.
 *
 * A repeated run is the fan-out's dedupe key to prevent, not a claim to take:
 * the key makes a second row for the same slot impossible, so a claim would
 * only stop a retry of a failed job from doing its work.
 */
function createCronHandler(spec: CronJobSpec): JobHandler {
  return async (ctx: JobHandlerContext) => {
    const asOf = referenceDate(ctx.payload);
    return runWithRequestCompany(
      { id: ctx.companyId, slug: "", status: "active", host: "" },
      async () => {
        if (await isWorkflowPaused(spec.registryKey)) {
          await recordWorkflowRun(spec.registryKey, "skipped", 0, null);
          return { companyId: ctx.companyId, skipped: true };
        }
        return runCronWork(spec, ctx, asOf);
      },
    );
  };
}

/**
 * يبني معالجات المهام الدورية من خريطة العمل.
 *
 * `runJob` treats a kind with no handler as a permanent failure, so every kind
 * the scheduler fans out has to be in this map.
 */
export function createCronHandlers(
  jobs: CronJobTable = CRON_JOBS,
): Partial<Record<JobKind, JobHandler>> {
  const handlers: Partial<Record<JobKind, JobHandler>> = {};
  for (const [kind, spec] of Object.entries(jobs)) {
    if (!spec) continue;
    handlers[kind as JobKind] = createCronHandler(spec);
  }
  return handlers;
}
