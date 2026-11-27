import { companyClient } from "@/company/companyClient.server";
import { runWithRequestCompany } from "@/company/requestCompany.server";
import { notifyContractCloseoutRecord } from "@/fns/notifyContractCloseout";
import { notifyContractRestoredRecord } from "@/fns/notifyContractRestored";
import { notifyDepositConfirmedRecord } from "@/fns/notifyDepositConfirmed";
import { notifyInvoiceDisputedRecord } from "@/fns/notifyInvoiceDisputed";
import { notifyInvoiceWrittenOffRecord } from "@/fns/notifyInvoiceWrittenOff";
import { notifyPaymentSuccess } from "@/fns/notifyPaymentSuccess";
import { notifyRefundRecordedRecord } from "@/fns/notifyRefundRecorded";
import type { PaymentNotifyResult } from "@/fns/paymentNotifyResult";
import type { JobPayload } from "@/jobs/catalog";
import type { JobHandler, JobHandlerContext } from "@/worker/runJob";

/**
 * معالجات أحداث المال: كل حدث يبعثه SQL من صندوق المخرجات إلى مُرسِله القائم.
 *
 * The money mutations commit their change and `enqueue_job` in one transaction
 * (migrations 308–313, FR-018); the relay delivers the row and these handlers
 * run the send that the request used to run inline. Each handler only loads
 * what its sender needs in company scope and calls that sender untouched — the
 * senders own their wording, their pause switches and their idempotency, so a
 * second delivery of the same job sends nothing (contracts/jobs.md section 3).
 *
 * Every load filters on `company_id` explicitly even though `companyClient` is
 * already company-scoped: a payload naming another company's id must fail the
 * job loudly instead of leaning on RLS to hide the row.
 */

/**
 * أنواع أحداث المال الثمانية كما تضعها دوال SQL في صندوق المخرجات.
 *
 * contracts/jobs.md section 5. Kept as data so the map below can be asserted
 * against it — a ninth event added to one place fails the test that demands the
 * other.
 */
export const MONEY_EVENT_KINDS = [
  "payment.succeeded",
  "payment.reversed",
  "deposit.confirmed",
  "refund.recorded",
  "invoice.written_off",
  "invoice.disputed",
  "contract.closed_out",
  "contract.restored",
] as const;

/** نوع حدث المال كما يظهر في الكتالوج. */
export type MoneyEventKind = (typeof MONEY_EVENT_KINDS)[number];

/**
 * يحمّل صف كيان مالي مملوك للشركة، أو يرمي إن لم يوجد صف بهذا المعرّف فيها.
 *
 * A missing row is a caller bug — a job that names an id the company does not
 * own fails instead of quietly sending nothing — so the error names the entity
 * and the id the payload carried.
 */
async function requireOwnedRow<T>(
  query: PromiseLike<{ data: T; error: { message: string } | null }>,
  entity: string,
  id: string,
): Promise<NonNullable<T>> {
  const { data, error } = await query;
  if (error) throw new Error(`${entity}: ${error.message}`);
  if (!data) throw new Error(`${entity} not found for company: ${id}`);
  return data;
}

/**
 * ينفّذ استدعاء المُرسِل داخل سياق شركة المهمة.
 *
 * The senders reach for the request company (templates, tenant names, the
 * recipient registry) and a background job has no request — the same wrapping
 * the notification dispatch handler uses.
 */
function inCompany<T>(companyId: string, send: () => Promise<T>): Promise<T> {
  return runWithRequestCompany({ id: companyId, slug: "", status: "active", host: "" }, send);
}

/**
 * التخطّيات المقصودة التي لا تمثّل فشلاً في نتيجة المُرسِل الإداري.
 *
 * These are the senders' own documented no-op returns (adminEmailNotification
 * and notifyDepositConfirmed): a state that made the send meaningless, a
 * misconfiguration an admin must see on the workflow run, or a template that
 * switched the channel off. Anything else the senders report under `skipped`
 * is their `sendFailureReason` catch muffling a real send error — and in the
 * job path that error must fail the job, not pass for a completed run.
 */
const DELIBERATE_SKIP_REASONS = [
  "Deposit is not confirmed.",
  "No admin email recipients configured.",
] as const;

/** نهاية سبب التخطّي الذي يكتبه المُرسِل حين يمنع قالب القناة الإرسال. */
const TEMPLATE_CHANNEL_SKIP_SUFFIX = " excludes the email channel.";

/** نتيجة مُرسِل إداري كما تصل المعالج: إرسال، أو تخطٍّ بسببه. */
interface SenderSkipResult {
  skipped: boolean;
  reason?: string;
  benign?: true;
}

/**
 * يكشف نتيجة آلية الإيصالات المصنَّفة إلى نجاح/لا شيء/فشل.
 *
 * `PaymentNotifyResult` is the one sender result carrying `ok`; the admin
 * senders carry `skipped` instead, and the two shapes are told apart by their
 * own keys rather than by an instanceof the fakes would have to forge.
 */
function isPaymentNotifyResult(result: unknown): result is PaymentNotifyResult {
  return typeof result === "object" && result !== null && "ok" in result;
}

/**
 * يكشف نتيجة المُرسِل الإداري: إرسال ناجح أو تخطٍّ مذكور السبب.
 */
function isSenderSkipResult(result: unknown): result is SenderSkipResult {
  return typeof result === "object" && result !== null && "skipped" in result;
}

/**
 * يميّز التخطّي المقصود عن فشل إرسال أخفاه المُرسِل في سبب تخطٍّ.
 *
 * Deliberate: benign ("Already notified.", "Workflow is paused."), the two
 * state/misconfiguration reasons above, and the channel gate's reason. A
 * `sendFailureReason` catch returns an arbitrary error message under the same
 * shape — that one is a failure, not a skip.
 */
function isDeliberateSkip(result: SenderSkipResult): boolean {
  if (result.benign) return true;
  const reason = result.reason ?? "";
  return (
    (DELIBERATE_SKIP_REASONS as readonly string[]).includes(reason) ||
    reason.endsWith(TEMPLATE_CHANNEL_SKIP_SUFFIX)
  );
}

/**
 * يرمي خطأً حين تكون نتيجة المُرسِل فشل إرسال، لا تخطّياً مقصوداً.
 *
 * `runJob` marks any returned value succeeded (contracts/jobs.md section 3), so
 * a failure a sender reports as a value would end the job "succeeded" and the
 * transient error would never be retried — the audit finding behind this
 * guard. A deliberate skip is a completed run and returns normally.
 */
function assertSendSucceeded(kind: MoneyEventKind, result: unknown): void {
  if (isPaymentNotifyResult(result)) {
    if (!result.ok && !result.nothingToDo) {
      throw new Error(`${kind} send failed: ${result.error}`);
    }
    return;
  }
  if (isSenderSkipResult(result) && result.skipped && !isDeliberateSkip(result)) {
    throw new Error(`${kind} send failed: ${result.reason ?? "the sender reported no reason"}`);
  }
}

/**
 * يكشف أن الدفعة تسوية إغلاق عقد — التي لا يصاحبها إيصال للمستأجر.
 *
 * The close-out writers (migrations 114, 295 and 310) stamp every settlement
 * payment's `reference` with `CLOSEOUT:<contract code>` — the marker lives on
 * the payment row itself. The same payment is also named by
 * `contract_closeouts.result->>'settlement_payment_id'`, but that link needs a
 * second read and the reference is written by every close-out path.
 */
function isCloseOutSettlementPayment(payment: { reference: string | null }): boolean {
  return typeof payment.reference === "string" && payment.reference.startsWith("CLOSEOUT:");
}

/**
 * يعالج حدث `payment.succeeded`: يحجز إيصال الدفعة عبر مُرسِل نجاح الدفعة.
 *
 * The allocation is where a confirmed payment lands on invoices (migration
 * 308), so every allocation owes its receipt — gateway settlement or manual
 * allocation alike. The one exception is the close-out settlement: its payment
 * exists only to settle the deposit against the invoices, the renter paid
 * nothing new, and the close-out itself notifies separately through
 * `contract.closed_out` — so no "payment received" receipt for it (the
 * preserved behaviour, GR-004). The sender queues one `payment.receipt` job
 * per payment under its own dedupe key, so a retry of this job requests no
 * second receipt.
 */
export const paymentSucceededHandler: JobHandler = async (ctx: JobHandlerContext) => {
  const { paymentId } = ctx.payload as JobPayload<"payment.succeeded">;
  const payment = await requireOwnedRow(
    companyClient(ctx.companyId)
      .from("payments")
      .select("*")
      .eq("id", paymentId)
      .eq("company_id", ctx.companyId)
      .maybeSingle(),
    "payment",
    paymentId,
  );
  if (isCloseOutSettlementPayment(payment)) {
    return {
      paymentId: payment.id,
      skipped: true as const,
      reason: "A close-out settlement sends no payment receipt by design.",
    };
  }
  const result = await inCompany(ctx.companyId, () => notifyPaymentSuccess([payment.id]));
  assertSendSucceeded("payment.succeeded", result);
  return result;
};

/**
 * يعالج حدث `payment.reversed`: يتحقق من الدفعة ضمن الشركة ويبعث شيئاً عمداً.
 *
 * There is no sender for this event and there never was one: reversing a
 * payment sends nothing, because "there is no such thing as an un-receipt"
 * (the same decision `setInvoicePaid.ts` documents for the un-pay path). The
 * row is still loaded in company scope so a malformed event fails the job
 * instead of passing silently, and the result says why nothing was sent rather
 * than pretending a send succeeded.
 */
export const paymentReversedHandler: JobHandler = async (ctx: JobHandlerContext) => {
  const { paymentId } = ctx.payload as JobPayload<"payment.reversed">;
  const payment = await requireOwnedRow(
    companyClient(ctx.companyId)
      .from("payments")
      .select("*")
      .eq("id", paymentId)
      .eq("company_id", ctx.companyId)
      .maybeSingle(),
    "payment",
    paymentId,
  );
  return {
    paymentId: payment.id,
    skipped: true as const,
    reason: "payment.reversed has no sender: a reversal sends no message by design.",
  };
};

/**
 * يعالج حدث `deposit.confirmed`: يرسل تنبيه تأكيد الإيداع إلى الإدارة.
 *
 * The deposits trigger enqueues the event on the transition into `confirmed`
 * only (migration 308), and the sender re-checks that state and its own
 * per-deposit idempotency before it writes anything. A failed send is thrown,
 * not returned, so the job retries it (GR-002).
 */
export const depositConfirmedHandler: JobHandler = async (ctx: JobHandlerContext) => {
  const { depositId } = ctx.payload as JobPayload<"deposit.confirmed">;
  const deposit = await requireOwnedRow(
    companyClient(ctx.companyId)
      .from("deposits")
      .select("*")
      .eq("id", depositId)
      .eq("company_id", ctx.companyId)
      .maybeSingle(),
    "deposit",
    depositId,
  );
  const result = await inCompany(ctx.companyId, () => notifyDepositConfirmedRecord(deposit.id));
  assertSendSucceeded("deposit.confirmed", result);
  return result;
};

/**
 * يعالج حدث `refund.recorded`: يرسل تنبيه تسجيل الاسترداد إلى الإدارة.
 *
 * The close-out writes the refunds row and the event in one transaction
 * (migration 310), so the notice can no longer be lost between the money move
 * and the send.
 */
export const refundRecordedHandler: JobHandler = async (ctx: JobHandlerContext) => {
  const { refundId } = ctx.payload as JobPayload<"refund.recorded">;
  const refund = await requireOwnedRow(
    companyClient(ctx.companyId)
      .from("refunds")
      .select("*")
      .eq("id", refundId)
      .eq("company_id", ctx.companyId)
      .maybeSingle(),
    "refund",
    refundId,
  );
  const result = await inCompany(ctx.companyId, () => notifyRefundRecordedRecord(refund.id));
  assertSendSucceeded("refund.recorded", result);
  return result;
};

/**
 * يعالج حدث `invoice.written_off`: يرسل تنبيه الشطب بالسبب الذي كتبه الموظف.
 *
 * The reason lives in the operational event `write_off_invoice` writes beside
 * the state change (migration 309), not on the invoice row — the sender's own
 * input contract says so — so that row is loaded by the id the payload carries
 * (GR-005): in close → restore → close sequences "the latest write-off row"
 * could belong to a different write-off, and this event's notice would carry
 * the wrong reason.
 */
export const invoiceWrittenOffHandler: JobHandler = async (ctx: JobHandlerContext) => {
  const { invoiceId, operationalEventId } = ctx.payload as JobPayload<"invoice.written_off">;
  const db = companyClient(ctx.companyId);
  const invoice = await requireOwnedRow(
    db
      .from("invoices")
      .select("*")
      .eq("id", invoiceId)
      .eq("company_id", ctx.companyId)
      .maybeSingle(),
    "invoice",
    invoiceId,
  );
  const detail = await requireOwnedRow(
    db
      .from("contract_operational_events")
      .select("note")
      .eq("id", operationalEventId)
      .eq("company_id", ctx.companyId)
      .eq("event_type", "invoice_written_off")
      .contains("payload", { invoice_id: invoiceId })
      .maybeSingle(),
    "write-off event",
    operationalEventId,
  );
  const reason = detail.note?.trim();
  if (!reason) throw new Error(`write-off event for invoice ${invoiceId} carries no reason`);
  const result = await inCompany(ctx.companyId, () =>
    notifyInvoiceWrittenOffRecord(invoice.id, reason),
  );
  assertSendSucceeded("invoice.written_off", result);
  return result;
};

/**
 * يعالج حدث `invoice.disputed`: يرسل تنبيه النزاع إلى الإدارة.
 *
 * The dispute reason is read from the invoice itself by the sender, so the
 * handler only has to prove the invoice belongs to the company.
 */
export const invoiceDisputedHandler: JobHandler = async (ctx: JobHandlerContext) => {
  const { invoiceId } = ctx.payload as JobPayload<"invoice.disputed">;
  const invoice = await requireOwnedRow(
    companyClient(ctx.companyId)
      .from("invoices")
      .select("*")
      .eq("id", invoiceId)
      .eq("company_id", ctx.companyId)
      .maybeSingle(),
    "invoice",
    invoiceId,
  );
  const result = await inCompany(ctx.companyId, () => notifyInvoiceDisputedRecord(invoice.id));
  assertSendSucceeded("invoice.disputed", result);
  return result;
};

/**
 * يعالج حدث `contract.closed_out`: يرسل تنبيه إتمام التصفية إلى الإدارة.
 *
 * The sender deduplicates on the close-out itself — a contract that is
 * restored and closed out again is owed a second notice — so the handler loads
 * the close-out row the event's own payload names (GR-005): in a
 * close → restore → close sequence "the latest close-out" is the second one,
 * and a late first event would send the second close-out's notice twice while
 * the first is never told.
 */
export const contractClosedOutHandler: JobHandler = async (ctx: JobHandlerContext) => {
  const { contractId, closeoutId } = ctx.payload as JobPayload<"contract.closed_out">;
  const closeout = await requireOwnedRow(
    companyClient(ctx.companyId)
      .from("contract_closeouts")
      .select("*")
      .eq("id", closeoutId)
      .eq("contract_id", contractId)
      .eq("company_id", ctx.companyId)
      .maybeSingle(),
    "close-out",
    closeoutId,
  );
  const result = await inCompany(ctx.companyId, () => notifyContractCloseoutRecord(closeout.id));
  assertSendSucceeded("contract.closed_out", result);
  return result;
};

/**
 * يعالج حدث `contract.restored`: يرسل تنبيه الاستعادة بالحالة والسبب.
 *
 * The sender's message names the state the contract was restored to and why —
 * both written to the operational event `restore_contract` records in the same
 * transaction (migration 310). That row is what travels to the sender, loaded
 * by the id the event's own payload carries (GR-005): a contract restored
 * twice has two `restored` rows, and "the latest" would answer the late first
 * event with the second restore's state and reason.
 */
export const contractRestoredHandler: JobHandler = async (ctx: JobHandlerContext) => {
  const { contractId, operationalEventId } = ctx.payload as JobPayload<"contract.restored">;
  const db = companyClient(ctx.companyId);
  const contract = await requireOwnedRow(
    db
      .from("contracts")
      .select("*")
      .eq("id", contractId)
      .eq("company_id", ctx.companyId)
      .maybeSingle(),
    "contract",
    contractId,
  );
  const detail = await requireOwnedRow(
    db
      .from("contract_operational_events")
      .select("note, payload")
      .eq("id", operationalEventId)
      .eq("company_id", ctx.companyId)
      .eq("event_type", "restored")
      .eq("contract_id", contractId)
      .maybeSingle(),
    "restore event",
    operationalEventId,
  );
  const targetState = (detail.payload as { contract_state?: string } | null)?.contract_state;
  const reason = detail.note?.trim();
  if (!targetState || !reason) {
    throw new Error(`restore event for contract ${contractId} carries no state or reason`);
  }
  const result = await inCompany(ctx.companyId, () =>
    notifyContractRestoredRecord(contract.id, targetState, reason),
  );
  assertSendSucceeded("contract.restored", result);
  return result;
};

/**
 * سجلّ معالجات أحداث المال: نوع الحدث إلى معالجه.
 *
 * The worker registry spreads this map in; a kind missing here is a permanent
 * `no handler for <kind>` failure in `runJob`, never a silent no-op.
 */
export const eventHandlers: Record<MoneyEventKind, JobHandler> = {
  "payment.succeeded": paymentSucceededHandler,
  "payment.reversed": paymentReversedHandler,
  "deposit.confirmed": depositConfirmedHandler,
  "refund.recorded": refundRecordedHandler,
  "invoice.written_off": invoiceWrittenOffHandler,
  "invoice.disputed": invoiceDisputedHandler,
  "contract.closed_out": contractClosedOutHandler,
  "contract.restored": contractRestoredHandler,
};
