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
  "company.export": spec("sync", null, "requester", z.object({ requestId: id }).strict()),
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
  "payment.succeeded": spec("notify", "payments", "none", z.object({ paymentId: id }).strict()),
  "payment.reversed": spec("notify", "payments", "none", z.object({ paymentId: id }).strict()),
  "deposit.confirmed": spec("notify", "deposits", "none", z.object({ depositId: id }).strict()),
  "refund.recorded": spec("notify", "payments", "none", z.object({ refundId: id }).strict()),
  "invoice.written_off": spec("notify", "invoices", "none", z.object({ invoiceId: id }).strict()),
  "invoice.disputed": spec("notify", "invoices", "none", z.object({ invoiceId: id }).strict()),
  "contract.closed_out": spec("notify", "contracts", "none", z.object({ contractId: id }).strict()),
  "contract.restored": spec("notify", "contracts", "none", z.object({ contractId: id }).strict()),
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
