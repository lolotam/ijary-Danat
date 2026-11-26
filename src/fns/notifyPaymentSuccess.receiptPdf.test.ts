import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/company/requestCompany.server", async () =>
  (await import("./notifyPaymentSuccess.testkit")).requestCompanyModule(),
);
vi.mock("@/company/companyClient.server", async () =>
  (await import("./notifyPaymentSuccess.testkit")).companyClientModule(),
);
vi.mock("@/lib/paymentReceiptPdf", async () =>
  (await import("./notifyPaymentSuccess.testkit")).paymentReceiptPdfModule(),
);
vi.mock("@/fns/enqueueNotification", async () =>
  (await import("./notifyPaymentSuccess.testkit")).enqueueNotificationModule(),
);

import {
  PAYMENT_ID,
  confirmedPayment,
  enqueue,
  maybeSingle,
  notificationsContains,
  paymentsIn,
  renderReceipts,
  resetPaymentNotifyMocks,
  rpc,
  storedReceiptFor,
  tenantRow,
} from "./notifyPaymentSuccess.testkit";

const { notifyPaymentSuccess } = await import("./notifyPaymentSuccess");

beforeEach(resetPaymentNotifyMocks);

describe("the receipt pdf rides along with every mail", () => {
  /**
   * مستأجر بواتساب مفعّل — فتُبنى الإشعارات الثلاثة كلها.
   *
   * Tenant with WhatsApp on, so all three notifications are built.
   */
  function tenantOnEveryChannel() {
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
  }

  test("both emails carry the stored pdf as a real attachment", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment();
    tenantOnEveryChannel();

    await notifyPaymentSuccess([PAYMENT_ID]);

    const emails = enqueue.mock.calls.map(([arg]) => arg).filter((arg) => arg.channel === "email");
    expect(emails.map((arg) => arg.type).sort()).toEqual(["payment_admin_alert", "receipt"]);
    for (const email of emails) {
      expect(email.payload.attachment_bucket).toBe("report-documents");
      expect(email.payload.attachment_paths).toEqual(["payment-receipts/PAY-1-x.pdf"]);
    }
  });

  test("the WhatsApp row carries the pdf as a real attachment", async () => {
    // The Evolution provider sends documents as media parts, so the WhatsApp
    // receipt leg now claims `attachment_paths` — the tenant receives the
    // receipt PDF itself. The receipt_pdf_* record keys stay for auditability.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment();
    tenantOnEveryChannel();

    await notifyPaymentSuccess([PAYMENT_ID]);

    const whatsapp = enqueue.mock.calls
      .map(([arg]) => arg)
      .find((arg) => arg.channel === "whatsapp");
    expect(whatsapp).toBeDefined();
    expect(whatsapp.payload.attachment_paths).toEqual(["payment-receipts/PAY-1-x.pdf"]);
    expect(whatsapp.payload.attachment_bucket).toBe("report-documents");
    expect(whatsapp.payload.receipt_pdf_paths).toEqual(["payment-receipts/PAY-1-x.pdf"]);
    expect(whatsapp.payload.receipt_pdf_bucket).toBe("report-documents");
  });

  test("renders nothing when the workflow reaches no recipient at all", async () => {
    // An admin-only workflow with no configured address, or a tenant with
    // neither an email nor a WhatsApp number, would otherwise spawn a Chromium
    // process and write a storage object for a mail nobody receives.
    maybeSingle.mockResolvedValue({
      data: { is_active: true, recipient_targets: ["tenant"] },
      error: null,
    });
    confirmedPayment();
    tenantRow.mockResolvedValue({
      data: {
        id: "tenant-1",
        name: "Ahmed",
        email: null,
        whatsapp: null,
        mobile: null,
        reminders_enabled: false,
        preferred_language: "en",
      },
      error: null,
    });

    await notifyPaymentSuccess([PAYMENT_ID]);

    expect(renderReceipts).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("a settlement covering several payments attaches one receipt each", async () => {
    // A multi-month payment link confirms one payment per invoice month, and
    // each is its own receipt. Collapsing them to one attachment would send a
    // tenant a document for a fraction of what they paid.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment();
    renderReceipts.mockResolvedValue([
      { bucket: "report-documents", path: "payment-receipts/PAY-1-a.pdf", paymentId: PAYMENT_ID },
      { bucket: "report-documents", path: "payment-receipts/PAY-2-b.pdf", paymentId: PAYMENT_ID },
    ]);

    await notifyPaymentSuccess([PAYMENT_ID]);

    const receipt = enqueue.mock.calls.map(([arg]) => arg).find((arg) => arg.type === "receipt");
    expect(receipt.payload.attachment_paths).toEqual([
      "payment-receipts/PAY-1-a.pdf",
      "payment-receipts/PAY-2-b.pdf",
    ]);
  });

  test("a failed render still sends the mail, with no attachment keys at all", async () => {
    // The degradation that must never become an outage. An empty
    // `attachment_paths` would be worse than no key: dispatchNotification would
    // claim an attachment it cannot load.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment();
    renderReceipts.mockResolvedValue([]);

    const result = await notifyPaymentSuccess([PAYMENT_ID]);

    expect(result).toMatchObject({ ok: true, skipped: false });
    expect(enqueue).toHaveBeenCalled();
    for (const [arg] of enqueue.mock.calls) {
      expect(arg.payload).not.toHaveProperty("attachment_paths");
      expect(arg.payload).not.toHaveProperty("attachment_bucket");
    }
  });

  test("a receipt sent without its pdf fails the workflow run, naming the payment", async () => {
    // 2026-09-24 → 09-27: the snapshot RPC refused the service key, every PDF
    // came back empty, and the run still recorded success — so nobody saw it
    // until tenants complained. The send still goes out; the badge goes red.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment();
    tenantOnEveryChannel();
    renderReceipts.mockResolvedValue([]);

    const result = await notifyPaymentSuccess([PAYMENT_ID]);

    expect(result).toMatchObject({ ok: true, skipped: false, missingPdfs: ["PAY-1"] });
    const rows = enqueue.mock.calls.map(([arg]) => arg);
    expect(rows.map((row) => `${row.type}:${row.channel}`).sort()).toEqual([
      "payment_admin_alert:email",
      "receipt:email",
      "receipt:whatsapp",
    ]);
    for (const row of rows) expect(row.payload.attachment_missing).toEqual(["PAY-1"]);
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({
        _key: "payment-succeeded",
        _status: "error",
        _error: expect.stringContaining("PAY-1"),
      }),
    );
  });

  test("a receipt whose pdf rendered records success and claims nothing missing", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment();
    tenantOnEveryChannel();

    const result = await notifyPaymentSuccess([PAYMENT_ID]);

    expect(result).not.toHaveProperty("missingPdfs");
    for (const [arg] of enqueue.mock.calls) {
      expect(arg.payload).not.toHaveProperty("attachment_missing");
    }
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "payment-succeeded", _status: "success" }),
    );
  });

  test("a multi-payment settlement names only the payment whose pdf is missing", async () => {
    const OTHER_PAYMENT = "cccccccc-3333-4ccc-8ccc-cccccccccccc";
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    paymentsIn.mockReturnValue({
      eq: async () => ({
        data: [
          {
            id: PAYMENT_ID,
            tenant_id: "tenant-1",
            amount: "250.000",
            currency: "KWD",
            code: "PAY-1",
            reference: "REF-1",
            payment_date: "2026-08-01",
          },
          {
            id: OTHER_PAYMENT,
            tenant_id: "tenant-1",
            amount: "100.000",
            currency: "KWD",
            code: "PAY-2",
            reference: "REF-2",
            payment_date: "2026-08-01",
          },
        ],
        error: null,
      }),
    });
    renderReceipts.mockImplementation(async (input) =>
      input.payments.filter((payment) => payment.id === PAYMENT_ID).map(storedReceiptFor),
    );

    const result = await notifyPaymentSuccess([PAYMENT_ID, OTHER_PAYMENT]);

    expect(result).toMatchObject({ ok: true, missingPdfs: ["PAY-2"] });
    const receipt = enqueue.mock.calls.map(([arg]) => arg).find((arg) => arg.type === "receipt");
    expect(receipt.payload.attachment_paths).toEqual(["payment-receipts/PAY-1-x.pdf"]);
    expect(receipt.payload.attachment_missing).toEqual(["PAY-2"]);
  });

  test("an already-notified payment set renders nothing", async () => {
    // Rendering sits after the idempotency return precisely so a duplicate
    // notify costs no Chromium process and writes no storage object.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment();
    notificationsContains.mockResolvedValueOnce({
      data: [{ id: "existing-1", payload: { payment_ids: [PAYMENT_ID] } }],
      error: null,
    });

    const result = await notifyPaymentSuccess([PAYMENT_ID]);

    expect(result).toMatchObject({ ok: true, skipped: true });
    expect(renderReceipts).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
