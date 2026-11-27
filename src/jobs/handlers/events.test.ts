import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/company/requestCompany.server", async () =>
  (await import("./idempotency.testkit")).requestCompanyModule(),
);
vi.mock("@/company/companyClient.server", async () =>
  (await import("./events.testkit")).companyClientModuleWithSendFailures(),
);

import { JOB_CATALOG } from "@/jobs/catalog";

import { enqueuedJobCalls, resetDatabase, rowsOf, COMPANY_ID } from "./idempotency.testkit";
import {
  contextFor,
  resetInjectedFailures,
  seedCloseOut,
  seedDeposit,
  seedDisputedInvoice,
  seedPayment,
  seedRefund,
  seedRestoredContract,
  seedWrittenOffInvoice,
  sentMarkers,
  CLOSEOUT_ID,
  CONTRACT_ID,
  DEPOSIT_ID,
  DISPUTED_INVOICE_ID,
  OTHER_COMPANY_ID,
  PAYMENT_ID,
  REFUND_ID,
  WRITE_OFF_INVOICE_ID,
} from "./events.testkit";
import { MONEY_EVENT_KINDS, eventHandlers, type MoneyEventKind } from "./events";

/** يصفّر العدّة ويقطع أعطال الحقن قبل كل اختبار. */
beforeEach(() => {
  resetDatabase();
  resetInjectedFailures();
});

/** سيناريو حدث مال واحد: حمولته، وكياناته المزروعة، وعلامة إرساله الصحيحة. */
interface MoneyScenario {
  kind: MoneyEventKind;
  /** ما يثبت أن المرسِل الصحيح استُدعى مرة واحدة بالكيان المحمَّل. */
  expectation: string;
  payload: Record<string, string>;
  seed: (companyId: string) => Promise<void>;
  expectSentOnce: (result: unknown) => void;
}

const scenarios: MoneyScenario[] = [
  {
    kind: "payment.succeeded",
    expectation: "queues one receipt job with the loaded payment under the workflow key",
    payload: { paymentId: PAYMENT_ID },
    seed: seedPayment,
    expectSentOnce: () => {
      // المرسِل هنا هو حاجز الإيصالات: يطلب مهمة `payment.receipt` واحدة، لا صف إشعار.
      expect(rowsOf("notifications")).toEqual([]);
      const receipts = enqueuedJobCalls().filter((call) => call._kind === "payment.receipt");
      expect(receipts.length).toBeGreaterThan(0);
      // الصندوق يطوي كل طلب متكرر بنفس مفتاح المنع على المهمة الموجودة، فالطلب
      // الفعلي واحد مهما تكرر — وهذا هو ما يجعل إعادة التنفيذ بلا إرسال ثانٍ.
      expect(new Set(receipts.map((call) => String(call._dedupe_key)))).toEqual(
        new Set([`payment.receipt:${PAYMENT_ID}`]),
      );
      for (const call of receipts) {
        expect(call).toMatchObject({
          _payload: { paymentId: PAYMENT_ID, workflow: "payment-succeeded" },
          _dedupe_key: `payment.receipt:${PAYMENT_ID}`,
        });
      }
    },
  },
  {
    kind: "payment.reversed",
    expectation: "validates the payment and sends nothing — there is no sender for a reversal",
    payload: { paymentId: PAYMENT_ID },
    seed: seedPayment,
    expectSentOnce: (result) => {
      // لا يوجد مُرسِل لعكس الدفعة إطلاقاً: "لا وجود لإشعار بعكس إيصال" — والنتيجة
      // تقول ذلك بدل أن تتظاهر بالإرسال.
      expect(result).toMatchObject({ paymentId: PAYMENT_ID, skipped: true });
      expect(sentMarkers()).toEqual([]);
    },
  },
  {
    kind: "deposit.confirmed",
    expectation: "sends one deposit_confirmation with the loaded deposit",
    payload: { depositId: DEPOSIT_ID },
    seed: (companyId) => seedDeposit(companyId, "confirmed"),
    expectSentOnce: () => {
      const rows = rowsOf("notifications");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "deposit_confirmation",
        payload: { deposit_id: DEPOSIT_ID, amount: "25 KWD" },
      });
    },
  },
  {
    kind: "refund.recorded",
    expectation: "sends one refund_recorded with the loaded refund",
    payload: { refundId: REFUND_ID },
    seed: seedRefund,
    expectSentOnce: () => {
      const rows = rowsOf("notifications");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "refund_recorded",
        payload: { refund_id: REFUND_ID },
      });
      // مبلغ الكيان المحمَّل هو ما يظهر في نص الرسالة.
      expect(String(rows[0].body)).toContain("50 KWD");
    },
  },
  {
    kind: "invoice.written_off",
    expectation: "sends one invoice_written_off carrying the reason from the operational event",
    payload: { invoiceId: WRITE_OFF_INVOICE_ID },
    seed: seedWrittenOffInvoice,
    expectSentOnce: () => {
      const rows = rowsOf("notifications");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "invoice_written_off",
        payload: { invoice_id: WRITE_OFF_INVOICE_ID },
      });
      // سبب الشطب المحمَّل من الحدث التشغيلي هو ما وصل إلى نص الرسالة.
      expect(String(rows[0].body)).toContain("broken meter");
    },
  },
  {
    kind: "invoice.disputed",
    expectation: "sends one invoice_disputed with the loaded invoice",
    payload: { invoiceId: DISPUTED_INVOICE_ID },
    seed: seedDisputedInvoice,
    expectSentOnce: () => {
      const rows = rowsOf("notifications");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "invoice_disputed",
        payload: { invoice_id: DISPUTED_INVOICE_ID },
      });
      expect(String(rows[0].body)).toContain("over charged");
    },
  },
  {
    kind: "contract.closed_out",
    expectation: "sends one contract_closeout with the close-out loaded for the contract",
    payload: { contractId: CONTRACT_ID },
    seed: seedCloseOut,
    expectSentOnce: () => {
      const rows = rowsOf("notifications");
      expect(rows).toHaveLength(1);
      // معرّف الإغلاق هو ما حمّله المعالج من أجل العقد — الكيان المحمَّل.
      expect(rows[0]).toMatchObject({
        type: "contract_closeout",
        payload: { closeout_id: CLOSEOUT_ID, contract_id: CONTRACT_ID },
      });
    },
  },
  {
    kind: "contract.restored",
    expectation: "sends one contract_restored with the state and reason of the restore event",
    payload: { contractId: CONTRACT_ID },
    seed: seedRestoredContract,
    expectSentOnce: () => {
      const rows = rowsOf("notifications");
      expect(rows).toHaveLength(1);
      // الحالة والسبب حُمِّلا من صف الحدث التشغيلي للاستعادة.
      expect(rows[0]).toMatchObject({
        type: "contract_restored",
        payload: { contract_id: CONTRACT_ID, target_state: "active", reason: "tenant returning" },
      });
    },
  },
];

describe("money event handlers", () => {
  test("the map covers exactly the eight money event kinds", () => {
    expect(Object.keys(eventHandlers).sort()).toEqual([...MONEY_EVENT_KINDS].sort());
  });

  test.each(scenarios)("$kind: $expectation", async (scenario) => {
    // الحمولة كما يقرّها الكتالوج الصارم — المعاملات المحقّقة مسبقاً تحمل هذا الشكل.
    expect(JOB_CATALOG[scenario.kind].payload.safeParse(scenario.payload).success).toBe(true);
    await scenario.seed(COMPANY_ID);

    const result = await eventHandlers[scenario.kind](contextFor(scenario));

    scenario.expectSentOnce(result);
  });

  test.each(scenarios)(
    "$kind: a second run of the same jobRequestId sends nothing",
    async (scenario) => {
      await scenario.seed(COMPANY_ID);
      const ctx = contextFor(scenario);
      await eventHandlers[scenario.kind](ctx);
      const markers = sentMarkers();

      const second = await eventHandlers[scenario.kind](ctx);

      // لا صف إشعار جديد ولا طلب عمل جديد — الإرسال ما زال واحداً بالضبط.
      expect(sentMarkers()).toEqual(markers);
      scenario.expectSentOnce(second);
    },
  );

  test.each(scenarios)(
    "$kind: a payload for another company's id finds nothing and fails without sending",
    async (scenario) => {
      await scenario.seed(OTHER_COMPANY_ID);

      await expect(eventHandlers[scenario.kind](contextFor(scenario))).rejects.toThrow(/not found/);

      expect(sentMarkers()).toEqual([]);
    },
  );
});
