import { vi } from "vitest";

/**
 * عدّة اختبار مشتركة لإشعارات نجاح الدفع: توابع mocks المشتركة، البيانات
 * المتغيّرة، ومصانع الوحدات — تتقاسمها ملفات الاختبار الخمسة.
 *
 * Literal extraction of lines 1–174 of the original `notifyPaymentSuccess.test.ts`
 * so each responsibility stays in its own focused test file.
 */

export const maybeSingle = vi.fn();
export const rpc = vi.fn();
export const enqueue = vi.fn();
export const paymentsIn = vi.fn();
export const tenantRow = vi.fn();
export const templateRow = vi.fn();
export const notificationsContains = vi.fn();

export const state = {
  allocationData: [] as Array<{ payment_id: string; invoice_id: string; amount: number }>,
  invoiceData: [] as Array<{
    id: string;
    code: string;
    period_month: number;
    period_year: number;
    total: number;
    balance: number;
    manual_payment_reason: string | null;
    contract_id: string | null;
  }>,
  contractData: [] as Array<{ id: string; suppress_tenant_billing_docs: boolean | null }>,
};

/**
 * مصنع وحدة عميل Supabase Admin المزيّف، موجَّه حسب اسم الجدول.
 *
 * Factory for `vi.mock("@/integrations/supabase/client.server", …)`.
 */
export function supabaseAdminModule() {
  return {
    supabaseAdmin: {
      // Routed by table name. The earlier table-agnostic mock could only serve the
      // registry read and the payments fetch, which is why every test here stopped
      // before the sender did any work — and why nothing checked the mail itself.
      from: (table: string) => {
        if (table === "payments") {
          // `.select("*").in("id", ids).eq("status", "confirmed")`.
          return { select: () => ({ in: (...args: unknown[]) => paymentsIn(...args) }) };
        }
        if (table === "tenants") {
          return { select: () => ({ eq: () => ({ single: tenantRow }) }) };
        }
        if (table === "payment_allocations") {
          return {
            select: () => ({ in: async () => ({ data: state.allocationData, error: null }) }),
          };
        }
        if (table === "invoices") {
          return {
            select: () => ({ in: async () => ({ data: state.invoiceData, error: null }) }),
          };
        }
        if (table === "contracts") {
          return {
            select: () => ({ in: async () => ({ data: state.contractData, error: null }) }),
          };
        }
        if (table === "notifications") {
          // The idempotency scan:
          // `.in("type").neq("state").eq("tenant_id").contains("payload")`.
          return {
            select: () => ({
              in: () => ({
                neq: () => ({ eq: () => ({ contains: () => notificationsContains() }) }),
              }),
            }),
          };
        }
        if (table === "notification_templates") {
          // The requested code is passed through to the stub, so a test can hand
          // the receipt and the admin alert different bodies and prove the sender
          // does not swap them.
          return {
            select: () => ({
              eq: (_column: string, code: string) => ({
                eq: () => ({ maybeSingle: () => templateRow(code) }),
              }),
            }),
          };
        }
        // cron_jobs — the registry read: `.select("is_active").eq("key", …)`.
        return { select: () => ({ eq: () => ({ maybeSingle }) }) };
      },
      rpc: (...args: unknown[]) => rpc(...args),
    },
  };
}

export const resolveRecipients = vi.fn(async (targets: string[]) => {
  // Default: company/admin on → historic single-address admin list.
  if (targets.includes("admin") || targets.includes("company")) {
    return targets.includes("admin") && !targets.includes("company")
      ? ["admin@example.test"]
      : targets.includes("company") && !targets.includes("admin")
        ? ["company@example.test"]
        : ["admin@example.test"];
  }
  return [];
});

/**
 * Stubbed rather than exercised: rendering a receipt shells out to Chromium and
 * uploads to Storage, neither of which belongs in a test of which mails this
 * sender builds. `paymentReceiptPdf.test.ts` covers the renderer itself. What
 * matters here is only what the stub returns — a stored document, or nothing.
 */
// The parameter is declared so `renderReceipts.mock.calls` is typed: a test
// that asserts WHICH payments were rendered needs to read the argument, and an
// untyped `vi.fn()` makes its calls an empty tuple.
export const renderReceipts = vi.fn(async (input: { payments: Array<{ id: string }> }) =>
  input.payments.map(storedReceiptFor),
);

/**
 * يبني مستند PDF مخزّنًا وهميًا لدفعة واحدة، موسومًا بمعرّف تلك الدفعة.
 *
 * One per payment it was asked for — what the real renderer returns when
 * nothing fails. `PAYMENT_ID` keeps the path the attachment assertions below
 * name.
 */
export function storedReceiptFor(payment: { id: string }) {
  return {
    bucket: "report-documents",
    path:
      payment.id === "22222222-2222-4222-8222-222222222222"
        ? "payment-receipts/PAY-1-x.pdf"
        : `payment-receipts/${payment.id}.pdf`,
    paymentId: payment.id,
  };
}

/**
 * مصنع وحدة توليد PDF لإيصالات الدفع.
 *
 * Factory for `vi.mock("@/lib/paymentReceiptPdf", …)`.
 */
export function paymentReceiptPdfModule() {
  return {
    renderPaymentReceiptPdfs: (input: { payments: Array<{ id: string }> }) => renderReceipts(input),
  };
}

/**
 * مصنع وحدة إدراج الإشعارات وحل المستلمين.
 *
 * Factory for `vi.mock("@/fns/enqueueNotification", …)`.
 */
export function enqueueNotificationModule() {
  return {
    enqueueNotification: (...args: unknown[]) => enqueue(...args),
    resolveNotificationRecipients: (...args: unknown[]) =>
      resolveRecipients(...(args as [string[]])),
  };
}

export const PAYMENT_ID = "22222222-2222-4222-8222-222222222222";

/**
 * دفعة مؤكّدة واحدة تكفي المرسِل لبناء الإشعارين.
 *
 * One confirmed payment, enough for the sender to build both mails.
 */
export function confirmedPayment(method = "cash") {
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
          method,
        },
      ],
      error: null,
    }),
  });
}

/**
 * يعيد ضبط جميع التوابع والبيانات المشتركة قبل كل حالة اختبار.
 *
 * Resets all mocks and mutable query state before each test case.
 */
export function resetPaymentNotifyMocks() {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  tenantRow.mockResolvedValue({
    data: {
      id: "tenant-1",
      name: "Ahmed",
      email: "tenant@example.test",
      whatsapp: null,
      mobile: null,
      reminders_enabled: false,
      preferred_language: "en",
    },
    error: null,
  });
  templateRow.mockResolvedValue({ data: null, error: null });
  notificationsContains.mockResolvedValue({ data: [], error: null });
  enqueue.mockResolvedValue({ id: "notification-1" });
  renderReceipts.mockImplementation(async (input) => input.payments.map(storedReceiptFor));
  state.allocationData = [];
  state.invoiceData = [];
  state.contractData = [];
}
