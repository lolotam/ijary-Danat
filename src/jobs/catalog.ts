import { z } from "zod";

import type { ModuleKey } from "@/company/modules";

/** طوابير BullMQ التي يوزّع العامل عليها المهام (contracts/jobs.md section 4). */
export const QUEUE_NAMES = ["notify", "docs", "bulk", "sync", "inbound", "cron"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/**
 * من يستلم إشعار انتهاء المهمة: لا أحد، أو الموظف الذي طلبها، أو المشرف العام.
 */
export type NoticeTarget = "none" | "requester" | "platform";

interface JobSpec<S extends z.ZodTypeAny> {
  /** First queue the job runs on; "docs → notify" kinds start on `docs`. */
  queue: QueueName;
  /** Section that must be on for the job to run; null means no section gate. */
  section: ModuleKey | null;
  notice: NoticeTarget;
  payload: S;
}

const id = z.string().uuid();
const day = z.string().date();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const noFields = z.object({}).strict();
const onDay = z.object({ date: day }).strict();

/** علامات التذكير قبل تجديد الاشتراك، بتوقيت الشركة (contracts/jobs.md section 7). */
export const SUBSCRIPTION_REMINDER_MARKS = [14, 7, 1] as const;

/** علامة التجديد الذي انتهى ولم يُسجَّل تجديد جديد بعده. */
export const SUBSCRIPTION_OVERDUE_MARK = -1;

/** صياغة تاريخ الشركة (Asia/Kuwait) كما تستخدمها مفاتيح منع التكرار. */
const COMPANY_DATE_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kuwait",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * يُعيد تاريخ اليوم بتوقيت الشركة، لا تاريخ خادم العامل.
 *
 * A renewal mark is a company-facing day: a UTC midnight job run at 21:00
 * Kuwait time must still file the same key as the 08:00 run it follows.
 */
export function companyCalendarDate(at: Date): string {
  const parts = Object.fromEntries(
    COMPANY_DATE_PARTS.formatToParts(at)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * يضيف أو يطرح أياماً على تاريخ company بصيغة YYYY-MM-DD دون انحياز التوقيت.
 */
export function addCalendarDays(date: string, days: number): string {
  const instant = new Date(`${date}T00:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

/**
 * يحسب الفرق بالأيام بين تاريخين للشركة؛ القيمة السالبة تعني أن الثاني انتهى.
 */
export function daysBetweenDates(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * القنوات التي يختارها المسؤول في حوار «إرسال معلومات الشركة».
 *
 * The dialog offers a "both" option, but it expands into these two before the
 * request leaves the browser, so the job never carries a channel it cannot
 * send on.
 */
export const COMPANY_INFO_CHANNELS = ["email", "whatsapp"] as const;

/** نوع قناة إرسال معلومات الشركة. */
export type CompanyInfoChannel = (typeof COMPANY_INFO_CHANNELS)[number];

/**
 * مفاتيح سير العمل التي قد يحملها طلب إيصال الدفعة.
 *
 * Both are event workflows in `src/lib/workflowCatalog.ts`: the gateway
 * payment path and the manual invoice settlement. The key travels with the job
 * because a receipt's recipients are the workflow's own — the manual
 * settlement may be aimed at staff only, the card payment at staff and tenant
 * — and the worker must not read one workflow's switch for the other's receipt.
 */
export const PAYMENT_SUCCEEDED_WORKFLOW = "payment-succeeded";
export const MANUAL_PAYMENT_INVOICE_WORKFLOW = "manual-payment-invoice";
export const PAYMENT_RECEIPT_WORKFLOWS = [
  PAYMENT_SUCCEEDED_WORKFLOW,
  MANUAL_PAYMENT_INVOICE_WORKFLOW,
] as const;

/** نوع مفتاح سير العمل الذي يحمله إيصال الدفعة إلى العامل. */
export type PaymentReceiptWorkflow = (typeof PAYMENT_RECEIPT_WORKFLOWS)[number];

/** يبني وصف نوع مهمة واحد مع الاحتفاظ بنوع مخطط الحمولة الدقيق. */
function spec<S extends z.ZodTypeAny>(
  queue: QueueName,
  section: ModuleKey | null,
  notice: NoticeTarget,
  payload: S,
): JobSpec<S> {
  return { queue, section, notice, payload };
}

/**
 * كتالوج أنواع المهام الخلفية: الطابور، والقسم المطلوب، والإشعار، ومخطط الحمولة لكل نوع.
 *
 * Source: contracts/jobs.md section 5. A payload carries ids and the choices
 * the request made — channels, language, workflow key — never secrets or
 * document bodies, and every schema is strict so a stray field fails loudly.
 */
export const JOB_CATALOG = {
  "notification.dispatch": spec("notify", null, "none", z.object({ notificationId: id }).strict()),
  "notification.bulk": spec("bulk", null, "requester", z.object({ requestId: id }).strict()),
  "invoice.send": spec(
    "docs",
    "invoices",
    "none",
    z.object({ invoiceId: id, channel: z.enum(["email", "whatsapp"]) }).strict(),
  ),
  "payment.receipt": spec(
    "docs",
    "payments",
    "none",
    z.object({ paymentId: id, workflow: z.enum(PAYMENT_RECEIPT_WORKFLOWS) }).strict(),
  ),
  "company.info.send": spec(
    "docs",
    "tenants",
    "none",
    z
      .object({
        tenantId: id,
        channels: z.array(z.enum(COMPANY_INFO_CHANNELS)).min(1),
        language: z.enum(["ar", "en"]),
      })
      .strict(),
  ),
  "contract.pdf": spec(
    "docs",
    "contracts",
    "none",
    z.object({ contractId: id, version: z.number().int().positive() }).strict(),
  ),
  "report.run": spec("docs", "reports", "none", z.object({ scheduleId: id, date: day }).strict()),
  "report.export": spec("docs", "reports", "requester", z.object({ requestId: id }).strict()),
  "invoices.generate": spec(
    "bulk",
    "invoices",
    "requester",
    z.object({ year: z.number().int().min(2000).max(2100) }).strict(),
  ),
  "invoices.regenerate": spec(
    "bulk",
    "invoices",
    "requester",
    z.object({ contractId: id, requestId: id }).strict(),
  ),
  "import.run": spec("bulk", null, "requester", z.object({ uploadId: id }).strict()),
  "electricity.generate": spec(
    "bulk",
    "electricity",
    "requester",
    z.object({ period: month }).strict(),
  ),
  "salaries.generate": spec("bulk", "employees", "none", z.object({ month }).strict()),
  // `requestId` is optional because a scheduled run has no request behind it:
  // the nightly fan-out files an empty payload, and the handler treats the
  // field's absence as "the nightly backup", while a staff request always
  // mints one (see `src/fns/backup.ts`). The request path is unchanged — its
  // payload still carries the request id — so the optionality weakens nothing.
  "company.export": spec(
    "sync",
    null,
    "requester",
    z.object({ requestId: id.optional() }).strict(),
  ),
  "company.restore": spec("sync", null, "platform", z.object({ requestId: id }).strict()),
  "whatsapp.history.sync": spec(
    "sync",
    "whatsapp",
    "none",
    z.object({ connectionId: id }).strict(),
  ),
  "whatsapp.avatars.sync": spec(
    "sync",
    "whatsapp",
    "none",
    z.object({ connectionId: id }).strict(),
  ),
  "gmail.sync": spec("sync", "inbox", "none", z.object({ connectionId: id }).strict()),
  "payment.reconcile": spec("sync", "online_payments", "none", noFields),
  // Settlement records money already taken at the gateway, so neither
  // suspension nor a switched-off section may skip it (owner decision 2026-11-27).
  "payment.settle": spec("inbound", null, "none", z.object({ paymentRequestId: id }).strict()),
  "webhook.process": spec("inbound", null, "none", z.object({ webhookEventId: id }).strict()),
  "overdue.evaluate": spec("sync", "invoices", "none", onDay),
  "overdue.remind": spec("sync", "invoices", "none", onDay),
  "contract.expiry": spec("sync", "contracts", "none", onDay),
  "notification.drain": spec("sync", null, "none", onDay),
  "log.retention": spec("sync", null, "none", onDay),
  "usage.rebuild": spec("sync", null, "none", onDay),
  "subscription.remind": spec(
    "cron",
    null,
    "none",
    z.object({ renewalDate: day, offsetDays: z.number().int() }).strict(),
  ),
  // Money events, emitted from SQL with enqueue_job in the same transaction (FR-018).
  //
  // Three of them carry the id of the row their SQL function wrote
  // (`closeoutId`, `operationalEventId`) alongside the entity id (GR-005): the
  // handler must load THAT row, not "the latest one for this entity" — in a
  // close → restore → close sequence a late first event would otherwise
  // resolve to the second close-out and its notice is lost. The ids are
  // required, not optional: the SQL emitter (migration 313) and the handlers
  // ship together on this branch and nothing on `main` can have queued a job
  // under the old shape, so no queued row ever needs the fallback parse.
  "payment.succeeded": spec("notify", "payments", "none", z.object({ paymentId: id }).strict()),
  "payment.reversed": spec("notify", "payments", "none", z.object({ paymentId: id }).strict()),
  "deposit.confirmed": spec("notify", "deposits", "none", z.object({ depositId: id }).strict()),
  "refund.recorded": spec("notify", "payments", "none", z.object({ refundId: id }).strict()),
  "invoice.written_off": spec(
    "notify",
    "invoices",
    "none",
    z.object({ invoiceId: id, operationalEventId: id }).strict(),
  ),
  "invoice.disputed": spec("notify", "invoices", "none", z.object({ invoiceId: id }).strict()),
  "contract.closed_out": spec(
    "notify",
    "contracts",
    "none",
    z.object({ contractId: id, closeoutId: id }).strict(),
  ),
  "contract.restored": spec(
    "notify",
    "contracts",
    "none",
    z.object({ contractId: id, operationalEventId: id }).strict(),
  ),
} as const;

export type JobKind = keyof typeof JOB_CATALOG;
export type JobPayload<K extends JobKind> = z.infer<(typeof JOB_CATALOG)[K]["payload"]>;

/**
 * يبني مفتاح منع التكرار لمهمة إرسال إشعار واحد.
 *
 * The key carries the notification id, so the same row can never be handed to
 * the notify worker twice. It lives here rather than in each sender because
 * two hand-written copies of one string are two chances to drift apart, and a
 * drifted key would let the same row be enqueued twice.
 */
export function notificationDispatchDedupeKey(notificationId: string): string {
  return `notification.dispatch:${notificationId}`;
}
