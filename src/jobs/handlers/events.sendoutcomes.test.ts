import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/company/requestCompany.server", async () =>
  (await import("./idempotency.testkit")).requestCompanyModule(),
);
vi.mock("@/company/companyClient.server", async () =>
  (await import("./events.testkit")).companyClientModuleWithSendFailures(),
);

import { PAYMENT_SUCCEEDED_WORKFLOW } from "@/jobs/catalog";

import { enqueuedJobCalls, resetDatabase, COMPANY_ID } from "./idempotency.testkit";
import {
  contextFor,
  injectedFailures,
  resetInjectedFailures,
  seedAlreadyNotified,
  seedCloseOut,
  seedCloseOutSettlementPayment,
  seedDeposit,
  seedDisputedInvoice,
  seedPayment,
  seedRefund,
  seedRestoredContract,
  seedRow,
  seedWrittenOffInvoice,
  sentMarkers,
  CONTRACT_ID,
  CLOSEOUT_ID,
  DEPOSIT_ID,
  DISPUTED_INVOICE_ID,
  PAYMENT_ID,
  REFUND_ID,
  RESTORE_EVENT_ID,
  WRITE_OFF_EVENT_ID,
  WRITE_OFF_INVOICE_ID,
} from "./events.testkit";
import { eventHandlers, type MoneyEventKind } from "./events";

/** يصفّر العدّة ويقطع أعطال الحقن قبل كل اختبار. */
beforeEach(() => {
  resetDatabase();
  resetInjectedFailures();
});

/**
 * سيناريو فشل إرسال: المُرسِل يفشل عند الحدود، والمعالج يجب أن يرمي.
 *
 * `payment.succeeded`'s sender swallows the failure as `{ ok: false }`; the four
 * money-moved senders swallow theirs as a `sendFailureReason` skip; the two
 * throw their own. All seven must end with the job failing and retrying
 * (GR-002) — never a returned "succeeded" run.
 */
interface SendFailureScenario {
  kind: MoneyEventKind;
  expectation: string;
  payload: Record<string, string>;
  seed: (companyId: string) => Promise<void>;
  breakSend: keyof typeof injectedFailures;
}

const sendFailureScenarios: SendFailureScenario[] = [
  {
    kind: "payment.succeeded",
    expectation: "a sender-reported ok:false is thrown so the job retries",
    payload: { paymentId: PAYMENT_ID },
    seed: seedPayment,
    breakSend: "enqueueJob",
  },
  {
    kind: "deposit.confirmed",
    expectation: "a send failure the sender throws still fails the job",
    payload: { depositId: DEPOSIT_ID },
    seed: (companyId) => seedDeposit(companyId, "confirmed"),
    breakSend: "notificationInsert",
  },
  {
    kind: "refund.recorded",
    expectation: "a send failure the sender throws still fails the job",
    payload: { refundId: REFUND_ID },
    seed: seedRefund,
    breakSend: "notificationInsert",
  },
  {
    kind: "invoice.written_off",
    expectation: "a sendFailureReason skip is thrown so the job retries",
    payload: { invoiceId: WRITE_OFF_INVOICE_ID, operationalEventId: WRITE_OFF_EVENT_ID },
    seed: seedWrittenOffInvoice,
    breakSend: "notificationInsert",
  },
  {
    kind: "invoice.disputed",
    expectation: "a sendFailureReason skip is thrown so the job retries",
    payload: { invoiceId: DISPUTED_INVOICE_ID },
    seed: seedDisputedInvoice,
    breakSend: "notificationInsert",
  },
  {
    kind: "contract.closed_out",
    expectation: "a sendFailureReason skip is thrown so the job retries",
    payload: { contractId: CONTRACT_ID, closeoutId: CLOSEOUT_ID },
    seed: seedCloseOut,
    breakSend: "notificationInsert",
  },
  {
    kind: "contract.restored",
    expectation: "a sendFailureReason skip is thrown so the job retries",
    payload: { contractId: CONTRACT_ID, operationalEventId: RESTORE_EVENT_ID },
    seed: seedRestoredContract,
    breakSend: "notificationInsert",
  },
];

describe("a failed send fails the job (GR-002)", () => {
  test.each(sendFailureScenarios)("$kind: $expectation", async (scenario) => {
    await scenario.seed(COMPANY_ID);
    injectedFailures[scenario.breakSend] = true;

    // الرسالة هي علامة الحقن: الخطأ يجب أن يكون فشل الإرسال نفسه، لا خطأ
    // fixture آخر صادف الطريق.
    await expect(eventHandlers[scenario.kind](contextFor(scenario))).rejects.toThrow(/injected/);

    // فشل الإرسال لا يترك إرسالاً نصف مكتمل يُحسب نجاحاً.
    expect(sentMarkers()).toEqual([]);
  });
});

/**
 * سيناريو تخطٍّ مقصود: المُرسِل لا يجد ما يفعله، والمعالج يعود بلا خطأ.
 */
interface DeliberateSkipScenario {
  kind: MoneyEventKind;
  expectation: string;
  payload: Record<string, string>;
  seed: (companyId: string) => Promise<void>;
}

const deliberateSkipScenarios: DeliberateSkipScenario[] = [
  {
    kind: "payment.succeeded",
    expectation: "a paused workflow returns its skip without sending",
    payload: { paymentId: PAYMENT_ID },
    seed: async (companyId) => {
      await seedPayment(companyId);
      await seedRow("cron_jobs", { key: PAYMENT_SUCCEEDED_WORKFLOW, is_active: false });
    },
  },
  {
    kind: "payment.reversed",
    expectation: "the documented no-sender skip returns normally",
    payload: { paymentId: PAYMENT_ID },
    seed: seedPayment,
  },
  {
    kind: "deposit.confirmed",
    expectation: "a deposit that is not confirmed is a deliberate skip",
    payload: { depositId: DEPOSIT_ID },
    seed: (companyId) => seedDeposit(companyId, "pending"),
  },
  {
    kind: "refund.recorded",
    expectation: "an already-notified refund is a deliberate skip",
    payload: { refundId: REFUND_ID },
    seed: async (companyId) => {
      await seedRefund(companyId);
      await seedAlreadyNotified("refund_recorded", { refund_id: REFUND_ID });
    },
  },
  {
    kind: "invoice.written_off",
    expectation: "an already-notified invoice is a deliberate skip",
    payload: { invoiceId: WRITE_OFF_INVOICE_ID, operationalEventId: WRITE_OFF_EVENT_ID },
    seed: async (companyId) => {
      await seedWrittenOffInvoice(companyId);
      await seedAlreadyNotified("invoice_written_off", { invoice_id: WRITE_OFF_INVOICE_ID });
    },
  },
  {
    kind: "invoice.disputed",
    expectation: "an already-notified invoice is a deliberate skip",
    payload: { invoiceId: DISPUTED_INVOICE_ID },
    seed: async (companyId) => {
      await seedDisputedInvoice(companyId);
      await seedAlreadyNotified("invoice_disputed", { invoice_id: DISPUTED_INVOICE_ID });
    },
  },
  {
    kind: "contract.closed_out",
    expectation: "an already-notified close-out is a deliberate skip",
    payload: { contractId: CONTRACT_ID, closeoutId: CLOSEOUT_ID },
    seed: async (companyId) => {
      await seedCloseOut(companyId);
      await seedAlreadyNotified("contract_closeout", { closeout_id: CLOSEOUT_ID });
    },
  },
  {
    kind: "contract.restored",
    expectation: "an already-notified restore is a deliberate skip",
    payload: { contractId: CONTRACT_ID, operationalEventId: RESTORE_EVENT_ID },
    seed: async (companyId) => {
      await seedRestoredContract(companyId);
      await seedAlreadyNotified("contract_restored", {
        contract_id: CONTRACT_ID,
        reason: "tenant returning",
      });
    },
  },
];

describe("a deliberate skip completes the job (GR-002)", () => {
  test.each(deliberateSkipScenarios)("$kind: $expectation", async (scenario) => {
    await scenario.seed(COMPANY_ID);
    const markers = sentMarkers();

    await expect(eventHandlers[scenario.kind](contextFor(scenario))).resolves.toBeDefined();

    expect(sentMarkers()).toEqual(markers);
  });
});

describe("a close-out settlement payment (GR-004)", () => {
  test("payment.succeeded sends no renter receipt — the preserved behaviour", async () => {
    await seedCloseOutSettlementPayment(COMPANY_ID);
    const markers = sentMarkers();

    const result = await eventHandlers["payment.succeeded"](
      contextFor({ payload: { paymentId: PAYMENT_ID } }),
    );

    // الإيداع هو الذي سوّى الفواتير، وإشعار الإغلاق يذهب عبر
    // `contract.closed_out` — لا إيصال "وصلت دفعة" لمستأجر لم يدفع شيئاً.
    expect(result).toMatchObject({ paymentId: PAYMENT_ID, skipped: true });
    expect(sentMarkers()).toEqual(markers);
    expect(enqueuedJobCalls().filter((call) => call._kind === "payment.receipt")).toEqual([]);
  });
});
