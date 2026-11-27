/**
 * اختبارات صفحة عودة الدفع الخالية من الجلسة والمقيّدة بالشركة (T147).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoadedGatewayConnection } from "@/gateways/connectionStore.server";
import type { GatewayPaymentStatus } from "@/gateways/types";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CONN_A = "33333333-3333-4333-8333-333333333333";

const requestCompanyState = vi.hoisted(() => ({
  company: {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "company-a",
    status: "active" as const,
    host: "a.localhost",
  } as { id: string; slug: string; status: "active"; host: string } | null,
}));

const paymentRequestsTable = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    code: string;
    company_id: string;
    provider_invoice_id: string | null;
    provider_payment_id: string | null;
    gateway_connection_id: string | null;
    credentials_version?: number | null;
    status: string;
  }>,
}));

const companyClientMock = vi.fn();
const loadGatewayConnectionMock = vi.fn();
const getPaymentStatusMock = vi.fn();
const settleGatewayPaymentMock = vi.fn();

vi.mock("@tanstack/react-start", () => {
  const fn: any = (arg: { data: unknown } | unknown) => {
    const data =
      arg && typeof arg === "object" && "data" in arg ? (arg as { data: unknown }).data : arg;
    return fn._handler({ data });
  };
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.inputValidator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((h: unknown) => {
    fn._handler = h;
    return fn;
  });
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
  };
});

vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => requestCompanyState.company,
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: (companyId: string, opts?: unknown) => {
    companyClientMock(companyId, opts);
    return {
      from: () => ({
        select: () => {
          const filters: Record<string, unknown> = {};
          const chain: Record<string, unknown> = {
            eq: (col: string, val: unknown) => {
              filters[col] = val;
              return chain;
            },
            maybeSingle: async () => ({
              data:
                paymentRequestsTable.rows.find(
                  (r) =>
                    r.code === filters.code &&
                    r.company_id === filters.company_id &&
                    r.company_id === companyId,
                ) ?? null,
              error: null,
            }),
          };
          return chain;
        },
      }),
    };
  },
}));

vi.mock("@/gateways/connectionStore.server", () => ({
  loadGatewayConnection: (...args: unknown[]) => loadGatewayConnectionMock(...args),
}));

vi.mock("@/gateways/registry", () => ({
  gatewayRegistry: {
    create: () => ({
      getPaymentStatus: (...args: unknown[]) => getPaymentStatusMock(...args),
    }),
  },
}));

vi.mock("@/fns/gatewaySettlement", () => ({
  settleGatewayPayment: (...args: unknown[]) => settleGatewayPaymentMock(...args),
}));

const { confirmPaymentReturnPage } = await import("@/fns/paymentReturnPage");
const { loadPaymentReturnState } = await import("@/fns/paymentReturnPage.server");

function makeConnection(): LoadedGatewayConnection {
  return {
    id: CONN_A,
    companyId: COMPANY_A,
    provider: "myfatoorah",
    mode: "test",
    isActive: true,
    credentialsVersion: 1,
    connection: {
      provider: "myfatoorah",
      mode: "test",
      credentials: { apiKey: "key-a", webhookSecret: "whsec" },
      publicConfig: {},
    },
  };
}

/** حالة بوابة مدفوعة لفاتورة مزوّد معيّنة. */
function paidStatusFor(providerInvoiceId: string): GatewayPaymentStatus {
  return {
    outcome: "paid",
    method: "knet",
    providerInvoiceId,
    providerPaymentId: "MF-PAY-1",
    error: null,
    raw: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requestCompanyState.company = {
    id: COMPANY_A,
    slug: "company-a",
    status: "active",
    host: "a.localhost",
  };
  paymentRequestsTable.rows = [
    {
      id: "preq-a-1",
      code: "PREQ-0000001",
      company_id: COMPANY_A,
      provider_invoice_id: "MF-INV-1",
      provider_payment_id: "MF-PAY-1",
      gateway_connection_id: CONN_A,
      credentials_version: 2,
      status: "pending",
    },
    {
      id: "preq-b-1",
      code: "PREQ-0000002",
      company_id: COMPANY_B,
      provider_invoice_id: "MF-INV-2",
      provider_payment_id: "MF-PAY-2",
      gateway_connection_id: CONN_A,
      status: "pending",
    },
  ];
  loadGatewayConnectionMock.mockResolvedValue(makeConnection());
  settleGatewayPaymentMock.mockResolvedValue(false);
});

describe("paymentReturnPage (session-free, company-bound)", () => {
  it("refuses another company's $preq with the exact same not_found state as a missing one", async () => {
    const otherCompanyResult = await loadPaymentReturnState({
      preq: "PREQ-0000002",
      paymentId: "MF-PAY-2",
    });
    const missingResult = await loadPaymentReturnState({
      preq: "PREQ-9999999",
      paymentId: "MF-PAY-9",
    });

    expect(otherCompanyResult).toEqual({ status: "not_found" });
    expect(missingResult).toEqual({ status: "not_found" });
    expect(otherCompanyResult).toEqual(missingResult);
    expect(getPaymentStatusMock).not.toHaveBeenCalled();
    expect(settleGatewayPaymentMock).not.toHaveBeenCalled();
  });

  it("returns not_found when no company is resolved from the request host", async () => {
    requestCompanyState.company = null;

    const result = await loadPaymentReturnState({ preq: "PREQ-0000001", paymentId: "MF-PAY-1" });

    expect(result).toEqual({ status: "not_found" });
    expect(companyClientMock).not.toHaveBeenCalled();
  });

  it("settles on the recorded connection and returns paid when the gateway confirms payment", async () => {
    const paidStatus: GatewayPaymentStatus = {
      outcome: "paid",
      method: "knet",
      providerInvoiceId: "MF-INV-1",
      providerPaymentId: "MF-PAY-1",
      error: null,
      raw: { ok: true },
    };
    getPaymentStatusMock.mockResolvedValue(paidStatus);

    const result = await confirmPaymentReturnPage({
      data: { paymentRequestCode: "PREQ-0000001", paymentId: "MF-PAY-1" },
    });

    expect(result).toEqual({ status: "paid", code: "PREQ-0000001" });
    expect(companyClientMock).toHaveBeenCalledWith(COMPANY_A, { allowSuspended: true });
    expect(loadGatewayConnectionMock).toHaveBeenCalledWith(expect.anything(), CONN_A, {
      credentialsVersion: 2,
    });
    expect(getPaymentStatusMock).toHaveBeenCalledWith({
      providerPaymentId: "MF-PAY-1",
      providerInvoiceId: null,
    });
    expect(settleGatewayPaymentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "callback.inquiry",
        invoiceId: "MF-INV-1",
        method: "knet",
        paymentId: "MF-PAY-1",
        providerEventId: "inquiry:MF-PAY-1",
      }),
      { ok: true },
      { companyId: COMPANY_A },
    );
  });

  it.each<[GatewayPaymentStatus["outcome"], "pending" | "failed"]>([
    ["pending", "pending"],
    ["failed", "failed"],
  ])("returns %s without settling when the gateway reports %s", async (outcome, expected) => {
    getPaymentStatusMock.mockResolvedValue({
      outcome,
      method: null,
      providerInvoiceId: "MF-INV-1",
      providerPaymentId: "MF-PAY-1",
      error: outcome === "failed" ? "Declined" : null,
      raw: {},
    });

    const result = await loadPaymentReturnState({ preq: "PREQ-0000001", paymentId: "MF-PAY-1" });

    expect(result).toEqual({ status: expected, code: "PREQ-0000001" });
    expect(settleGatewayPaymentMock).not.toHaveBeenCalled();
  });

  it("returns paid without settling again when the request is already completed", async () => {
    paymentRequestsTable.rows[0].status = "completed";
    getPaymentStatusMock.mockResolvedValue(paidStatusFor("MF-INV-1"));

    const result = await loadPaymentReturnState({ preq: "PREQ-0000001", paymentId: "MF-PAY-1" });

    expect(result).toEqual({ status: "paid", code: "PREQ-0000001" });
    expect(settleGatewayPaymentMock).not.toHaveBeenCalled();
  });

  // Security review 2026-11-27: PREQ codes are sequential, so an anonymous
  // caller must not learn a request's status or trigger a gateway call from
  // the code alone.
  it("reveals nothing and calls nothing when the redirect carries no gateway payment id", async () => {
    const result = await loadPaymentReturnState({ preq: "PREQ-0000001" });

    expect(result).toEqual({ status: "not_found" });
    expect(companyClientMock).not.toHaveBeenCalled();
    expect(getPaymentStatusMock).not.toHaveBeenCalled();
  });

  it("treats a payment id that belongs to another gateway invoice as not found", async () => {
    getPaymentStatusMock.mockResolvedValue(paidStatusFor("MF-INV-OTHER"));

    const result = await loadPaymentReturnState({ preq: "PREQ-0000001", paymentId: "MF-PAY-X" });

    expect(result).toEqual({ status: "not_found" });
    expect(settleGatewayPaymentMock).not.toHaveBeenCalled();
  });
});
