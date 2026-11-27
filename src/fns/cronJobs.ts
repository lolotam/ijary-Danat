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
 * same map, and so the worker's cron handlers wrap the same functions
 * (`src/jobs/handlers/cron.ts`). A second copy of it would let a newly added
 * job be reachable from the panel but not from the worker — or worse, the
 * reverse — with nothing failing to say so.
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

/**
 * المهام قيد التنفيذ الآن في هذه العملية — قفل بسيط يمنع تشغيل المهمة نفسها
 * مرتين متزامنتين.
 *
 * On 2026-09-01 and 09-02 the three tenant-facing jobs each ran twice within
 * the same second (one entry in the host crontab; the second caller is still
 * unidentified). Every job is idempotent in the sense that a repeated tick is
 * harmless, but two CONCURRENT runs race their own idempotency reads: both
 * saw "no reminder yet this month" and both enqueued, doubling the WhatsApp
 * burst that preceded the device being unlinked. One container serves the
 * panel, so a process-local set is sufficient; a second replica would need a
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
 * The admin's "run now" holds it, so pressing the button can never race an
 * in-flight run of the same job. The why is the 2026-09-01/02 double-fire
 * incident documented in the comment above `runningJobs`.
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
