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
  paymentsIn,
  resetPaymentNotifyMocks,
  rpc,
  templateRow,
} from "./notifyPaymentSuccess.testkit";

const { notifyPaymentSuccess } = await import("./notifyPaymentSuccess");

beforeEach(resetPaymentNotifyMocks);

describe("the payment-succeeded workflow switch", () => {
  test("a paused workflow enqueues nothing", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });

    const result = await notifyPaymentSuccess([PAYMENT_ID]);

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true });
  });

  test("pausing records against this workflow's own key", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });

    await notifyPaymentSuccess([PAYMENT_ID]);

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "payment-succeeded", _status: "skipped" }),
    );
  });

  test("a paused workflow reports ok, not failure", async () => {
    // This sits on the MyFatoorah path. A deliberate pause must not look like a
    // payment-notification failure to the webhook that logs the result.
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });

    const result = await notifyPaymentSuccess([PAYMENT_ID]);

    expect(result).toMatchObject({ ok: true });
  });
});

describe("classifying what the sender did", () => {
  test("having nothing to send records skipped, not failed", async () => {
    // "No payment ids." and "No confirmed payments." are correct outcomes — the
    // latter is exactly what a declined KNET transaction produces. Recording
    // them as errors would leave a permanent red Failed badge on the monitoring
    // tab and train admins to ignore it.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });

    const result = await notifyPaymentSuccess([]);

    expect(result).toMatchObject({ ok: false });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "payment-succeeded", _status: "skipped" }),
    );
  });

  test("a nothing-to-do result is never recorded as a success either", async () => {
    // The other half of the same claim: a green row would say a receipt went
    // out when none did.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });

    await notifyPaymentSuccess([]);

    const statuses = rpc.mock.calls
      .filter(([name]) => name === "record_cron_run")
      .map(([, args]) => (args as { _status: string })._status);
    expect(statuses).not.toContain("success");
  });

  test("a genuine failure still records an error, not a skip", async () => {
    // The mirror of the two tests above, and the one that stops the fix from
    // rotting: `nothingToDo` is tagged on two returns three lines away from the
    // catch block's return. If someone ever tags the catch too, every real
    // breakage would silently become a grey Skipped badge — and without this
    // test, nothing would fail.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    paymentsIn.mockReturnValue({
      eq: () => Promise.resolve({ data: null, error: { message: "connection lost" } }),
    });

    const result = await notifyPaymentSuccess([PAYMENT_ID]);

    expect(result).toMatchObject({ ok: false });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({
        _key: "payment-succeeded",
        _status: "error",
        _error: "connection lost",
      }),
    );
  });
});

describe("the stored templates decide the two mails", () => {
  test("each mail gets its own template body, not the other's", async () => {
    // This sender loads two codes — the admin alert and the tenant receipt. A
    // single shared marker would pass even if it used one code for both, so
    // each gets a distinct body and both are asserted.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment();
    templateRow.mockImplementation(async (code: string) => ({
      data: {
        subject_ar: "س",
        subject_en: `S-${code}`,
        body_ar: "<p>AR</p>",
        body_en: code.startsWith("receipt") ? "<p>RECEIPT-MARKER</p>" : "<p>ADMIN-MARKER</p>",
      },
      error: null,
    }));

    const result = await notifyPaymentSuccess([PAYMENT_ID]);

    expect(result).toMatchObject({ ok: true, skipped: false });
    const byType = Object.fromEntries(
      enqueue.mock.calls.map(([arg]) => [`${arg.type}:${arg.channel}`, arg as { body: string }]),
    );
    expect(byType["payment_admin_alert:email"].body).toContain("ADMIN-MARKER");
    expect(byType["receipt:email"].body).toContain("RECEIPT-MARKER");
  });

  test("a missing template falls back to the built-in copy and still sends both", async () => {
    // A deleted or deactivated row must degrade to the built-in body, never to
    // sending nothing on the money path.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment();
    templateRow.mockResolvedValue({ data: null, error: null });

    const result = await notifyPaymentSuccess([PAYMENT_ID]);

    expect(result).toMatchObject({ ok: true, skipped: false });
    expect(enqueue).toHaveBeenCalledTimes(2);
    for (const [arg] of enqueue.mock.calls) {
      expect((arg.body as string).length).toBeGreaterThan(0);
    }
  });
});

describe("the admin alert names the payment method", () => {
  /** يرجع نص تنبيه الإدارة المُرسل بالبريد. */
  function adminAlertBody(): string {
    const alert = enqueue.mock.calls
      .map(([arg]) => arg)
      .find((arg) => arg.type === "payment_admin_alert" && arg.channel === "email");
    return alert.body as string;
  }

  test("the stored template's {{payment_method}} gets the payments-page label", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment("knet");
    templateRow.mockResolvedValue({
      data: {
        subject_ar: "س",
        subject_en: "S",
        body_ar: "<p>AR</p>",
        body_en: "<p>Method: {{payment_method}}</p>",
      },
      error: null,
    });

    await notifyPaymentSuccess([PAYMENT_ID]);

    expect(adminAlertBody()).toContain("Method: Payment link (KNET)");
  });

  test("the built-in fallback prints the method line too", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment("cash");
    templateRow.mockResolvedValue({ data: null, error: null });

    await notifyPaymentSuccess([PAYMENT_ID]);

    expect(adminAlertBody()).toContain("<strong>Payment method:</strong> Cash");
  });
});
