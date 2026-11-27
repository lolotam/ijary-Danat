import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/company/requestCompany.server", async () =>
  (await import("./documentsPayment.testkit")).requestCompanyModule(),
);
vi.mock("@/company/companyClient.server", async () =>
  (await import("./documentsPayment.testkit")).companyClientModule(),
);
vi.mock("@/lib/paymentReceiptPdf", async () =>
  (await import("./documentsPayment.testkit")).paymentReceiptPdfModule(),
);
vi.mock("@/fns/enqueueNotification", async () =>
  (await import("./documentsPayment.testkit")).enqueueNotificationModule(),
);

import {
  PAYMENT_ID,
  confirmedPayment,
  enqueue,
  maybeSingle,
  notificationsContains,
  renderReceipts,
  resetPaymentNotifyMocks,
  rpc,
  tenantRow,
  TEST_COMPANY_ID,
} from "./documentsPayment.testkit";

const { createPaymentReceiptHandler } = await import("./documentsPayment");

beforeEach(resetPaymentNotifyMocks);

/** ما يرسله العامل إلى المعالج: الحمولة محقّقة مسبقاً بمخطط الكتالوج. */
function jobContext(payload: { paymentId?: string; workflow?: string } = {}) {
  return {
    jobRequestId: "33333333-3333-4333-8333-333333333333",
    companyId: TEST_COMPANY_ID,
    payload: { paymentId: PAYMENT_ID, workflow: "payment-succeeded", ...payload },
    attempt: 1,
  };
}

describe("the payment.receipt handler", () => {
  test("builds the receipt for the payment in the payload and records the run", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment();
    tenantRow.mockResolvedValue({
      data: {
        id: "tenant-1",
        name: "Ahmed",
        email: "tenant@example.test",
        whatsapp: "+96550000000",
        mobile: null,
        reminders_enabled: true,
        preferred_language: "en",
      },
      error: null,
    });

    const result = await createPaymentReceiptHandler()(jobContext());

    expect(result).toMatchObject({ paymentId: PAYMENT_ID, ok: true, skipped: false });
    expect(enqueue).toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "payment-succeeded", _status: "success" }),
    );
  });

  test("a paused workflow sends nothing when the job runs", async () => {
    // The job may sit in the queue for a while: an admin who pauses the
    // workflow in the meantime must not have the receipt mailed after the pause.
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });
    confirmedPayment();

    const result = await createPaymentReceiptHandler()(jobContext());

    expect(result).toMatchObject({ ok: true, skipped: true });
    expect(enqueue).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "payment-succeeded", _status: "skipped" }),
    );
  });

  test("a receipt without its pdf records the failure, naming the payment", async () => {
    // 2026-09-24 → 09-27: every PDF came back empty and the run still recorded
    // success — so nobody saw it until tenants complained. The send still goes
    // out; the badge goes red.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment();
    renderReceipts.mockResolvedValue([]);

    const result = await createPaymentReceiptHandler()(jobContext());

    expect(result).toMatchObject({ ok: true, missingPdfs: ["PAY-1"] });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({
        _key: "payment-succeeded",
        _status: "error",
        _error: expect.stringContaining("PAY-1"),
      }),
    );
  });

  test("a second run for the same payment does not send the receipt again", async () => {
    // The receipt rows carry the payment ids, so the sender finds them and
    // stops: the idempotency marker is the notification log itself.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment();
    notificationsContains.mockResolvedValueOnce({
      data: [{ id: "existing-1", payload: { payment_ids: [PAYMENT_ID] } }],
      error: null,
    });

    const result = await createPaymentReceiptHandler()(jobContext());

    expect(result).toMatchObject({ ok: true, skipped: true });
    expect(renderReceipts).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("the workflow the receipt is judged by", () => {
  /** لكل سير عمل مستلموه: السداد اليدوي للمستأجر، والدفع الإلكتروني للإدارة. */
  const RECIPIENTS_BY_WORKFLOW: Record<string, string[]> = {
    "manual-payment-invoice": ["tenant"],
    "payment-succeeded": ["admin"],
  };

  test.each<[string, string[]]>([
    ["manual-payment-invoice", ["receipt:email"]],
    ["payment-succeeded", ["payment_admin_alert:email"]],
  ])("the %s workflow sends to its own recipients", async (workflow, expectedTypes) => {
    // The registry answers per key, so a receipt judged by the wrong workflow
    // lands on the other workflow's recipients and this test fails.
    maybeSingle.mockImplementation(async (key: string) => ({
      data: {
        is_active: true,
        recipient_targets: RECIPIENTS_BY_WORKFLOW[key] ?? ["company"],
      },
      error: null,
    }));
    confirmedPayment();

    await createPaymentReceiptHandler()(jobContext({ workflow }));

    const types = enqueue.mock.calls.map(([arg]) => `${arg.type}:${arg.channel}`);
    expect(types).toEqual(expectedTypes);
  });
});
