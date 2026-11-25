import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", async () =>
  (await import("./notifyPaymentSuccess.testkit")).supabaseAdminModule(),
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
  renderReceipts,
  resetPaymentNotifyMocks,
  resolveRecipients,
  templateRow,
  tenantRow,
} from "./notifyPaymentSuccess.testkit";

const { notifyPaymentSuccess } = await import("./notifyPaymentSuccess");

beforeEach(resetPaymentNotifyMocks);

describe("recipient targets gate at two levels", () => {
  test("tenant off suppresses receipt email and WhatsApp", async () => {
    maybeSingle.mockResolvedValue({
      data: { is_active: true, recipient_targets: ["admin", "company"] },
      error: null,
    });
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

    await notifyPaymentSuccess([PAYMENT_ID]);

    const types = enqueue.mock.calls.map(([arg]) => `${arg.type}:${arg.channel}`);
    expect(types).toEqual(["payment_admin_alert:email"]);
    expect(types).not.toContain("receipt:email");
    expect(types).not.toContain("receipt:whatsapp");
  });

  test("admin off + company on still enqueues the admin block to the company", async () => {
    // The defect this guards against: wrapping the admin block in
    // targets.includes("admin") would silently kill company-only sends.
    maybeSingle.mockResolvedValue({
      data: { is_active: true, recipient_targets: ["company"] },
      error: null,
    });
    confirmedPayment();
    resolveRecipients.mockImplementationOnce(async (targets: string[]) =>
      targets.includes("company") ? ["company@example.test"] : [],
    );

    await notifyPaymentSuccess([PAYMENT_ID]);

    const adminAlert = enqueue.mock.calls
      .map(([arg]) => arg)
      .find((arg) => arg.type === "payment_admin_alert");
    expect(adminAlert).toBeDefined();
    expect(adminAlert.recipientAddress).toBe("company@example.test");
    expect(adminAlert.payload.recipients).toEqual(["company@example.test"]);
  });

  test("reminders_enabled false + WhatsApp + no email still enqueues WhatsApp receipt and renders PDF once", async () => {
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
        whatsapp: "+96550000000",
        mobile: null,
        reminders_enabled: false,
        preferred_language: "en",
      },
      error: null,
    });

    await notifyPaymentSuccess([PAYMENT_ID]);

    const types = enqueue.mock.calls.map(([arg]) => `${arg.type}:${arg.channel}`);
    expect(types).toEqual(["receipt:whatsapp"]);
    expect(renderReceipts).toHaveBeenCalledTimes(1);
  });

  test("reminders_enabled false + email + WhatsApp enqueues both tenant channels", async () => {
    maybeSingle.mockResolvedValue({
      data: { is_active: true, recipient_targets: ["tenant"] },
      error: null,
    });
    confirmedPayment();
    tenantRow.mockResolvedValue({
      data: {
        id: "tenant-1",
        name: "Ahmed",
        email: "tenant@example.test",
        whatsapp: "+96550000000",
        mobile: null,
        reminders_enabled: false,
        preferred_language: "en",
      },
      error: null,
    });

    await notifyPaymentSuccess([PAYMENT_ID]);

    const types = enqueue.mock.calls.map(([arg]) => `${arg.type}:${arg.channel}`).sort();
    expect(types).toEqual(["receipt:email", "receipt:whatsapp"]);
  });

  test("whatsapp null with mobile present sends WhatsApp receipt to mobile", async () => {
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
        mobile: "+96550000001",
        reminders_enabled: false,
        preferred_language: "en",
      },
      error: null,
    });

    await notifyPaymentSuccess([PAYMENT_ID]);

    const whatsapp = enqueue.mock.calls
      .map(([arg]) => arg)
      .find((arg) => arg.type === "receipt" && arg.channel === "whatsapp");
    expect(whatsapp).toBeDefined();
    expect(whatsapp.recipientAddress).toBe("+96550000001");
  });

  test("receipt template restricted to email suppresses WhatsApp receipt", async () => {
    maybeSingle.mockResolvedValue({
      data: { is_active: true, recipient_targets: ["tenant"] },
      error: null,
    });
    confirmedPayment();
    tenantRow.mockResolvedValue({
      data: {
        id: "tenant-1",
        name: "Ahmed",
        email: "tenant@example.test",
        whatsapp: "+96550000000",
        mobile: null,
        reminders_enabled: false,
        preferred_language: "en",
      },
      error: null,
    });
    templateRow.mockImplementation(async (code: string) => ({
      data:
        code === "receipt"
          ? {
              subject_ar: "س",
              subject_en: "Receipt",
              body_ar: "<p>AR</p>",
              body_en: "<p>EN</p>",
              channel: "email",
            }
          : null,
      error: null,
    }));

    await notifyPaymentSuccess([PAYMENT_ID]);

    const types = enqueue.mock.calls.map(([arg]) => `${arg.type}:${arg.channel}`);
    expect(types).toEqual(["receipt:email"]);
  });

  test("targets without tenant + reminders_enabled false still sends no tenant row", async () => {
    maybeSingle.mockResolvedValue({
      data: { is_active: true, recipient_targets: ["admin", "company"] },
      error: null,
    });
    confirmedPayment();
    tenantRow.mockResolvedValue({
      data: {
        id: "tenant-1",
        name: "Ahmed",
        email: "tenant@example.test",
        whatsapp: "+96550000000",
        mobile: null,
        reminders_enabled: false,
        preferred_language: "en",
      },
      error: null,
    });

    await notifyPaymentSuccess([PAYMENT_ID]);

    const types = enqueue.mock.calls.map(([arg]) => `${arg.type}:${arg.channel}`);
    expect(types).toEqual(["payment_admin_alert:email"]);
  });

  test("WhatsApp receipt carries audience tenant and tenantId for notifications_paused gate", async () => {
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
        whatsapp: "+96550000000",
        mobile: null,
        reminders_enabled: false,
        preferred_language: "en",
      },
      error: null,
    });

    await notifyPaymentSuccess([PAYMENT_ID]);

    const whatsapp = enqueue.mock.calls
      .map(([arg]) => arg)
      .find((arg) => arg.type === "receipt" && arg.channel === "whatsapp");
    expect(whatsapp).toMatchObject({
      audience: "tenant",
      tenantId: "tenant-1",
    });
  });
});
