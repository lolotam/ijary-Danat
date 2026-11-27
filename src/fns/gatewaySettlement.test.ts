/**
 * اختبارات تسوية بوابات الدفع (T138):
 * 1) تُسجَّل الدفعة مرة واحدة فقط سواء وصلت عبر الويب هوك أو صفحة العودة أو المطابقة الدورية.
 * 2) الدفعة قيد التنفيذ تُسوَّى على اتصالها الأصلي حتى بعد تبديل الشركة بوابتها النشطة.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/fns/gatewaySettlementFakeDb.test-support";
import type { LoadedGatewayConnection } from "@/gateways/connectionStore.server";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OLD_CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const NEW_CONNECTION_ID = "33333333-3333-4333-8333-333333333333";
const TENANT_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "55555555-5555-4555-8555-555555555555";
const INVOICE_ID = "66666666-6666-4666-8666-666666666666";
const PREQ_ID = "77777777-7777-4777-8777-777777777777";

const fake = vi.hoisted(() => ({ db: null as FakeDb | null }));
const loadGatewayConnectionMock = vi.hoisted(() => vi.fn());
const loadActiveGatewayConnectionMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-start", () => {
  const fn: any = (data: unknown) => fn._handler({ data, context: fn._context });
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.inputValidator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((h: unknown) => {
    fn._handler = h;
    return fn;
  });
  fn._context = {
    userId: USER_ID,
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { tenant_id: TENANT_ID }, error: null }),
          }),
        }),
      }),
    },
  };
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
    createMiddleware: vi.fn().mockReturnValue({ server: (m: unknown) => m }),
  };
});

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: vi.fn(),
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({
    from: (table: string) => (fake.db as FakeDb).client.from(table),
    rpc: (name: string, args: Record<string, unknown>) =>
      (fake.db as FakeDb).client.rpc(name, args),
  }),
}));

vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
  requireRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
  runWithRequestCompany: (_company: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/gateways/connectionStore.server", () => ({
  loadGatewayConnection: (...args: unknown[]) => loadGatewayConnectionMock(...args),
  loadActiveGatewayConnection: (...args: unknown[]) => loadActiveGatewayConnectionMock(...args),
}));

vi.mock("@/fns/notifyPaymentSuccess", () => ({
  notifyPaymentSuccess: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/suppressedPayments", () => ({
  getSuppressedPaymentIds: async () => new Set<string>(),
}));

const { confirmGatewayPayment } = await import("@/fns/confirmGatewayPayment");
const { settleGatewayPayment } = await import("@/fns/gatewaySettlement");
const { createInboundHandlers } = await import("@/jobs/handlers/inbound");

function makeConnection(id: string, apiKey: string, isActive: boolean): LoadedGatewayConnection {
  return {
    id,
    companyId: COMPANY_ID,
    provider: "myfatoorah",
    mode: "test",
    isActive,
    credentialsVersion: 1,
    connection: {
      provider: "myfatoorah",
      mode: "test",
      credentials: { apiKey, webhookSecret: "whsec" },
      publicConfig: {},
    },
  };
}

function seedInFlightDatabase() {
  fake.db = createFakeDb({
    tenants: [{ id: TENANT_ID, company_id: COMPANY_ID, name: "Renter" }],
    invoices: [
      {
        id: INVOICE_ID,
        code: "INV-0000001",
        tenant_id: TENANT_ID,
        unit_id: "unit-1",
        period_month: 1,
        period_year: 2026,
        total: "100.000",
        paid: "0.000",
        balance: "100.000",
        status: "unpaid",
      },
    ],
    payment_requests: [
      {
        id: PREQ_ID,
        code: "PREQ-0000001",
        company_id: COMPANY_ID,
        tenant_id: TENANT_ID,
        status: "pending",
        amount: "100.000",
        currency: "KWD",
        requested_invoice_ids: [INVOICE_ID],
        provider_invoice_id: "MF-INV-100",
        provider_payment_id: "MF-PAY-100",
        resulting_payment_id: null,
        gateway_connection_id: OLD_CONNECTION_ID,
        credentials_version: 1,
        gateway_response: null,
      },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seedInFlightDatabase();
  const oldConn = makeConnection(OLD_CONNECTION_ID, "mf_old_connection_key", false);
  const newConn = makeConnection(NEW_CONNECTION_ID, "mf_new_active_key", true);

  loadActiveGatewayConnectionMock.mockResolvedValue(newConn);
  loadGatewayConnectionMock.mockImplementation(async (_db: unknown, id: string) => {
    if (id === OLD_CONNECTION_ID) return oldConn;
    if (id === NEW_CONNECTION_ID) return newConn;
    throw new Error(`Unknown connection ${id}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("T138 gateway settlement across paths and connection switches", () => {
  it("records a payment exactly once across webhook (payment.settle), return page, and reconciliation", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            IsSuccess: true,
            Data: {
              Invoice: { Id: "MF-INV-100", Status: "PAID" },
              Transaction: { Status: "SUCCESS", PaymentMethod: "KNET", PaymentId: "MF-PAY-100" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    // 1) Webhook settles via `payment.settle`
    const settleHandler = createInboundHandlers()["payment.settle"]!;
    const first = await settleHandler({
      jobRequestId: "job-1",
      companyId: COMPANY_ID,
      payload: { paymentRequestId: PREQ_ID },
      attempt: 1,
    });
    expect(first).toEqual({
      settled: true,
      alreadyCompleted: false,
      paymentRequestId: PREQ_ID,
    });

    // 2) Return page arrives after webhook
    const returnResult = await (confirmGatewayPayment as any)({
      paymentRequestCode: "PREQ-0000001",
    });
    expect(returnResult).toEqual({ status: "paid", tenantId: TENANT_ID });

    // 3) Reconciliation arrives last
    const reconcileAlreadyCompleted = await settleGatewayPayment(
      {
        eventType: "cron.reconcile",
        invoiceId: "MF-INV-100",
        method: "knet",
        paymentId: "MF-PAY-100",
        providerEventId: "reconcile:PREQ-0000001",
        status: "Paid",
      },
      {},
      { companyId: COMPANY_ID },
    );
    expect(reconcileAlreadyCompleted).toBe(true);

    expect(fake.db!.tables.payments).toHaveLength(1);
    expect(fake.db!.tables.payment_allocations).toHaveLength(1);
    expect(fake.db!.tables.invoices[0].balance).toBe(0);
    expect(fake.db!.tables.payment_requests[0].status).toBe("completed");
  });

  it("settles an in-flight payment on its original connection even after switching active gateway", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          IsSuccess: true,
          Data: {
            Invoice: { Id: "MF-INV-100", Status: "PAID" },
            Transaction: { Status: "SUCCESS", PaymentMethod: "KNET", PaymentId: "MF-PAY-100" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const settleHandler = createInboundHandlers()["payment.settle"]!;
    await settleHandler({
      jobRequestId: "job-2",
      companyId: COMPANY_ID,
      payload: { paymentRequestId: PREQ_ID },
      attempt: 1,
    });

    expect(loadGatewayConnectionMock).toHaveBeenCalledWith(expect.anything(), OLD_CONNECTION_ID);
    expect(loadActiveGatewayConnectionMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect((requestInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer mf_old_connection_key",
    );
  });
});
