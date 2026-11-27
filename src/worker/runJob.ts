import type { ZodIssue } from "zod";

import type { ModuleKey } from "@/company/modules";
import { JOB_CATALOG, type JobKind, type NoticeTarget } from "@/jobs/catalog";

import type { JobAttempt, ProcessJob } from "./types";

/** حالة صف طلب المهمة كما يخزّنها صندوق `job_requests`. */
export type JobRequestStatus =
  | "pending"
  | "published"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

/** سبب تخطي المهمة: الشركة معلّقة أو القسم المطلوب مُطفأ. */
export type SkipReason = "company_suspended" | "module_disabled";

/**
 * مرجع صف طلب المهمة: معرّفه وشركته معاً.
 *
 * The worker writes as `service_role`, which bypasses RLS, so every write names
 * the company next to the row id: an id on its own could reach another
 * company's row. Both values come from the row the worker loaded, and that
 * load already filtered on the attempt's id and company.
 */
export interface JobRequestRef {
  id: string;
  companyId: string;
}

/** صف طلب المهمة كما يراه العامل: المصدر الوحيد للحمولة وطلب الإشعار. */
export interface JobRequestRow {
  id: string;
  companyId: string;
  /**
   * نوع المهمة كما يحمله الصف.
   *
   * The column is free text, so a row written by another release may name a
   * kind this build does not know; `runJob` fails such a row instead of
   * guessing.
   */
  kind: string;
  payload: unknown;
  status: JobRequestStatus;
  requestedBy: string | null;
}

/** ما يستلمه معالج المهمة عند تشغيله. */
export interface JobHandlerContext {
  jobRequestId: string;
  companyId: string;
  payload: unknown;
  attempt: number;
}

/** معالج نوع مهمة واحدة؛ نتيجته تُخزَّن في `job_requests.result`. */
export type JobHandler = (ctx: JobHandlerContext) => Promise<unknown>;

/** عدّادات نتيجة بعض المعالجين (الأعمال الضخمة) التي تحملها جسم الإشعار. */
export type JobNoticeCounts = {
  /** عدد السجلات التي أُنشئت فعلاً. */
  created?: number;
  /** عدد العناصر التي كان لا عمل لها. */
  skipped?: number;
  /** عدد العناصر التي فشلت. */
  failed?: number;
};

/** إشعار يصل لصاحب الطلب عند انتهاء مهمة يطلب نوعها إشعاراً. */
export interface JobNotice {
  companyId: string;
  userId: string;
  jobRequestId: string;
  kind: string;
  level: "success" | "error";
  /**
   * عدّادات النتيجة إن حملتها؛ وغيابها يعني إشعاراً بلا جسم كما كان.
   *
   * Failure notices carry no body, and neither do results without counts.
   */
  body?: JobNoticeCounts;
}

/** دالة تختار معالج نوع المهمة؛ نوع بلا معالج هو فشل دائم لا تأخير. */
export type HandlerLookup = (kind: JobKind) => JobHandler | undefined;

/**
 * أنواع المهام التي يواصل تعليق الشركة تنفيذها، لأن ما تنفّذه هو تسوية دفعة.
 *
 * `payment.settle` يسجّل مالاً أُخذ فعلاً من البوابة، و`webhook.process` هو ما
 * يقرأ حدث الويب هوك المخزَّن ويجدول تلك التسوية — فإيقافه يعني أن دفعة
 * معلَّقة لا تُسجَّل أبداً (FR-045).
 */
const SUSPENSION_EXEMPT_KINDS: readonly JobKind[] = ["payment.settle", "webhook.process"];

/**
 * المنافذ التي يحتاجها غلاف التنفيذ؛ خلف كل منفذ صف في `job_requests` أو معالج حقيقي.
 *
 * The wrapper itself writes no database or queue code: which role backs each
 * port (a suspended company is invisible to `companyClient`) is decided by the
 * task that wires the real implementation.
 */
export interface RunJobPorts {
  loadRequest(ref: JobRequestRef): Promise<JobRequestRow | null>;
  companyStatus(companyId: string): Promise<"active" | "suspended">;
  sectionEnabled(companyId: string, section: ModuleKey): Promise<boolean>;
  markRunning(ref: JobRequestRef, attempt: number): Promise<void>;
  markSucceeded(ref: JobRequestRef, result: unknown): Promise<void>;
  markFailed(ref: JobRequestRef, lastError: string): Promise<void>;
  markSkipped(ref: JobRequestRef, reason: SkipReason): Promise<void>;
  writeNotice(notice: JobNotice): Promise<void>;
}

/** نتيجة استدعاء المعالج: نجح بنتيجة، أو فشل بخطأ يُعاد رميه إلى BullMQ. */
type HandlerOutcome = { ok: true; result: unknown } | { ok: false; error: unknown };

/** تجهيز المهمة: حمولة محقّقة ومعالج، أو فشل دائم لا تُصلحه إعادة المحاولة. */
type PreparedJob =
  | { ok: true; payload: unknown; handler: JobHandler }
  | { ok: false; message: string };

/** مواصفات نوع واحد من الكتالوج: قسمه وإشعاره ومخطط حمولته. */
type JobSpec = (typeof JOB_CATALOG)[JobKind];

/**
 * يبني دالة تنفيذ المهمة التي يستدعيها العامل لكل محاولة.
 *
 * The order is the one in contracts/jobs.md section 3: load the row, stop on a
 * row that already finished, fail a row whose kind this build does not know,
 * skip a suspended company or a switched-off section, validate the payload,
 * then run the handler. A payload that does not match the catalogue schema is
 * permanent — retrying cannot fix bad data — so it fails the request instead
 * of throwing.
 */
export function createRunJob(ports: RunJobPorts, handlerFor: HandlerLookup): ProcessJob {
  return async (attempt: JobAttempt) => {
    const row = await ports.loadRequest({
      id: attempt.jobRequestId,
      companyId: attempt.companyId,
    });
    if (!row) throw new Error(`job request ${attempt.jobRequestId} not found`);
    if (row.status === "succeeded" || row.status === "skipped") return;

    const ref = refOf(row);
    const spec = JOB_CATALOG[row.kind as JobKind];
    if (!spec) {
      // The row names a kind this build does not know: the relay fails such
      // rows, and this is the gate behind it, so the row never stays running.
      await ports.markFailed(ref, `unknown job kind: ${row.kind}`);
      return;
    }

    const skipReason = await skipReasonFor(ports, row, spec);
    if (skipReason) {
      await ports.markSkipped(ref, skipReason);
      logJobSkipped(row, spec.section, skipReason);
      return;
    }

    const prepared = prepareJob(handlerFor, row, spec);
    if (!prepared.ok) {
      await failJob(ports, row, spec, prepared.message);
      return;
    }

    await ports.markRunning(ref, attempt.attempt);
    const outcome = await callHandler(prepared.handler, row, prepared.payload, attempt.attempt);
    if (!outcome.ok) {
      // Only the last attempt ends the row; the earlier ones leave it for
      // BullMQ to retry.
      if (attempt.attempt >= attempt.maxAttempts) {
        await failJob(ports, row, spec, errorMessage(outcome.error));
      }
      throw outcome.error;
    }

    // The notice comes before the terminal status: a notice that cannot be
    // written must leave the row retryable, or the requester never learns how
    // the job ended. The notice write is idempotent, so the retry writes one
    // notice and not two.
    await writeRequesterNotice(ports, row, spec.notice, {
      level: "success",
      counts: noticeCountsFrom(outcome.result),
    });
    await ports.markSucceeded(ref, outcome.result);
  };
}

/**
 * يبني مرجع الصف من الصف المحمّل: هما معرّف الصف وشركته.
 */
function refOf(row: JobRequestRow): JobRequestRef {
  return { id: row.id, companyId: row.companyId };
}

/**
 * يتحقق من حمولة الطلب ويجد معالجه، ويجمع الفشل الدائم في رسالة واحدة.
 *
 * The row carries the payload that was validated on enqueue, so its kind picks
 * the schema and the handler; the queue name is not trusted over it.
 */
function prepareJob(handlerFor: HandlerLookup, row: JobRequestRow, spec: JobSpec): PreparedJob {
  const parsed = spec.payload.safeParse(row.payload);
  if (!parsed.success) {
    return { ok: false, message: invalidPayloadMessage(row.kind, parsed.error.issues) };
  }
  const handler = handlerFor(row.kind as JobKind);
  if (!handler) return { ok: false, message: `no handler for ${row.kind}` };
  return { ok: true, payload: parsed.data, handler };
}

/**
 * يحدّد سبب تخطي المهمة: شركة معلّقة أو قسم مُطفأ، أو لا تخطي إطلاقاً.
 *
 * A suspended company drops its jobs, except the two kinds that settle a
 * payment: `payment.settle` records money already taken at the gateway, and
 * `webhook.process` is what schedules that settlement (owner decision
 * 2026-11-27, FR-045).
 */
async function skipReasonFor(
  ports: RunJobPorts,
  row: JobRequestRow,
  spec: JobSpec,
): Promise<SkipReason | null> {
  const status = await ports.companyStatus(row.companyId);
  if (status === "suspended" && !SUSPENSION_EXEMPT_KINDS.some((kind) => kind === row.kind)) {
    return "company_suspended";
  }

  const section = spec.section;
  if (section === null) return null;
  const enabled = await ports.sectionEnabled(row.companyId, section);
  return enabled ? null : "module_disabled";
}

/**
 * يسجّل تخطي المهمة مرةً واحدةً عند إغلاق قسمها أو تعليق شركتها.
 */
function logJobSkipped(row: JobRequestRow, section: ModuleKey | null, reason: SkipReason): void {
  console.info(
    `[worker] skipped job ${row.id} (${row.kind}) for company ${row.companyId}: ${reason}${section ? ` (${section})` : ""}`,
  );
}

/**
 * ينهي الصف كفشل: يسجّل سبب الفشل ثم يخبر صاحب الطلب.
 *
 * The reason is stored before the notice: `last_error` is the only trace of
 * why the job stopped, and a notice that cannot be written must not hide it.
 */
async function failJob(
  ports: RunJobPorts,
  row: JobRequestRow,
  spec: JobSpec,
  message: string,
): Promise<void> {
  await ports.markFailed(refOf(row), message);
  await writeRequesterNotice(ports, row, spec.notice, { level: "error" });
}

/**
 * ينفّذ المعالج ويلتقط خطأه دون ابتلاعه؛ التعذّر يُعاد رميه في كل محاولة.
 */
async function callHandler(
  handler: JobHandler,
  row: JobRequestRow,
  payload: unknown,
  attempt: number,
): Promise<HandlerOutcome> {
  try {
    const result = await handler({
      jobRequestId: row.id,
      companyId: row.companyId,
      payload,
      attempt,
    });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error };
  }
}

/** ما يحمله إشعار صاحب الطلب: مستوى النهاية وعدّادات النتيجة إن وُجدت. */
type NoticeContent = {
  level: JobNotice["level"];
  counts?: JobNoticeCounts;
};

/**
 * يكتب إشعاراً لصاحب الطلب عندما يطلب نوع المهمة إشعاراً وله مستلم.
 *
 * The "platform" notice target writes no user notice here: platform notices
 * are raised by their own job later. Only a success notice carries the
 * result's counts; a failure notice reads as it always did.
 */
async function writeRequesterNotice(
  ports: RunJobPorts,
  row: JobRequestRow,
  noticeTarget: NoticeTarget,
  content: NoticeContent,
): Promise<void> {
  if (noticeTarget !== "requester") return;
  if (!row.requestedBy) return;
  await ports.writeNotice({
    companyId: row.companyId,
    userId: row.requestedBy,
    jobRequestId: row.id,
    kind: row.kind,
    level: content.level,
    ...(content.counts === undefined ? {} : { body: content.counts }),
  });
}

/**
 * يستخرج العدّادات الرقمية (أي مجموعة منها) من كائن مجهول، أو لا شيء إن لم يحمل عدّادات.
 *
 * The writer side reads it on the handler result — `BulkRunResult` in
 * `jobs/handlers/bulkChunks.ts` carries created/skipped/failed beside error
 * texts, and only the numbers belong in the notice body — while the bell runs
 * the same narrowing on the jsonb body of a stored row. A value that carries
 * no numeric count keeps the notice body empty.
 */
export function noticeCountsFrom(value: unknown): JobNoticeCounts | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  const counts: JobNoticeCounts = {};
  if (isCount(fields.created)) counts.created = fields.created;
  if (isCount(fields.skipped)) counts.skipped = fields.skipped;
  if (isCount(fields.failed)) counts.failed = fields.failed;
  return Object.keys(counts).length > 0 ? counts : undefined;
}

/** هل القيمة عدّاد: عدد حقيقي نهائي؟ */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * يبني نص خطأ موجزاً من مشاكل تحقق Zod ليُخزَّن في `job_requests.last_error`.
 */
function invalidPayloadMessage(kind: string, issues: ZodIssue[]): string {
  const details = issues
    .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
    .join("; ");
  return `invalid payload for ${kind}: ${details}`;
}

/**
 * يستخرج نص الخطأ كما يُخزَّن في `last_error`.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
