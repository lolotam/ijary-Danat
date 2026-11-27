import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GatewayConnectionError,
  type LoadedGatewayConnection,
} from "@/gateways/connectionStore.server";
import type { GatewayPaymentStatus } from "@/gateways/types";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CONN_A = "33333333-3333-4333-8333-333333333333";
const CONN_DELETED = "44444444-4444-4444-8444-444444444444";

const companyClientMock = vi.fn();
const pendingRequests = vi.fn();
const supersededRequests = vi.fn();
const updateRequest = vi.fn();
const rpc = vi.fn();
const loadGatewayConnectionMock = vi.fn();
const loadActiveGatewayConnectionMock = vi.fn();
const getPaymentStatusMock = vi.fn();
const settleGatewayPayment = vi.fn();

vi.mock("@/company/companyClient.server", () => ({
  companyClient: (companyId: string, opts?: unknown) => {
    companyClientMock(companyId, opts);
    return {
      from: () => ({
        select: () => {
          const filters: Record<string, unknown> = {};
          const chain: Record<string, unknown> = {
            eq: (column: string, value: unknown) => {
              filters[column] = value;
              return chain;
            },
            not: () => chain,
            gt: () => chain,
            order: () =>
              filters.status === "pending"
                ? pendingRequests(filters.company_id)
                : supersededRequests(filters.company_id),
          };
          return chain;
        },
        update: (values: unknown) => ({
          eq: (_c: string, id: string) => ({ eq: () => updateRequest(values, id) }),
        }),
      }),
      rpc: (name: string, args: unknown) => rpc(name, args),
    };
  },
}));

vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => ({
    id: COMPANY_A,
    slug: "company-a",
    status: "active",
    host: "a.localhost",
  }),
  requireRequestCompany: () => ({
    id: COMPANY_A,
    slug: "company-a",
    status: "active",
    host: "a.localhost",
  }),
  runWithRequestCompany: (_company: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/gateways/connectionStore.server", async () => {
  const actual = await vi.importActual<typeof import("@/gateways/connectionStore.server")>(
    "@/gateways/connectionStore.server",
  );
  return {
    GatewayConnectionError: actual.GatewayConnectionError,
    loadGatewayConnection: (...args: unknown[]) => loadGatewayConnectionMock(...args),
    loadActiveGatewayConnection: (...args: unknown[]) => loadActiveGatewayConnectionMock(...args),
  };
});

vi.mock("@/gateways/registry", () => ({
  gatewayRegistry: {
    create: () => ({
      getPaymentStatus: (...args: unknown[]) => getPaymentStatusMock(...args),
    }),
  },
}));

vi.mock("@/fns/gatewaySettlement", () => ({
  settleGatewayPayment: (...args: unknown[]) => settleGatewayPayment(...args),
}));

const { runPaymentReconcileJob } = await import("./paymentReconcileJob");

function makeConnection(id: string, companyId: string, isActive = true): LoadedGatewayConnection {
  return {
    id,
    companyId,
    provider: "myfatoorah",
    mode: "test",
    isActive,
    credentialsVersion: 1,
    connection: {
      provider: "myfatoorah",
      mode: "test",
      credentials: { apiKey: `key-${id}`, webhookSecret: "whsec" },
      publicConfig: {},
    },
  };
}

function request(code: string, providerInvoiceId: string, connectionId: string | null = CONN_A) {
  return {
    id: `id-${code}`,
    code,
    provider_invoice_id: providerInvoiceId,
    provider_payment_id: null,
    gateway_connection_id: connectionId,
    status: "pending",
  };
}

function gatewayStatus(outcome: GatewayPaymentStatus["outcome"]): GatewayPaymentStatus {
  return {
    outcome,
    method: "knet",
    providerInvoiceId: "7050025",
    providerPaymentId: "100621810000012471",
    error: outcome === "failed" ? "Declined" : null,
    raw: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  updateRequest.mockResolvedValue({ error: null });
  supersededRequests.mockResolvedValue({ data: [], error: null });
  settleGatewayPayment.mockResolvedValue(false);
  loadGatewayConnectionMock.mockResolvedValue(makeConnection(CONN_A, COMPANY_A, false));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runPaymentReconcileJob", () => {
  it("settles a pending request on its recorded connection when the gateway reports paid", async () => {
    pendingRequests.mockResolvedValue({
      data: [request("PREQ-0000001", "7050025", CONN_A)],
      error: null,
    });
    getPaymentStatusMock.mockResolvedValue(gatewayStatus("paid"));

    const result = await runPaymentReconcileJob(null, COMPANY_A);

    expect(result).toMatchObject({ count: 1, settled: 1, failed: 0, skipped: 0 });
    expect(companyClientMock).toHaveBeenCalledWith(COMPANY_A, { allowSuspended: true });
    expect(loadGatewayConnectionMock).toHaveBeenCalledWith(expect.anything(), CONN_A);
    expect(loadActiveGatewayConnectionMock).not.toHaveBeenCalled();
    expect(settleGatewayPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "cron.reconcile",
        method: "knet",
        providerEventId: "reconcile:PREQ-0000001",
      }),
      expect.anything(),
      { companyId: COMPANY_A },
    );
  });

  it("scopes queries to the explicit companyId argument rather than another company", async () => {
    loadGatewayConnectionMock.mockResolvedValue(makeConnection(CONN_A, COMPANY_B, true));
    pendingRequests.mockImplementation(async (companyId: string) => ({
      data: companyId === COMPANY_B ? [request("PREQ-0000099", "7050099", CONN_A)] : [],
      error: null,
    }));
    getPaymentStatusMock.mockResolvedValue(gatewayStatus("paid"));

    const result = await runPaymentReconcileJob(null, COMPANY_B);

    expect(companyClientMock).toHaveBeenCalledWith(COMPANY_B, { allowSuspended: true });
    expect(pendingRequests).toHaveBeenCalledWith(COMPANY_B);
    expect(supersededRequests).toHaveBeenCalledWith(COMPANY_B);
    expect(result).toMatchObject({ count: 1, settled: 1, failed: 0, skipped: 0 });
    expect(settleGatewayPayment).toHaveBeenCalledWith(
      expect.objectContaining({ providerEventId: "reconcile:PREQ-0000099" }),
      expect.anything(),
      { companyId: COMPANY_B },
    );
  });

  it("skips a request whose recorded connection was deleted and leaves it pending", async () => {
    pendingRequests.mockResolvedValue({
      data: [request("PREQ-0000010", "7050010", CONN_DELETED)],
      error: null,
    });
    loadGatewayConnectionMock.mockRejectedValue(
      new GatewayConnectionError("CONNECTION_NOT_FOUND", "Gone"),
    );

    const result = await runPaymentReconcileJob(null, COMPANY_A);

    expect(result).toMatchObject({ count: 1, settled: 0, failed: 0, skipped: 1 });
    expect(result.errors[0]).toContain("PREQ-0000010");
    expect(updateRequest).not.toHaveBeenCalled();
    expect(settleGatewayPayment).not.toHaveBeenCalled();
    expect(loadActiveGatewayConnectionMock).not.toHaveBeenCalled();
  });

  it("skips a request with no gateway_connection_id and leaves it pending", async () => {
    pendingRequests.mockResolvedValue({
      data: [request("PREQ-0000011", "7050011", null)],
      error: null,
    });

    const result = await runPaymentReconcileJob(null, COMPANY_A);

    expect(result).toMatchObject({ count: 1, settled: 0, failed: 0, skipped: 1 });
    expect(result.errors[0]).toContain("PREQ-0000011");
    expect(updateRequest).not.toHaveBeenCalled();
    expect(settleGatewayPayment).not.toHaveBeenCalled();
  });

  it("marks a failed charge failed so it stops being polled", async () => {
    pendingRequests.mockResolvedValue({
      data: [request("PREQ-0000002", "7050057", CONN_A)],
      error: null,
    });
    getPaymentStatusMock.mockResolvedValue(gatewayStatus("failed"));

    const result = await runPaymentReconcileJob(null, COMPANY_A);

    expect(result).toMatchObject({ count: 1, settled: 0, failed: 1, skipped: 0 });
    expect(updateRequest).toHaveBeenCalledWith({ status: "failed" }, "id-PREQ-0000002");
    expect(settleGatewayPayment).not.toHaveBeenCalled();
  });

  it("leaves a still-pending charge untouched", async () => {
    pendingRequests.mockResolvedValue({
      data: [request("PREQ-0000003", "7050059", CONN_A)],
      error: null,
    });
    getPaymentStatusMock.mockResolvedValue(gatewayStatus("pending"));

    const result = await runPaymentReconcileJob(null, COMPANY_A);

    expect(result).toMatchObject({ count: 1, settled: 0, failed: 0, skipped: 0 });
    expect(updateRequest).not.toHaveBeenCalled();
    expect(settleGatewayPayment).not.toHaveBeenCalled();
  });

  it("keeps going when one request throws", async () => {
    pendingRequests.mockResolvedValue({
      data: [
        request("PREQ-0000001", "7050025", CONN_A),
        request("PREQ-0000002", "7050057", CONN_A),
      ],
      error: null,
    });
    getPaymentStatusMock
      .mockRejectedValueOnce(new Error("gateway timeout"))
      .mockResolvedValueOnce(gatewayStatus("paid"));

    const result = await runPaymentReconcileJob(null, COMPANY_A);

    expect(result.settled).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("PREQ-0000001");
  });
});
