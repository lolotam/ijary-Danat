import { companyClient } from "@/company/companyClient.server";
import { listActiveCompanies } from "@/company/hostCompany.server";
import { runWithRequestCompany, type RequestCompany } from "@/company/requestCompany.server";
import { runContractExpiryJob } from "@/fns/contractExpiryJob";
import { runEvaluateOverdueJob } from "@/fns/evaluateOverdue";
import { runGmailSyncJob } from "@/fns/gmailSyncJob";
import { runSalariesJob } from "@/fns/salariesJob";
import { runNotificationDrainJob } from "@/fns/notificationDrainJob";
import { runOverdueRemindersJob } from "@/fns/overdueRemindersJob";
import { runPaymentReconcileJob } from "@/fns/paymentReconcileJob";
import { runScheduledReportsJob } from "@/fns/scheduledReportsJob";
import { runBackupJob } from "@/fns/backupJob";
import { runLogRetentionJob } from "@/fns/logRetentionJob";
import { isWorkflowPaused, recordWorkflowRun } from "@/fns/workflowRegistry";
import { isValidCronSecret, readCronSecretHeader } from "@/lib/cronAuth";

/**
 * Jobs runnable unattended. Each is idempotent, so a missed tick can be retried
 * and a repeated tick is harmless:
 * - overdue: a state transition; a second run finds nothing left to flip.
 * - overdue-reminders: one reminder set per tenant per calendar month.
 * - contract-expiry: identify_contract_expiry_reminders excludes contracts that
 *   already have a non-cancelled reminder for the same milestone bucket.
 * - scheduled-reports: runReportScheduleRecord advances next_run_at after a run.
 * - notification-drain: dispatchNotificationRecord returns early for rows already
 *   sent or cancelled, so a repeated tick cannot re-send.
 * - gmail-sync: upserts with onConflict ignoreDuplicates, so a repeated tick
 *   over the same window cannot duplicate rows. No-ops when Gmail credentials
 *   are not configured.
 * - payment-reconcile: settleGatewayPayment returns early for a payment request
 *   already marked completed, so a repeated tick cannot double-settle.
 *
 * Exported so the admin "run now" path (runWorkflowNow) dispatches from this
 * same map. A second copy of it would let a newly added job be reachable from
 * cron but not from the UI — or worse, the reverse — with nothing failing to
 * say so.
 */
export const JOBS = {
  overdue: runEvaluateOverdueJob,
  "overdue-reminders": runOverdueRemindersJob,
  "contract-expiry": runContractExpiryJob,
  "scheduled-reports": runScheduledReportsJob,
  "notification-drain": runNotificationDrainJob,
  "gmail-sync": runGmailSyncJob,
  // Monthly payroll. Idempotent on unique (employee_id, year, month), so a
  // retried tick cannot pay anyone twice.
  salaries: runSalariesJob,
  // The liveness guarantee for gateway payments: settlement is otherwise only
  // reachable from an authenticated browser on the portal callback page.
  "payment-reconcile": runPaymentReconcileJob,
  // Automatic database backups. Idempotent on unique (kind, period_key), so a
  // retried tick — or a racing duplicate — is harmlessly skipped.
  backup: runBackupJob,
  // Deletes audit/notification log rows past the admin-chosen window. Off until
  // an admin picks one; a repeated tick finds nothing past the cutoff.
  "log-retention": runLogRetentionJob,
} as const;

export type CronJobName = keyof typeof JOBS;

const CRON_JOB_NAMES = Object.keys(JOBS) as CronJobName[];

/** نتيجة تشغيل المهمة الدورية على مستوى شركة واحدة. */
export interface CompanyCronResult {
  companyId: string;
  ok: boolean;
  skipped?: boolean;
  alreadyClaimed?: boolean;
  durationMs: number;
  result?: unknown;
  error?: string;
}

/**
 * يتحقق من أن القيمة تطابق أحد مفاتيح المهام المجدولة المسجّلة.
 */
function isCronJobName(value: unknown): value is CronJobName {
  return typeof value === "string" && value in JOBS;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * المهام قيد التنفيذ الآن في هذه العملية — قفل بسيط يمنع تشغيل المهمة نفسها
 * مرتين متزامنتين.
 *
 * On 2026-09-01 and 09-02 the three tenant-facing jobs each ran twice within
 * the same second (one entry in this host's cron; the second caller is still
 * unidentified). Every job is idempotent in the sense that a repeated tick is
 * harmless, but two CONCURRENT runs race their own idempotency reads: both
 * saw "no reminder yet this month" and both enqueued, doubling the WhatsApp
 * burst that preceded the device being unlinked. One container serves this
 * route, so a process-local set is sufficient; a second replica would need a
 * database advisory lock instead.
 */
const runningJobs = new Set<CronJobName>();

/**
 * علامة "المهمة قيد التنفيذ بالفعل": تعيدها withJobLock عندما يكون قفل
 * المهمة محجوزًا. رمزٌ لا قيمة نصية، حتى لا تُشتبه به نتيجة حقيقية
 * يمكن لمهمة ما أن تعيدها بالصدفة.
 */
export const JOB_ALREADY_RUNNING = Symbol("JOB_ALREADY_RUNNING");

/**
 * يشغّل المهمة تحت قفل التزامن الخاص باسمها: إن كانت المهمة نفسها قيد
 * التنفيذ يُعاد JOB_ALREADY_RUNNING دون تشغيلها، وإلا تُشغَّل ثم يُحرَّر
 * القفل في finally مهما حدث — فلا يستطيع استثناءٌ تعليق القفل، ولا
 * يستطيع المستدعي نسيان التحرير أو تحريره مرتين.
 *
 * Both entry points share it — respondToCronRequest (answers 409 when busy)
 * and the admin runWorkflowNow (throws when busy) — so pressing "Run now"
 * can never race an in-flight cron tick of the same job. The why is the
 * 2026-09-01/02 double-fire incident documented in the comment above
 * `runningJobs`.
 */
export async function withJobLock<T>(
  job: CronJobName,
  fn: () => Promise<T>,
): Promise<T | typeof JOB_ALREADY_RUNNING> {
  if (runningJobs.has(job)) {
    return JOB_ALREADY_RUNNING;
  }
  runningJobs.add(job);
  try {
    return await fn();
  } finally {
    runningJobs.delete(job);
  }
}

/**
 * يحجز تشغيل المهمة للشركة المحددة في قاعدة البيانات، ويرفض طلبًا مكررًا خلال الدقيقة نفسها.
 *
 * `withJobLock` only sees a duplicate that overlaps the first run. The unknown
 * second caller arrives ~0.5–0.8 s later, after the fast nightly jobs have
 * already finished, so it slipped through and ran them a second time
 * (migration 229 has the audit-log evidence). The claim lives in the
 * database, so it holds across processes and after the first run ends.
 *
 * Fails OPEN: if the claim itself cannot be checked, the job runs so a nightly
 * job is never silently skipped because of a transient RPC read failure.
 */
async function claimCronRun(companyId: string, job: CronJobName): Promise<boolean> {
  try {
    const db = companyClient(companyId);
    const { data, error } = await db.rpc("claim_cron_run", { p_key: job });
    if (error) throw new Error(error.message);
    return data === true;
  } catch (error) {
    console.error(`claim_cron_run failed for ${job} (${companyId}); running unclaimed`, error);
    return true;
  }
}

/**
 * ينفّذ مهمة مجدولة واحدة لشركة نشطة واحدة مع عزل أخطائها وتسجيل النتيجة في سجل الشركة.
 */
async function runJobForCompany(
  company: RequestCompany,
  job: CronJobName,
  asOf: string | null,
): Promise<CompanyCronResult> {
  return runWithRequestCompany(company, async () => {
    if (await isWorkflowPaused(job)) {
      await recordWorkflowRun(job, "skipped", 0, null);
      return { companyId: company.id, ok: true, skipped: true, durationMs: 0 };
    }

    if (!(await claimCronRun(company.id, job))) {
      return {
        companyId: company.id,
        ok: true,
        skipped: true,
        alreadyClaimed: true,
        durationMs: 0,
      };
    }

    const startedAt = Date.now();
    try {
      const result = await JOBS[job](asOf);
      const durationMs = Date.now() - startedAt;
      await recordWorkflowRun(job, "success", durationMs, null);
      return { companyId: company.id, ok: true, durationMs, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Job failed.";
      const durationMs = Date.now() - startedAt;
      await recordWorkflowRun(job, "error", durationMs, message);
      return { companyId: company.id, ok: false, durationMs, error: message };
    }
  });
}

/**
 * يستقبل طلب نقطة نهاية الكرون ويوزّع المهمة على كل شركة نشطة بشكل معزول.
 */
export async function respondToCronRequest(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  }

  const supplied = readCronSecretHeader(request);
  if (!supplied || !(await isValidCronSecret(supplied, secret))) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const { job, asOf = null } = (body ?? {}) as { job?: unknown; asOf?: unknown };
  if (!isCronJobName(job)) {
    return Response.json(
      { error: `Unknown job. Expected one of: ${CRON_JOB_NAMES.join(", ")}.` },
      { status: 400 },
    );
  }
  if (asOf !== null && !(typeof asOf === "string" && ISO_DATE.test(asOf))) {
    return Response.json({ error: "asOf must be a YYYY-MM-DD date or null." }, { status: 400 });
  }

  const outcome = await withJobLock(job, async () => {
    const startedAt = Date.now();
    const companies = await listActiveCompanies();
    const companyResults: CompanyCronResult[] = [];
    for (const company of companies) {
      companyResults.push(await runJobForCompany(company, job, asOf));
    }
    const durationMs = Date.now() - startedAt;

    if (companyResults.length > 0 && companyResults.every((item) => item.alreadyClaimed)) {
      return Response.json(
        { job, error: "Job already ran within the last minute." },
        { status: 409 },
      );
    }

    const skippedAll =
      companyResults.length > 0 &&
      companyResults.every((item) => item.skipped && !item.alreadyClaimed);
    if (skippedAll) {
      return Response.json({ job, durationMs: 0, skipped: true, companies: companyResults });
    }

    const failed = companyResults.filter((item) => !item.ok);
    const succeeded = companyResults.filter((item) => item.ok && !item.skipped);
    if (failed.length > 0 && succeeded.length === 0) {
      return Response.json(
        {
          job,
          durationMs,
          error: failed[0].error ?? "Job failed.",
          companies: companyResults,
        },
        { status: 500 },
      );
    }

    return Response.json({
      job,
      durationMs,
      result: companyResults.length === 1 ? succeeded[0]?.result : undefined,
      companies: companyResults,
    });
  });

  if (outcome === JOB_ALREADY_RUNNING) {
    // 409, not 200-skipped: the caller should notice it is double-firing.
    // Nothing is recorded — the run that is in flight will record itself.
    return Response.json({ job, error: "Job is already running." }, { status: 409 });
  }
  return outcome;
}
