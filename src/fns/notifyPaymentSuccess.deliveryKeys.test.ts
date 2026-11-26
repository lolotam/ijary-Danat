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
  enqueue,
  maybeSingle,
  paymentsIn,
  resetPaymentNotifyMocks,
  tenantRow,
} from "./notifyPaymentSuccess.testkit";

const { notifyPaymentSuccess } = await import("./notifyPaymentSuccess");

beforeEach(resetPaymentNotifyMocks);

/**
 * One delivery key per payment set per channel.
 *
 * The webhook and the return page both settle the same payment and both
 * notify, so the DATABASE — not the application — has to be what refuses the
 * second notification. `enqueueNotification` reads a 23505 on insert as
 * "this delivery already exists" and returns the existing row, so the key this
 * sender writes is the whole mechanism.
 */
describe("one delivery key per payment set per channel", () => {
  const PAYMENT_A = "22222222-2222-4222-8222-222222222222";
  const PAYMENT_B = "cccccccc-3333-4ccc-8ccc-cccccccccccc";

  /**
   * يؤكّد دفعتين للمستأجر نفسه — فيحمل المفتاح معرّفَي الدفعة.
   *
   * Confirms two payments for the same tenant, so the key carries both ids.
   */
  function twoConfirmedPayments() {
    paymentsIn.mockReturnValue({
      eq: async () => ({
        data: [
          {
            id: PAYMENT_A,
            tenant_id: "tenant-1",
            amount: "250.000",
            currency: "KWD",
            code: "PAY-1",
            reference: "REF-1",
            payment_date: "2026-08-01",
            method: "cash",
          },
          {
            id: PAYMENT_B,
            tenant_id: "tenant-1",
            amount: "100.000",
            currency: "KWD",
            code: "PAY-2",
            reference: "REF-2",
            payment_date: "2026-08-01",
            method: "cash",
          },
        ],
        error: null,
      }),
    });
  }

  /**
   * مستأجر ببريد وواتساب — فتُبنى الإشعارات الثلاثة كلها.
   *
   * Tenant with an email and WhatsApp, so all three notifications are built.
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

  /**
   * مفتاح التسليم الذي أُعطي لكل إشعار مُصفوف.
   *
   * The delivery key each enqueued notification was given.
   */
  function deliveryKeys(): Record<string, string> {
    return Object.fromEntries(
      enqueue.mock.calls.map(([arg]) => [`${arg.type}:${arg.channel}`, arg.deliveryKey]),
    );
  }

  /**
   * يحسب بصمة SHA-256 لمعرّفات الدفعات، بالطريقة نفسها التي يحسب بها المرسِل.
   *
   * The sender hashes the sorted confirmed payment ids, so the expected key is
   * computed here the same way instead of being written out as a literal.
   */
  async function deliveryDigestFor(paymentIds: string[]): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode([...paymentIds].sort().join(",")),
    );
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }

  test("each notification carries its own delivery key", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    twoConfirmedPayments();
    tenantOnEveryChannel();

    await notifyPaymentSuccess([PAYMENT_A, PAYMENT_B]);

    const set = await deliveryDigestFor([PAYMENT_A, PAYMENT_B]);
    expect(deliveryKeys()).toEqual({
      "payment_admin_alert:email": `payment_admin_alert:email:${set}`,
      "receipt:email": `receipt:email:${set}`,
      "receipt:whatsapp": `receipt:whatsapp:${set}`,
    });
  });

  test("the same payments in a different order give the same key", async () => {
    // The two settlement paths do not hand the ids over in the same order, so
    // an unsorted key would be a different key — and the duplicate
    // notification would sail straight through the unique index.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    twoConfirmedPayments();
    tenantOnEveryChannel();

    await notifyPaymentSuccess([PAYMENT_A, PAYMENT_B]);
    await notifyPaymentSuccess([PAYMENT_B, PAYMENT_A]);

    const keys = enqueue.mock.calls.map(([arg]) => arg.deliveryKey);
    expect(keys).toHaveLength(6);
    expect(keys.slice(0, 3)).toEqual(keys.slice(3, 6));
  });
});
