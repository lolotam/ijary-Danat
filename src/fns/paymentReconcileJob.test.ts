import { beforeEach, describe, expect, it, vi } from "vitest";

const pendingRequests = vi.fn();
const updateRequest = vi.fn();
const rpc = vi.fn();
const fetchGatewayPaymentStatus = vi.fn();
const settleGatewayPayment = vi.fn();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      // Pending rows are windowed by created_at; superseded rows are not.
      select: () => ({
        eq: (_column: string, status: string) =>
          status === "pending"
            ? { not: () => ({ gt: () => ({ order: () => pendingRequests() }) }) }
            : { not: () => ({ order: async () => ({ data: [], error: null }) }) },
      }),
      update: (values: unknown) => ({
        eq: (_c: string, id: string) => ({ eq: () => updateRequest(values, id) }),
      }),
    }),
    rpc: (name: string, args: unknown) => rpc(name, args),
  },
}));
vi.mock("@/fns/myfatoorahGateway", () => ({
  gatewayConfigFromEnv: () => ({ apiKey: "k", baseUrl: "https://apitest.myfatoorah.com" }),
}));
vi.mock("@/fns/confirmGatewayPayment", async () => {
  const actual =
    await vi.importActual<typeof import("./confirmGatewayPayment")>("./confirmGatewayPayment");
  return {
    paymentOutcome: actual.paymentOutcome,
    fetchGatewayPaymentStatus: (...a: unknown[]) => fetchGatewayPaymentStatus(...a),
  };
});
// normalizeMethod must come from the real module: the job imports it from here
// too, and a mock that omits it would make the job import `undefined` and throw
// at call time rather than at import time — a failure that looks like a logic bug.
vi.mock("@/fns/myfatoorahWebhook", async () => {
  const actual = await vi.importActual<typeof import("./myfatoorahWebhook")>("./myfatoorahWebhook");
  return {
    normalizeMethod: actual.normalizeMethod,
    settleGatewayPayment: (...a: unknown[]) => settleGatewayPayment(...a),
  };
});

const { runPaymentReconcileJob } = await import("./paymentReconcileJob");

function request(code: string, providerInvoiceId: string) {
  return { id: `id-${code}`, code, provider_invoice_id: providerInvoiceId, status: "pending" };
}

function gatewayStatus(invoiceStatus: string, transactionStatus: string) {
  return {
    error: null,
    invoiceId: "7050025",
    invoiceStatus,
    methodRaw: "KNET",
    providerPaymentId: "100621810000012471",
    raw: {},
    transactionStatus,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  updateRequest.mockResolvedValue({ error: null });
  settleGatewayPayment.mockResolvedValue(false);
});

describe("runPaymentReconcileJob", () => {
  it("settles a pending request the gateway reports paid", async () => {
    pendingRequests.mockResolvedValue({ data: [request("PREQ-0000001", "7050025")], error: null });
    fetchGatewayPaymentStatus.mockResolvedValue(gatewayStatus("Paid", "Success"));

    const result = await runPaymentReconcileJob();

    expect(result).toMatchObject({ count: 1, settled: 1, failed: 0 });
    expect(settleGatewayPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "cron.reconcile",
        method: "knet",
        providerEventId: "reconcile:PREQ-0000001",
      }),
      expect.anything(),
    );
  });

  it("marks a failed charge failed so it stops being polled", async () => {
    pendingRequests.mockResolvedValue({ data: [request("PREQ-0000002", "7050057")], error: null });
    fetchGatewayPaymentStatus.mockResolvedValue(gatewayStatus("Pending", "Failed"));

    const result = await runPaymentReconcileJob();

    expect(result).toMatchObject({ count: 1, settled: 0, failed: 1 });
    expect(updateRequest).toHaveBeenCalledWith({ status: "failed" }, "id-PREQ-0000002");
    expect(settleGatewayPayment).not.toHaveBeenCalled();
  });

  it("leaves a still-pending charge untouched", async () => {
    pendingRequests.mockResolvedValue({ data: [request("PREQ-0000003", "7050059")], error: null });
    fetchGatewayPaymentStatus.mockResolvedValue(gatewayStatus("Pending", "Pending"));

    const result = await runPaymentReconcileJob();

    expect(result).toMatchObject({ count: 1, settled: 0, failed: 0 });
    expect(updateRequest).not.toHaveBeenCalled();
    expect(settleGatewayPayment).not.toHaveBeenCalled();
  });

  it("keeps going when one request throws", async () => {
    pendingRequests.mockResolvedValue({
      data: [request("PREQ-0000001", "7050025"), request("PREQ-0000002", "7050057")],
      error: null,
    });
    fetchGatewayPaymentStatus
      .mockRejectedValueOnce(new Error("gateway timeout"))
      .mockResolvedValueOnce(gatewayStatus("Paid", "Success"));

    const result = await runPaymentReconcileJob();

    expect(result.settled).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("PREQ-0000001");
  });
});
