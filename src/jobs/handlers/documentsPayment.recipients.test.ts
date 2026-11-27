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
  renderReceipts,
  resetPaymentNotifyMocks,
  resolveRecipients,
  templateRow,
  tenantRow,
  TEST_COMPANY_ID,
} from "./documentsPayment.testkit";

const { sendPaymentReceipts } = await import("./documentsPayment");

beforeEach(resetPaymentNotifyMocks);

describe("recipient targets gate at two levels", () => {
  test("tenant off suppresses receipt email and WhatsApp", async () => {
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

    await sendPaymentReceipts([PAYMENT_ID], ["admin", "company"], TEST_COMPANY_ID);

    const types = enqueue.mock.calls.map(([arg]) => `${arg.type}:${arg.channel}`);
    expect(types).toEqual(["payment_admin_alert:email"]);
    expect(types).not.toContain("receipt:email");
    expect(types).not.toContain("receipt:whatsapp");
  });

  test("admin off + company on still enqueues the admin block to the company", async () => {
    // The defect this guards against: wrapping the admin block in
    // targets.includes("admin") would silently kill company-only sends.
    confirmedPayment();
    resolveRecipients.mockImplementationOnce(async (targets: string[]) =>
      targets.includes("company") ? ["company@example.test"] : [],
    );

    await sendPaymentReceipts([PAYMENT_ID], ["company"], TEST_COMPANY_ID);

    const adminAlert = enqueue.mock.calls
      .map(([arg]) => arg)
      .find((arg) => arg.type === "payment_admin_alert");
    expect(adminAlert).toBeDefined();
    expect(adminAlert.recipientAddress).toBe("company@example.test");
    expect(adminAlert.payload.recipients).toEqual(["company@example.test"]);
  });

  test("reminders_enabled false + WhatsApp + no email still enqueues WhatsApp receipt and renders PDF once", async () => {
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

    await sendPaymentReceipts([PAYMENT_ID], ["tenant"], TEST_COMPANY_ID);

    const types = enqueue.mock.calls.map(([arg]) => `${arg.type}:${arg.channel}`);
    expect(types).toEqual(["receipt:whatsapp"]);
    expect(renderReceipts).toHaveBeenCalledTimes(1);
  });

  test("reminders_enabled false + email + WhatsApp enqueues both tenant channels", async () => {
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

    await sendPaymentReceipts([PAYMENT_ID], ["tenant"], TEST_COMPANY_ID);

    const types = enqueue.mock.calls.map(([arg]) => `${arg.type}:${arg.channel}`).sort();
    expect(types).toEqual(["receipt:email", "receipt:whatsapp"]);
  });

  test("whatsapp null with mobile present sends WhatsApp receipt to mobile", async () => {
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

    await sendPaymentReceipts([PAYMENT_ID], ["tenant"], TEST_COMPANY_ID);

    const whatsapp = enqueue.mock.calls
      .map(([arg]) => arg)
      .find((arg) => arg.type === "receipt" && arg.channel === "whatsapp");
    expect(whatsapp).toBeDefined();
    expect(whatsapp.recipientAddress).toBe("+96550000001");
  });

  test("receipt template restricted to email suppresses WhatsApp receipt", async () => {
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

    await sendPaymentReceipts([PAYMENT_ID], ["tenant"], TEST_COMPANY_ID);

    const types = enqueue.mock.calls.map(([arg]) => `${arg.type}:${arg.channel}`);
    expect(types).toEqual(["receipt:email"]);
  });

  test("targets without tenant + reminders_enabled false still sends no tenant row", async () => {
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

    await sendPaymentReceipts([PAYMENT_ID], ["admin", "company"], TEST_COMPANY_ID);

    const types = enqueue.mock.calls.map(([arg]) => `${arg.type}:${arg.channel}`);
    expect(types).toEqual(["payment_admin_alert:email"]);
  });

  test("WhatsApp receipt carries audience tenant and tenantId for notifications_paused gate", async () => {
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

    await sendPaymentReceipts([PAYMENT_ID], ["tenant"], TEST_COMPANY_ID);

    const whatsapp = enqueue.mock.calls
      .map(([arg]) => arg)
      .find((arg) => arg.type === "receipt" && arg.channel === "whatsapp");
    expect(whatsapp).toMatchObject({
      audience: "tenant",
      tenantId: "tenant-1",
    });
  });
});
