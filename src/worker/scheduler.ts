import type { Job, Queue } from "bullmq";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/database.types";
import { companyCalendarDate, JOB_CATALOG, type JobKind } from "@/jobs/catalog";
import {
  platformDueSubscriptionReminders,
  type SubscriptionReminder,
} from "@/platform/subscriptions";

import type { RelayedJobData } from "./types";

/**
 * توقيت الشركة الذي تُحسب عليه الجداول الزمنية (contracts/jobs.md section 7).
 *
 * Kuwait is UTC+3 all year, so the schedules keep their meaning whatever the
 * host clock or the container's timezone is — the crontab this replaced ran in
 * the server's own timezone and drifted with it.
 */
export const COMPANY_TIMEZONE = "Asia/Kuwait";

/**
 * بادئة اسم مهمة التوزيع: تفرّقها عن مهام `job_requests` التي تحمل الطابور نفسه.
 *
 * The `cron` queue carries two shapes: the fan-out the scheduler fires, and a
 * relayed row a company filed (a platform `subscription.remind`). No
 * catalogue kind contains a colon, so the prefix tells the two apart.
 */
export const FAN_OUT_JOB_PREFIX = "fanout:";

/** وحدة التوزيع: ما الذي يحدّد الصفوف التي يوزّعها الجدول. */
export type FanOutUnit =
  /** صف لكل شركة نشطة. */
  | "company"
  /** صف لكل وصلة صندوق بريد مربوطة (مزامنة Gmail). */
  | "gmail-connection"
  /** صف لكل جدول زمني مستحق (التقارير المجدولة). */
  | "report-schedules"
  /** صف لكل علامة تجديد اشتراك مستحقة (منصة، لا شركة). */
  | "subscription";

/** الفتحة الزمنية في مفتاح منع التكرار: يوم، أو شهر، أو نافذة عشر دقائق. */
export type FanOutSlot = "day" | "month" | "window";

/** جدول زمني واحد كما يصفه contracts/jobs.md section 7. */
export interface ScheduleDefinition {
  /** نوع المهمة التي يوزّعها الجدول؛ وهو أيضاً معرّف مجدول BullMQ. */
  kind: JobKind;
  /** نمط كرون بتوقيت الشركة. */
  pattern: string;
  /** مفتاح صف `cron_jobs` الذي يحمل مفتاح الإيقاف الخاص بهذا الجدول. */
  registryKey: string;
  /** وحدة التوزيع. */
  unit: FanOutUnit;
  /** الفتحة الزمنية التي يحملها مفتاح منع التكرار. */
  slot: FanOutSlot;
}

/**
 * جداول التوزيع كما يصفها contracts/jobs.md section 7.
 *
 * `gmail.sync` and `payment.reconcile` run every ten minutes but never in the
 * same minute: the reconciliation settles the payments the webhook never
 * delivered, and it must not queue behind a mailbox sync. The old host crontab
 * staggered them for the same reason (deploy/README.md).
 *
 * `company.export` is the nightly backup fan-out — one export per active,
 * unpaused company at 01:50, the crontab's old backup slot.
 *
 * `usage.rebuild` is the nightly storage-usage rebuild — one rebuild per
 * active company at 02:30, half an hour after the log retention job it
 * follows.
 */
export const SCHEDULES: readonly ScheduleDefinition[] = [
  {
    kind: "overdue.evaluate",
    pattern: "10 1 * * *",
    registryKey: "overdue",
    unit: "company",
    slot: "day",
  },
  {
    kind: "overdue.remind",
    pattern: "15 1 * * *",
    registryKey: "overdue-reminders",
    unit: "company",
    slot: "day",
  },
  {
    kind: "contract.expiry",
    pattern: "20 1 * * *",
    registryKey: "contract-expiry",
    unit: "company",
    slot: "day",
  },
  {
    kind: "report.run",
    pattern: "30 1 * * *",
    registryKey: "scheduled-reports",
    unit: "report-schedules",
    slot: "day",
  },
  {
    kind: "salaries.generate",
    pattern: "30 1 1 * *",
    registryKey: "salaries",
    unit: "company",
    slot: "month",
  },
  {
    kind: "notification.drain",
    pattern: "40 1 * * *",
    registryKey: "notification-drain",
    unit: "company",
    slot: "day",
  },
  {
    // The nightly backup — `company.export` replaces the old `backup` cron
    // (contracts/jobs.md section 5). 01:50 is the crontab's own backup slot:
    // after the 01:10–01:40 batch and before `log.retention` at 02:00, which
    // the workflow catalogue describes as running "after the backup".
    kind: "company.export",
    pattern: "50 1 * * *",
    registryKey: "backup",
    unit: "company",
    slot: "day",
  },
  {
    kind: "log.retention",
    pattern: "0 2 * * *",
    registryKey: "log-retention",
    unit: "company",
    slot: "day",
  },
  {
    // The nightly storage-usage rebuild — the counters are kept in step by the
    // storage triggers, and this recomputes the total from the stored objects
    // themselves. 02:30 is free: the 02:00 batch is behind it and the 08:00
    // platform tick is hours away.
    //
    // The key is registry-only: no `cron_jobs` row carries it, so no company
    // can pause this rebuild and no panel entry promises a cadence for it.
    kind: "usage.rebuild",
    pattern: "30 2 * * *",
    registryKey: "usage-rebuild",
    unit: "company",
    slot: "day",
  },
  {
    // Platform-owned: one row per renewal mark at 08:00 company time, not one
    // per company. The mark and the renewal date travel in the payload; the
    // key `<kind>__<companyId>__<renewalDate>__<offset>` keeps a repeated tick
    // from filing the same warning twice (contracts/jobs.md section 5).
    kind: "subscription.remind",
    pattern: "0 8 * * *",
    registryKey: "subscription-remind",
    unit: "subscription",
    slot: "day",
  },
  {
    kind: "gmail.sync",
    pattern: "*/10 * * * *",
    registryKey: "gmail-sync",
    unit: "gmail-connection",
    slot: "window",
  },
  {
    kind: "payment.reconcile",
    pattern: "5-59/10 * * * *",
    registryKey: "payment-reconcile",
    unit: "company",
    slot: "window",
  },
];

/** لحظة الجدولة بتوقيت الشركة: تاريخها وشهرها ونافذتها. */
export interface CompanyMoment {
  /** YYYY-MM-DD */
  date: string;
  /** YYYY-MM */
  month: string;
  /** نافذة العشر دقائق: YYYY-MM-DDTHH:MM */
  window: string;
}

const COMPANY_TIME_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: COMPANY_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * يحوّل لحظة النظام إلى تاريخها وشهرها ونافذتها بتوقيت الشركة.
 *
 * The window is the ten-minute bucket a ten-minute schedule fires in, so two
 * fires of the same bucket share one dedupe slot and a repeat cannot file the
 * same work twice.
 */
export function companyMoment(at: Date): CompanyMoment {
  const parts = Object.fromEntries(
    COMPANY_TIME_PARTS.formatToParts(at)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const date = companyCalendarDate(at);
  const windowMinute = String(Math.floor(Number(parts.minute) / 10) * 10).padStart(2, "0");
  return {
    date,
    month: date.slice(0, 7),
    window: `${date}T${parts.hour}:${windowMinute}`,
  };
}

/** صف موزّع واحد: الشركة والحمولة ومفتاح منع التكرار. */
export interface FanOutRow {
  companyId: string;
  kind: JobKind;
  payload: Json;
  dedupeKey: string;
}

/** ما يحتاجه المجدول من قاعدة البيانات؛ كل ما عداه حساب خالص. */
export interface SchedulerDatabase {
  /** كل الشركات وحالتها؛ التوزيع يتخطّى المعلّقة. */
  listCompanies(): Promise<
    { id: string; status: Database["public"]["Tables"]["companies"]["Row"]["status"] }[]
  >;
  /** معرّفات الشركات التي أوقفت هذا الجدول في سجل `cron_jobs`. */
  pausedCompanyIds(registryKey: string): Promise<string[]>;
  /** الجداول الزمنية للتقارير المستحقة الآن. */
  dueReportSchedules(at: Date): Promise<{ companyId: string; scheduleId: string }[]>;
  /** وصلات صندوق البريد المربوطة بكل شركة. */
  gmailConnections(): Promise<{ companyId: string; connectionId: string }[]>;
  /** علامات تجديد الاشتراك المستحقة لكل شركة في هذا اليوم. */
  subscriptionReminders(at: Date): Promise<SubscriptionReminder[]>;
  /** يسجّل صف `job_requests` للشركة؛ الصف الموجود بمفتاح التكرار لا يتكرر. */
  insertJobRequest(row: FanOutRow): Promise<void>;
}

/**
 * حمولة الصف الموزّع وفتحته الزمنية، بحسب فتحة الجدول.
 *
 * The payload travels with the row, so the worker knows which day or month it
 * is running for without reading the schedule again.
 *
 * `company.export` is the one exception: a backup is a snapshot of the moment
 * it runs (like `runBackupJob`, which deliberately ignores any reference date),
 * and its payload carries only an optional request id, so the nightly rows
 * carry an empty payload and the day travels in the dedupe slot alone.
 */
function companyFanOutFields(
  schedule: ScheduleDefinition,
  moment: CompanyMoment,
): { payload: Json; slot: string } {
  if (schedule.kind === "company.export") return { payload: {}, slot: moment.date };
  if (schedule.slot === "month") return { payload: { month: moment.month }, slot: moment.month };
  if (schedule.slot === "window") return { payload: {}, slot: moment.window };
  return { payload: { date: moment.date }, slot: moment.date };
}

/** الصفوف التي يوزّعها جدول على مستوى الشركة: صف لكل شركة نشطة. */
function companyRows(
  schedule: ScheduleDefinition,
  companies: { id: string }[],
  moment: CompanyMoment,
): FanOutRow[] {
  return companies.map((company) => {
    const fields = companyFanOutFields(schedule, moment);
    return {
      companyId: company.id,
      kind: schedule.kind,
      payload: fields.payload,
      dedupeKey: `${schedule.kind}__${company.id}__${fields.slot}`,
    };
  });
}

/** الصفوف التي يوزّعها جدول مزامنة Gmail: صف لكل صندوق بريد مربوط. */
function gmailRows(
  schedule: ScheduleDefinition,
  companies: { id: string }[],
  connections: { companyId: string; connectionId: string }[],
  moment: CompanyMoment,
): FanOutRow[] {
  const active = new Set(companies.map((company) => company.id));
  return connections
    .filter((connection) => active.has(connection.companyId))
    .map((connection) => ({
      companyId: connection.companyId,
      kind: schedule.kind,
      payload: { connectionId: connection.connectionId },
      dedupeKey: `${schedule.kind}__${connection.companyId}__${moment.window}`,
    }));
}

/** الصفوف التي يوزّعها جدول التقارير: صف لكل جدول زمني مستحق. */
function reportRows(
  schedule: ScheduleDefinition,
  companies: { id: string }[],
  dueSchedules: { companyId: string; scheduleId: string }[],
  moment: CompanyMoment,
): FanOutRow[] {
  const active = new Set(companies.map((company) => company.id));
  return dueSchedules
    .filter((due) => active.has(due.companyId))
    .map((due) => ({
      companyId: due.companyId,
      kind: schedule.kind,
      payload: { scheduleId: due.scheduleId, date: moment.date },
      // The key the admin's "run now" writes: a manual run and the nightly
      // tick are one job, so a schedule produces one report per day and not
      // two.
      dedupeKey: `${schedule.kind}:${due.scheduleId}:${moment.date}`,
    }));
}

/** الصفوف التي يوزّعها جدول تذكير الاشتراك: صف لكل علامة تجديد مستحقة. */
function subscriptionRows(
  schedule: ScheduleDefinition,
  companies: { id: string }[],
  reminders: SubscriptionReminder[],
): FanOutRow[] {
  const active = new Set(companies.map((company) => company.id));
  return reminders
    .filter((reminder) => active.has(reminder.companyId))
    .map((reminder) => ({
      companyId: reminder.companyId,
      kind: schedule.kind,
      payload: { renewalDate: reminder.renewalDate, offsetDays: reminder.offsetDays },
      dedupeKey: `${schedule.kind}__${reminder.companyId}__${reminder.renewalDate}__${reminder.offsetDays}`,
    }));
}

/**
 * يبني الصفوف التي يوزّعها جدول، بحسب وحدته.
 *
 * A suspended company is dropped here rather than in the query: the rule that
 * decides who gets work lives in the code that writes the rows.
 */
async function buildRows(
  schedule: ScheduleDefinition,
  db: SchedulerDatabase,
  moment: CompanyMoment,
  at: Date,
): Promise<FanOutRow[]> {
  const companies = (await db.listCompanies()).filter((company) => company.status === "active");
  if (schedule.unit === "subscription") {
    return subscriptionRows(schedule, companies, await db.subscriptionReminders(at));
  }
  if (schedule.unit === "report-schedules") {
    return reportRows(schedule, companies, await db.dueReportSchedules(at), moment);
  }
  if (schedule.unit === "gmail-connection") {
    return gmailRows(schedule, companies, await db.gmailConnections(), moment);
  }
  return companyRows(schedule, companies, moment);
}

/**
 * يوزّع جدولاً زمنياً على الشركات: صف `job_requests` لكل شركة، ومفتاح يمنع
 * تكرار الفتحات نفسها.
 *
 * The key is `<kind>__<companyId>__<slot>` and the insert is `on conflict do
 * nothing` (contracts/jobs.md section 7), so a schedule that fires twice
 * files the work once. A company that paused the workflow in
 * `/admin/settings/cron` is skipped altogether.
 */
export async function fanOut(
  schedule: ScheduleDefinition,
  db: SchedulerDatabase,
  at: Date,
): Promise<number> {
  const moment = companyMoment(at);
  const rows = await buildRows(schedule, db, moment, at);
  const paused = new Set(await db.pausedCompanyIds(schedule.registryKey));
  let filed = 0;
  for (const row of rows) {
    if (paused.has(row.companyId)) continue;
    await db.insertJobRequest({
      ...row,
      payload: JOB_CATALOG[row.kind].payload.parse(row.payload) as Json,
    });
    filed += 1;
  }
  return filed;
}

/**
 * يجد الجدول الذي تنتمي إليه مهمة التوزيع، أو null إذا لم يكن الاسم مهمة توزيع.
 */
export function scheduleFromJobName(name: string): ScheduleDefinition | null {
  if (!name.startsWith(FAN_OUT_JOB_PREFIX)) return null;
  const kind = name.slice(FAN_OUT_JOB_PREFIX.length);
  return SCHEDULES.find((schedule) => schedule.kind === kind) ?? null;
}

/**
 * يبني معالج مهمة التوزيع: يوزّع الجدول الذي أُطلقت من أجله المهمة.
 */
export function createFanOutProcessor(
  db: SchedulerDatabase,
): (job: Job<RelayedJobData>) => Promise<void> {
  return async (job) => {
    const schedule = scheduleFromJobName(job.name);
    if (!schedule) throw new Error(`unknown fan-out job: ${job.name}`);
    const filed = await fanOut(schedule, db, new Date());
    console.log(`[scheduler] ${schedule.kind} filed ${filed} job request(s)`);
  };
}

/** ما يحتاجه الإيقاف قبل الخروج من العملية. */
export interface SchedulerHandle {
  /** يزيل مجدولات BullMQ التي سجّلها العامل. */
  stop(): Promise<void>;
}

/**
 * يسجّل مجدول BullMQ لكل جدول، بتوقيت الشركة.
 *
 * `upsertJobScheduler` is idempotent: a worker that restarts upserts the same
 * scheduler ids instead of doubling them, and BullMQ schedules the next
 * occurrence from the moment of the upsert.
 */
export async function startScheduler(queue: Queue<RelayedJobData>): Promise<SchedulerHandle> {
  for (const schedule of SCHEDULES) {
    await queue.upsertJobScheduler(
      schedule.kind,
      { pattern: schedule.pattern, tz: COMPANY_TIMEZONE },
      { name: `${FAN_OUT_JOB_PREFIX}${schedule.kind}` },
    );
  }
  return {
    stop: async () => {
      for (const schedule of SCHEDULES) {
        try {
          await queue.removeJobScheduler(schedule.kind);
        } catch (error) {
          // A Redis that refuses the removal must not stop the shutdown: the
          // worker still has queues and workers to close.
          console.error(`[scheduler] removing ${schedule.kind} failed:`, error);
        }
      }
    },
  };
}

/**
 * منفذ الجدولة فوق عميل `service_role`: يتجاوز RLS، فالصفوف تُسمّى بشركتها.
 *
 * The fan-out writes `job_requests` directly: `enqueue_job` reads the
 * company from the caller's JWT, and the worker has none (migration 306).
 */
export const schedulerDatabase: SchedulerDatabase = {
  listCompanies: async () => {
    const { data, error } = await supabaseAdmin.from("companies").select("id, status");
    if (error) throw new Error(`companies lookup failed: ${error.message}`);
    return data ?? [];
  },
  pausedCompanyIds: async (registryKey) => {
    const { data, error } = await supabaseAdmin
      .from("cron_jobs")
      .select("company_id")
      .eq("key", registryKey)
      .eq("is_active", false);
    if (error) throw new Error(`cron_jobs lookup for ${registryKey} failed: ${error.message}`);
    return (data ?? []).map((row) => row.company_id);
  },
  dueReportSchedules: async (at) => {
    const { data, error } = await supabaseAdmin
      .from("report_schedules")
      .select("company_id, id")
      .eq("is_active", true)
      .or(`next_run_at.is.null,next_run_at.lte.${at.toISOString()}`);
    if (error) throw new Error(`report_schedules lookup failed: ${error.message}`);
    return (data ?? []).map((row) => ({ companyId: row.company_id, scheduleId: row.id }));
  },
  gmailConnections: async () => {
    const { data, error } = await supabaseAdmin.from("gmail_connections").select("company_id, id");
    if (error) throw new Error(`gmail_connections lookup failed: ${error.message}`);
    return (data ?? []).map((row) => ({ companyId: row.company_id, connectionId: row.id }));
  },
  subscriptionReminders: async (at) => platformDueSubscriptionReminders(at),
  insertJobRequest: async (row) => {
    const { error } = await supabaseAdmin.rpc("enqueue_job_for_company", {
      _company_id: row.companyId,
      _kind: row.kind,
      _payload: row.payload,
      _dedupe_key: row.dedupeKey,
    });
    if (error) throw new Error(`enqueue_job_for_company(${row.kind}) failed: ${error.message}`);
  },
};
