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
  paymentsIn,
  renderReceipts,
  resetPaymentNotifyMocks,
  resolveRecipients,
  state,
  tenantRow,
} from "./notifyPaymentSuccess.testkit";

const { notifyPaymentSuccess } = await import("./notifyPaymentSuccess");

beforeEach(resetPaymentNotifyMocks);

describe("suppressed roof contracts hide tenant paper, not admin paper", () => {
  const ROOF_CONTRACT = "4382a1fe-db50-4bae-8360-58ec43ecf3c8";
  const SHOP_CONTRACT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const INVOICE_ROOF = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
  const INVOICE_SHOP = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb";

  function tenantWithEmail() {
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

  test("payment on a suppressed contract sends no tenant email or WhatsApp", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment();
    tenantWithEmail();
    state.allocationData = [{ payment_id: PAYMENT_ID, invoice_id: INVOICE_ROOF, amount: 250 }];
    state.invoiceData = [
      {
        id: INVOICE_ROOF,
        code: "INV-1",
        period_month: 1,
        period_year: 2026,
        total: 250,
        balance: 0,
        manual_payment_reason: null,
        contract_id: ROOF_CONTRACT,
      },
    ];
    state.contractData = [{ id: ROOF_CONTRACT, suppress_tenant_billing_docs: true }];

    await notifyPaymentSuccess([PAYMENT_ID]);

    const types = enqueue.mock.calls.map(([arg]) => `${arg.type}:${arg.channel}`);
    expect(types).not.toContain("receipt:email");
    expect(types).not.toContain("receipt:whatsapp");
  });

  test("payment on a suppressed contract with reminders_enabled false and WhatsApp still sends no tenant row", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
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
    state.allocationData = [{ payment_id: PAYMENT_ID, invoice_id: INVOICE_ROOF, amount: 250 }];
    state.invoiceData = [
      {
        id: INVOICE_ROOF,
        code: "INV-1",
        period_month: 1,
        period_year: 2026,
        total: 250,
        balance: 0,
        manual_payment_reason: null,
        contract_id: ROOF_CONTRACT,
      },
    ];
    state.contractData = [{ id: ROOF_CONTRACT, suppress_tenant_billing_docs: true }];

    await notifyPaymentSuccess([PAYMENT_ID]);

    const types = enqueue.mock.calls.map(([arg]) => `${arg.type}:${arg.channel}`);
    expect(types).not.toContain("receipt:email");
    expect(types).not.toContain("receipt:whatsapp");
  });

  test("same suppressed payment still sends admin and company notifications", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment();
    tenantWithEmail();
    state.allocationData = [{ payment_id: PAYMENT_ID, invoice_id: INVOICE_ROOF, amount: 250 }];
    state.invoiceData = [
      {
        id: INVOICE_ROOF,
        code: "INV-1",
        period_month: 1,
        period_year: 2026,
        total: 250,
        balance: 0,
        manual_payment_reason: null,
        contract_id: ROOF_CONTRACT,
      },
    ];
    state.contractData = [{ id: ROOF_CONTRACT, suppress_tenant_billing_docs: true }];

    await notifyPaymentSuccess([PAYMENT_ID]);

    const adminAlerts = enqueue.mock.calls
      .map(([arg]) => arg)
      .filter((arg) => arg.type === "payment_admin_alert");
    expect(adminAlerts.length).toBeGreaterThan(0);
  });

  test("suppressed tenant-only payment renders no PDF when no admin receives it", async () => {
    maybeSingle.mockResolvedValue({
      data: { is_active: true, recipient_targets: ["tenant"] },
      error: null,
    });
    confirmedPayment();
    tenantWithEmail();
    // Admin list empty for tenant-only workflow.
    resolveRecipients.mockResolvedValueOnce([]);
    state.allocationData = [{ payment_id: PAYMENT_ID, invoice_id: INVOICE_ROOF, amount: 250 }];
    state.invoiceData = [
      {
        id: INVOICE_ROOF,
        code: "INV-1",
        period_month: 1,
        period_year: 2026,
        total: 250,
        balance: 0,
        manual_payment_reason: null,
        contract_id: ROOF_CONTRACT,
      },
    ];
    state.contractData = [{ id: ROOF_CONTRACT, suppress_tenant_billing_docs: true }];

    await notifyPaymentSuccess([PAYMENT_ID]);

    expect(renderReceipts).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("payment mixing a suppressed and an ordinary invoice still suppresses tenant notification", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment();
    tenantWithEmail();
    state.allocationData = [
      { payment_id: PAYMENT_ID, invoice_id: INVOICE_ROOF, amount: 150 },
      { payment_id: PAYMENT_ID, invoice_id: INVOICE_SHOP, amount: 100 },
    ];
    state.invoiceData = [
      {
        id: INVOICE_ROOF,
        code: "INV-ROOF",
        period_month: 1,
        period_year: 2026,
        total: 150,
        balance: 0,
        manual_payment_reason: null,
        contract_id: ROOF_CONTRACT,
      },
      {
        id: INVOICE_SHOP,
        code: "INV-SHOP",
        period_month: 1,
        period_year: 2026,
        total: 100,
        balance: 0,
        manual_payment_reason: null,
        contract_id: SHOP_CONTRACT,
      },
    ];
    state.contractData = [
      { id: ROOF_CONTRACT, suppress_tenant_billing_docs: true },
      { id: SHOP_CONTRACT, suppress_tenant_billing_docs: false },
    ];

    await notifyPaymentSuccess([PAYMENT_ID]);

    const types = enqueue.mock.calls.map(([arg]) => `${arg.type}:${arg.channel}`);
    expect(types).not.toContain("receipt:email");
    expect(types).not.toContain("receipt:whatsapp");
    expect(types).toContain("payment_admin_alert:email");
  });

  test("ordinary payment is completely unchanged", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    confirmedPayment();
    tenantWithEmail();
    state.allocationData = [{ payment_id: PAYMENT_ID, invoice_id: INVOICE_SHOP, amount: 250 }];
    state.invoiceData = [
      {
        id: INVOICE_SHOP,
        code: "INV-SHOP",
        period_month: 1,
        period_year: 2026,
        total: 250,
        balance: 0,
        manual_payment_reason: null,
        contract_id: SHOP_CONTRACT,
      },
    ];
    state.contractData = [{ id: SHOP_CONTRACT, suppress_tenant_billing_docs: false }];

    await notifyPaymentSuccess([PAYMENT_ID]);

    const types = enqueue.mock.calls.map(([arg]) => `${arg.type}:${arg.channel}`).sort();
    expect(types).toEqual(
      ["payment_admin_alert:email", "receipt:email", "receipt:whatsapp"].sort(),
    );
    expect(renderReceipts).toHaveBeenCalled();
  });

  // An all-contracts checkout creates one payment per invoice and notifies for
  // all of them at once. A single suppressed payment must not cost the tenant
  // the notification for the ordinary ones — the suppression is per payment.
  test("a mixed BATCH still notifies the tenant, and renders only the ordinary payment", async () => {
    const OTHER_PAYMENT = "cccccccc-3333-4ccc-8ccc-cccccccccccc";
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    tenantWithEmail();
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
    state.allocationData = [
      { payment_id: PAYMENT_ID, invoice_id: INVOICE_ROOF, amount: 250 },
      { payment_id: OTHER_PAYMENT, invoice_id: INVOICE_SHOP, amount: 100 },
    ];
    state.invoiceData = [
      {
        id: INVOICE_ROOF,
        code: "INV-1",
        period_month: 1,
        period_year: 2026,
        total: 250,
        balance: 0,
        manual_payment_reason: null,
        contract_id: ROOF_CONTRACT,
      },
      {
        id: INVOICE_SHOP,
        code: "INV-2",
        period_month: 1,
        period_year: 2026,
        total: 100,
        balance: 0,
        manual_payment_reason: null,
        contract_id: SHOP_CONTRACT,
      },
    ];
    state.contractData = [
      { id: ROOF_CONTRACT, suppress_tenant_billing_docs: true },
      { id: SHOP_CONTRACT, suppress_tenant_billing_docs: false },
    ];

    await notifyPaymentSuccess([PAYMENT_ID, OTHER_PAYMENT]);

    const types = enqueue.mock.calls.map(([arg]) => `${arg.type}:${arg.channel}`);
    expect(types).toContain("receipt:email");

    // The roof payment must not appear in anything rendered for the tenant.
    const renderedForTenant = renderReceipts.mock.calls
      .map(([input]) => input.payments.map((payment) => payment.id))
      .find((ids) => !ids.includes(PAYMENT_ID));
    expect(renderedForTenant).toEqual([OTHER_PAYMENT]);
  });
});
