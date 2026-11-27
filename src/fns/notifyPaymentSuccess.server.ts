import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { paymentNotifyOutcome, type PaymentNotifyResult } from "@/fns/paymentNotifyResult";
import { runEventWorkflow } from "@/fns/workflowRegistry";
import {
  MANUAL_PAYMENT_INVOICE_WORKFLOW,
  PAYMENT_SUCCEEDED_WORKFLOW,
  type PaymentReceiptWorkflow,
} from "@/jobs/catalog";
import { enqueueJob } from "@/jobs/enqueue";

/**
 * خيارات حجز إيصالات الدفع.
 */
export interface PaymentReceiptQueueOptions {
  /**
   * يمنع حجز الإيصال لنفس الدفعة مرتين.
   *
   * The money path sets it: a gateway webhook and a reconciliation run can
   * reach the same payment, and the receipt must go out once. A manual button
   * leaves it off — an admin re-sending a receipt on purpose must not be
   * stopped by a key left over from an earlier send.
   */
  dedupe?: boolean;
  /**
   * سير العمل الذي أنشأ الإيصال: هو من يحمل مستلمي الإشعار إلى العامل.
   *
   * The recipients of a receipt belong to the workflow, not to the payment:
   * the manual settlement may be aimed at staff only, the card payment at
   * staff and tenant. The key travels in the payload so the worker judges the
   * receipt by the workflow the request actually ran.
   */
  workflow: PaymentReceiptWorkflow;
}

/**
 * يحجز مهمة إيصال لكل دفعة، ويجمع معرّفات الصفوف التي حجزها.
 *
 * `ids` in the returned result are the `job_requests` rows, not notification
 * rows: the receipt is rendered and delivered by the worker, so the request
 * can only say that the work was queued.
 */
async function queuePaymentReceipts(
  paymentIds: string[],
  options: PaymentReceiptQueueOptions,
): Promise<PaymentNotifyResult> {
  const uniqueIds = [...new Set(paymentIds.filter(Boolean))];
  if (!uniqueIds.length) {
    return { ok: false as const, nothingToDo: true as const, error: "No payment ids." };
  }

  try {
    const db = companyClient(requireRequestCompany().id);
    const jobRequestIds: string[] = [];
    for (const paymentId of uniqueIds) {
      const { jobId } = await enqueueJob(
        db,
        "payment.receipt",
        { paymentId, workflow: options.workflow },
        options.dedupe ? { dedupeKey: `payment.receipt:${paymentId}` } : {},
      );
      jobRequestIds.push(jobId);
    }
    return { ok: true as const, skipped: false, ids: jobRequestIds };
  } catch (error) {
    // This sender never throws — it reports `{ ok: false, error }` so a
    // notification failure can never break the payment path — and two of
    // those returns mean "nothing to send", not "broke".
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "notifyPaymentSuccess failed",
    };
  }
}

/**
 * يشغّل سير عمل «نجاح الدفعة» ليُرسل إيصال الدفعة إلى الإدارة والمستأجر.
 *
 * The workflow switch is honoured here, in the request, and the receipt itself
 * is left to the worker: one `payment.receipt` job per payment, rendered and
 * delivered there (contracts/jobs.md section 1). The workflow key rides in the
 * payload so the worker applies this workflow's own recipients.
 *
 * `outcomeOf` is load-bearing here. This sender never throws — it catches and
 * returns `{ ok: false, error }` so a notification failure can never break the
 * payment path — and two of those returns mean "nothing to send", not "broke".
 * Recording a declined card as an error would leave a permanent red Failed
 * badge on the tab built to monitor these.
 */
export async function notifyPaymentSuccess(
  paymentIds: string[],
  options: Omit<PaymentReceiptQueueOptions, "workflow"> = {},
): Promise<PaymentNotifyResult> {
  return runEventWorkflow<PaymentNotifyResult>({
    key: PAYMENT_SUCCEEDED_WORKFLOW,
    whenPaused: () => ({ ok: true as const, skipped: true, ids: [] }),
    run: () =>
      queuePaymentReceipts(paymentIds, {
        dedupe: options.dedupe ?? true,
        workflow: PAYMENT_SUCCEEDED_WORKFLOW,
      }),
    outcomeOf: paymentNotifyOutcome,
  });
}

/**
 * يشغّل سير عمل «سداد يدوي لفاتورة» بنفس حجز الإيصالات ومفتاح تحكّم مستقل.
 *
 * Ticking an invoice paid on /admin/invoices records a cash payment for the
 * remaining balance, and that is a real receipt the tenant is entitled to — the
 * money changed hands at the office rather than through the gateway. It rides
 * the same builder as {@link notifyPaymentSuccess}, so a manually settled
 * invoice produces a receipt identical to a card payment's.
 *
 * It is a separate registry key rather than a second call to
 * `payment-succeeded` because the two need independent switches: this one is an
 * admin reconciling the ledger, so an admin correcting a mistake must be able
 * to aim it at staff only — or silence it entirely — without also stopping the
 * receipt a tenant gets for a card payment they made themselves.
 *
 * Reverting an invoice to unpaid deliberately sends nothing. It deletes the
 * payment it created, and "your payment was un-received" is not a message any
 * tenant should get from an admin fixing a typo.
 */
export async function notifyManualPaymentInvoice(
  paymentIds: string[],
): Promise<PaymentNotifyResult> {
  return runEventWorkflow<PaymentNotifyResult>({
    key: MANUAL_PAYMENT_INVOICE_WORKFLOW,
    whenPaused: () => ({ ok: true as const, skipped: true, ids: [] }),
    run: () =>
      queuePaymentReceipts(paymentIds, {
        dedupe: false,
        workflow: MANUAL_PAYMENT_INVOICE_WORKFLOW,
      }),
    outcomeOf: paymentNotifyOutcome,
  });
}
