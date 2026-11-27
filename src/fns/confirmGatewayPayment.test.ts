import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, settleGatewayPaymentMock, adminMaybeSingle, loadGatewayConnectionMock } =
  vi.hoisted(() => ({
    fetchMock: vi.fn(),
    settleGatewayPaymentMock: vi.fn().mockResolvedValue(undefined),
    adminMaybeSingle: vi.fn(),
    loadGatewayConnectionMock: vi.fn(),
  }));

// Mock createServerFn before importing the module under test
vi.mock("@tanstack/react-start", () => {
  const fn: any = (data: any) => fn._handler({ data, context: fn._context });
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.inputValidator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((h: any) => {
    fn._handler = h;
    return fn;
  });
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middlewareFn: any) => middlewareFn),
    }),
  };
});

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: vi.fn(),
}));

vi.mock("@/company/companyClient.server", () => {
  const chainable = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    single: vi.fn().mockReturnThis(),
    maybeSingle: adminMaybeSingle,
    rpc: vi.fn().mockReturnThis(),
  };
  return { companyClient: () => chainable };
});

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: "company-1",
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
}));

vi.mock("@/gateways/connectionStore.server", () => ({
  loadGatewayConnection: (...args: unknown[]) => loadGatewayConnectionMock(...args),
}));

vi.mock("./myfatoorahWebhook", async () => {
  const actual = await vi.importActual<typeof import("./myfatoorahWebhook")>("./myfatoorahWebhook");
  return { ...actual, settleGatewayPayment: settleGatewayPaymentMock };
});

vi.mock("./notifyPaymentSuccess", () => ({
  notifyPaymentSuccess: vi.fn().mockResolvedValue({ ok: true, skipped: true, ids: [] }),
}));

import { confirmGatewayPayment } from "./confirmGatewayPayment";

const mockTenantId = "11111111-1111-1111-1111-111111111111";
const mockProfile = { tenant_id: mockTenantId, id: "user-1" };

function buildContext(profile: { tenant_id: string | null } | null, canCreatePaymentLink = false) {
  return {
    userId: "user-1",
    supabase: {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "profiles") {
          return {
            select: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve({ data: profile ? { ...profile } : null, error: null }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }),
          }),
        };
      }),
      rpc: vi.fn().mockResolvedValue({ data: canCreatePaymentLink, error: null }),
    },
  };
}

function runHandler(
  data: { paymentId?: string; paymentRequestCode?: string },
  profile: { tenant_id: string | null } | null = mockProfile,
  canCreatePaymentLink = false,
) {
  (confirmGatewayPayment as any)._context = buildContext(profile, canCreatePaymentLink);
  return (confirmGatewayPayment as any)._handler({
    data,
    context: (confirmGatewayPayment as any)._context,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function boundPaymentRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "preq-1",
    code: "PREQ-0000001",
    tenant_id: mockTenantId,
    gateway_connection_id: "conn-1",
    credentials_version: 1,
    provider_invoice_id: "987654",
    provider_payment_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  settleGatewayPaymentMock.mockClear();
  adminMaybeSingle.mockReset();
  loadGatewayConnectionMock.mockReset().mockResolvedValue({
    id: "conn-1",
    companyId: "company-1",
    provider: "myfatoorah",
    mode: "test",
    isActive: true,
    credentialsVersion: 1,
    connection: {
      provider: "myfatoorah",
      mode: "test",
      credentials: { apiKey: "test-key" },
      publicConfig: {},
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("confirmGatewayPayment — sandbox-safe status lookup", () => {
  it("prefers GET /v3/payments/{paymentId} when the nested hosted-page shape is returned", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        IsSuccess: true,
        Data: {
          Invoice: { Id: "987654", Status: "PAID" },
          Transaction: {
            Status: "SUCCESS",
            PaymentMethod: "KNET",
            PaymentId: "MF-PAY-1",
          },
        },
      }),
    );

    adminMaybeSingle.mockResolvedValueOnce({ data: boundPaymentRequest(), error: null });

    const result = await runHandler({ paymentId: "MF-PAY-1" });

    expect(result).toEqual({ status: "paid", tenantId: mockTenantId });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://apitest.myfatoorah.com/v3/payments/MF-PAY-1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settleGatewayPaymentMock).toHaveBeenCalledTimes(1);
    const [details] = settleGatewayPaymentMock.mock.calls[0];
    expect(details).toMatchObject({
      eventType: "callback.inquiry",
      invoiceId: "987654",
      method: "knet",
      paymentId: "MF-PAY-1",
      status: "PAID",
    });
  });

  it("falls back to POST /v2/GetPaymentStatus when v3 is unavailable (apitest)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse("Not Found", 404)).mockResolvedValueOnce(
      jsonResponse({
        IsSuccess: true,
        Data: {
          InvoiceId: 987654,
          InvoiceStatus: "Paid",
          InvoiceTransactions: [
            {
              TransactionStatus: "Succss",
              PaymentGateway: "KNET",
              PaymentId: "MF-PAY-1",
            },
          ],
        },
      }),
    );
    adminMaybeSingle.mockResolvedValueOnce({ data: boundPaymentRequest(), error: null });

    const result = await runHandler({ paymentId: "MF-PAY-1" });

    expect(result).toEqual({ status: "paid", tenantId: mockTenantId });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://apitest.myfatoorah.com/v2/GetPaymentStatus",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ Key: "MF-PAY-1", KeyType: "PaymentId" }),
      }),
    );
    expect(settleGatewayPaymentMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to KeyType InvoiceId when PaymentId inquiry fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse("Not Found", 404))
      .mockResolvedValueOnce(jsonResponse("no match", 400))
      .mockResolvedValueOnce(
        jsonResponse({
          IsSuccess: true,
          Data: {
            InvoiceId: 6990573,
            InvoiceStatus: "Paid",
            InvoiceTransactions: [
              {
                TransactionStatus: "Succss",
                PaymentGateway: "KNET",
                PaymentId: "100620210000000064",
              },
            ],
          },
        }),
      );
    adminMaybeSingle.mockResolvedValueOnce({
      data: boundPaymentRequest({ provider_invoice_id: "6990573" }),
      error: null,
    });

    const result = await runHandler({ paymentId: "6990573" });

    expect(result).toEqual({ status: "paid", tenantId: mockTenantId });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://apitest.myfatoorah.com/v2/GetPaymentStatus",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ Key: "6990573", KeyType: "PaymentId" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://apitest.myfatoorah.com/v2/GetPaymentStatus",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ Key: "6990573", KeyType: "InvoiceId" }),
      }),
    );
    expect(settleGatewayPaymentMock).toHaveBeenCalledTimes(1);
  });

  it("recovers a corrupted payment ID through its payment request code", async () => {
    const corruptedPaymentId = "100620210000016000";
    fetchMock
      .mockResolvedValueOnce(jsonResponse("Invalid data", 400))
      .mockResolvedValueOnce(jsonResponse("no match", 400))
      .mockResolvedValueOnce(
        jsonResponse({
          IsSuccess: true,
          Data: {
            InvoiceId: 6995259,
            InvoiceStatus: "Paid",
            InvoiceTransactions: [
              {
                TransactionStatus: "Succss",
                PaymentGateway: "KNET",
                PaymentId: "100620210000016004",
              },
            ],
          },
        }),
      );
    adminMaybeSingle.mockResolvedValueOnce({
      data: boundPaymentRequest({
        provider_invoice_id: "6995259",
        code: "PREQ-0000006",
      }),
      error: null,
    });

    const result = await runHandler({
      paymentId: corruptedPaymentId,
      paymentRequestCode: "PREQ-0000006",
    });

    expect(result).toEqual({ status: "paid", tenantId: mockTenantId });
    expect(settleGatewayPaymentMock).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "100620210000016004" }),
      expect.anything(),
      { companyId: "company-1" },
    );
  });

  it("never calls the non-existent POST /v3/GetPaymentStatus on the test API", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse("Not Found", 404)).mockResolvedValueOnce(
      jsonResponse({
        IsSuccess: true,
        Data: {
          InvoiceId: 987654,
          InvoiceStatus: "Paid",
          InvoiceTransactions: [
            { TransactionStatus: "Succss", PaymentGateway: "VISA/MASTER", PaymentId: "MF-PAY-3" },
          ],
        },
      }),
    );
    adminMaybeSingle.mockResolvedValueOnce({ data: boundPaymentRequest(), error: null });

    await runHandler({ paymentId: "MF-PAY-3" });

    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("/v3/GetPaymentStatus");
    }
    expect(String(fetchMock.mock.calls[1][0])).toContain("/v2/GetPaymentStatus");
  });

  it("does not settle when the paid payment id belongs to another invoice", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        IsSuccess: true,
        Data: {
          Invoice: { Id: "555000", Status: "PAID" },
          Transaction: { Status: "SUCCESS", PaymentMethod: "KNET", PaymentId: "MF-OTHER" },
        },
      }),
    );
    adminMaybeSingle.mockResolvedValueOnce({ data: boundPaymentRequest(), error: null });

    const result = await runHandler({ paymentId: "MF-OTHER" });

    expect(result).toEqual({ status: "pending", tenantId: mockTenantId });
    expect(settleGatewayPaymentMock).not.toHaveBeenCalled();
  });

  it("returns {status:'pending'} without settling when the gateway reports a non-paid invoice", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        IsSuccess: true,
        Data: {
          Invoice: { Id: "987654", Status: "Pending" },
          Transaction: { Status: "Pending", PaymentMethod: "KNET", PaymentId: "MF-PAY-2" },
        },
      }),
    );
    adminMaybeSingle.mockResolvedValueOnce({
      data: boundPaymentRequest(),
      error: null,
    });

    const result = await runHandler({ paymentId: "MF-PAY-2" });
    expect(result).toEqual({ status: "pending", tenantId: mockTenantId });
    expect(settleGatewayPaymentMock).not.toHaveBeenCalled();
  });

  it("defaults method to card when the gateway omits PaymentGateway/PaymentMethod", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse("skip v3", 404)).mockResolvedValueOnce(
      jsonResponse({
        IsSuccess: true,
        Data: {
          InvoiceId: 987654,
          InvoiceStatus: "Paid",
          InvoiceTransactions: [{ TransactionStatus: "Succss", PaymentId: "MF-PAY-4" }],
        },
      }),
    );
    adminMaybeSingle.mockResolvedValueOnce({ data: boundPaymentRequest(), error: null });

    await runHandler({ paymentId: "MF-PAY-4" });
    expect(settleGatewayPaymentMock.mock.calls[0][0].method).toBe("card");
  });

  it("logs the v2 decline reason and code when the gateway reports a failed transaction", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(jsonResponse("skip v3", 404)).mockResolvedValueOnce(
      jsonResponse({
        IsSuccess: true,
        Data: {
          InvoiceId: 7039145,
          InvoiceStatus: "Pending",
          InvoiceTransactions: [
            {
              TransactionStatus: "Failed",
              PaymentGateway: "KNET",
              PaymentId: "07077039145371097673",
              Error: "IPAY0100044-Problem occured while loading payment page.",
              ErrorCode: "MF020",
            },
          ],
        },
      }),
    );
    adminMaybeSingle.mockResolvedValueOnce({ data: boundPaymentRequest(), error: null });

    const result = await runHandler({ paymentId: "07077039145371097673" });

    expect(result).toEqual({ status: "failed", tenantId: mockTenantId });
    expect(settleGatewayPaymentMock).not.toHaveBeenCalled();
    const logged = warn.mock.calls.map((call) => call.join(" ")).join(" ");
    expect(logged).toContain("MF020: IPAY0100044-Problem occured while loading payment page.");
    expect(logged).toContain("07077039145371097673");
    warn.mockRestore();
  });

  it("logs the nested v3 {Code,Message} decline shape", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        IsSuccess: true,
        Data: {
          Invoice: { Id: "7039145", Status: "PENDING" },
          Transaction: {
            Status: "FAILED",
            PaymentMethod: "KNET",
            PaymentId: "07077039145371097673",
            Error: {
              Code: "MF020",
              Message: "IPAY0100044-Problem occured while loading payment page.",
            },
          },
        },
      }),
    );
    adminMaybeSingle.mockResolvedValueOnce({ data: boundPaymentRequest(), error: null });

    const result = await runHandler({ paymentId: "07077039145371097673" });

    expect(result).toEqual({ status: "failed", tenantId: mockTenantId });
    const logged = warn.mock.calls.map((call) => call.join(" ")).join(" ");
    expect(logged).toContain("MF020: IPAY0100044-Problem occured while loading payment page.");
    warn.mockRestore();
  });

  it("still logs a non-paid outcome when the gateway supplies no error detail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(jsonResponse("skip v3", 404)).mockResolvedValueOnce(
      jsonResponse({
        IsSuccess: true,
        Data: {
          InvoiceId: 7031735,
          InvoiceStatus: "Pending",
          InvoiceTransactions: [
            { TransactionStatus: "InProgress", PaymentGateway: "KNET", PaymentId: "MF-PAY-9" },
          ],
        },
      }),
    );
    adminMaybeSingle.mockResolvedValueOnce({ data: boundPaymentRequest(), error: null });

    const result = await runHandler({ paymentId: "MF-PAY-9" });

    expect(result).toEqual({ status: "pending", tenantId: mockTenantId });
    const logged = warn.mock.calls.map((call) => call.join(" ")).join(" ");
    expect(logged).toContain("pending");
    warn.mockRestore();
  });

  it("settles a paid callback for staff authorized to create payment links", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        IsSuccess: true,
        Data: {
          Invoice: { Id: "987654", Status: "PAID" },
          Transaction: {
            Status: "SUCCESS",
            PaymentMethod: "KNET",
            PaymentId: "MF-PAY-STAFF",
          },
        },
      }),
    );
    adminMaybeSingle.mockResolvedValueOnce({ data: boundPaymentRequest(), error: null });

    const result = await runHandler({ paymentId: "MF-PAY-STAFF" }, { tenant_id: null }, true);

    expect(result).toEqual({ status: "paid", tenantId: mockTenantId });
    expect(settleGatewayPaymentMock).toHaveBeenCalledTimes(1);
  });

  it("rejects staff without payment-link permission before settlement", async () => {
    adminMaybeSingle.mockResolvedValueOnce({ data: boundPaymentRequest(), error: null });

    // An `Error`, never a `Response`: TanStack Start resolves a thrown
    // `Response` client-side, which used to turn this refusal into a
    // success-shaped result with `status: 403` (the blank-callback-page bug).
    const denial = runHandler({ paymentId: "MF-PAY-FORBIDDEN" }, { tenant_id: null });
    await expect(denial).rejects.toBeInstanceOf(Error);
    await expect(denial).rejects.not.toBeInstanceOf(Response);
    await expect(denial).rejects.toThrow("This payment belongs to another tenant's account.");
    expect(settleGatewayPaymentMock).not.toHaveBeenCalled();
  });

  it("records the refused confirmation in the audit trail against the payment's tenant", async () => {
    adminMaybeSingle.mockResolvedValueOnce({ data: boundPaymentRequest(), error: null });

    await expect(runHandler({ paymentId: "MF-PAY-AUDIT" }, { tenant_id: null })).rejects.toThrow(
      "This payment belongs to another tenant's account.",
    );
    const { rpc } = (confirmGatewayPayment as any)._context.supabase;
    expect(rpc).toHaveBeenCalledWith(
      "write_audit",
      expect.objectContaining({
        p_entity_type: "tenant",
        p_entity_id: mockTenantId,
        p_after: { attempted: "payment.confirm_gateway", permission: "payment_links.create" },
      }),
    );
  });

  it("refuses legacy unbound payment requests without falling back to env", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    adminMaybeSingle.mockResolvedValueOnce({
      data: boundPaymentRequest({ gateway_connection_id: null }),
      error: null,
    });

    await expect(runHandler({ paymentId: "MF-PAY-LEGACY" })).rejects.toThrow(
      "LEGACY_UNBOUND_PAYMENT_REQUEST",
    );
    expect(loadGatewayConnectionMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("rethrows the settlement Error instead of resolving when settlement fails after a paid charge", async () => {
    const settleFailure = new Error("Invoice PREQ-0000006 has no remaining balance to settle.");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        IsSuccess: true,
        Data: {
          Invoice: { Id: "987654", Status: "PAID" },
          Transaction: {
            Status: "SUCCESS",
            PaymentMethod: "KNET",
            PaymentId: "MF-PAY-SETTLE-FAIL",
          },
        },
      }),
    );
    adminMaybeSingle.mockResolvedValueOnce({ data: boundPaymentRequest(), error: null });
    settleGatewayPaymentMock.mockRejectedValueOnce(settleFailure);

    const confirmation = runHandler({ paymentId: "MF-PAY-SETTLE-FAIL" });
    await expect(confirmation).rejects.toBe(settleFailure);
    await expect(confirmation).rejects.not.toBeInstanceOf(Response);
    const logText = logged.mock.calls.map((call) => call.join(" ")).join(" ");
    expect(logText).toContain("settle failed");
    expect(logText).toContain(settleFailure.message);
    logged.mockRestore();
  });
});
