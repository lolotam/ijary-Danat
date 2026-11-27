import { beforeEach, describe, expect, it, vi } from "vitest";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const PREQ_ID = "33333333-3333-4333-8333-333333333333";
const WEBHOOK_EVENT_ID = "44444444-4444-4444-8444-444444444444";

const companyClientMock = vi.hoisted(() => vi.fn());
const loadGatewayConnectionMock = vi.hoisted(() => vi.fn());
const enqueueJobMock = vi.hoisted(() => vi.fn());
const settleGatewayPaymentMock = vi.hoisted(() => vi.fn());
const findPaymentRequestMock = vi.hoisted(() => vi.fn());

vi.mock("@/company/companyClient.server", () => ({
  companyClient: (...args: unknown[]) => companyClientMock(...args),
}));

vi.mock("@/gateways/connectionStore.server", () => ({
  loadGatewayConnection: (...args: unknown[]) => loadGatewayConnectionMock(...args),
}));

vi.mock("@/jobs/enqueue", () => ({
  enqueueJob: (...args: unknown[]) => enqueueJobMock(...args),
}));

vi.mock("@/fns/gatewaySettlement", () => ({
  settleGatewayPayment: (...args: unknown[]) => settleGatewayPaymentMock(...args),
}));

vi.mock("@/fns/gatewaySettlementReads", async () => {
  const actual = await vi.importActual<typeof import("@/fns/gatewaySettlementReads")>(
    "@/fns/gatewaySettlementReads",
  );
  return {
    ...actual,
    findPaymentRequest: (...args: unknown[]) => findPaymentRequestMock(...args),
  };
});

import { createInboundHandlers } from "@/jobs/handlers/inbound";

function buildDb(opts: {
  webhookEvent?: Record<string, unknown> | null;
  paymentRequest?: Record<string, unknown> | null;
}) {
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
  const db = {
    from: vi.fn((table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data:
                table === "webhook_events"
                  ? (opts.webhookEvent ?? null)
                  : (opts.paymentRequest ?? null),
              error: null,
            }),
          }),
        }),
      }),
      update: (values: Record<string, unknown>) => ({
        eq: async () => {
          updates.push({ table, values });
          return { error: null };
        },
      }),
    })),
  };
  return { db, updates };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadGatewayConnectionMock.mockResolvedValue({
    id: CONNECTION_ID,
    companyId: COMPANY_ID,
    provider: "myfatoorah",
    mode: "test",
    isActive: false,
    credentialsVersion: 1,
    connection: {
      provider: "myfatoorah",
      mode: "test",
      credentials: { apiKey: "mf_key_old", webhookSecret: "whsec" },
      publicConfig: {},
    },
  });
});

describe("inbound job handlers (webhook.process & payment.settle)", () => {
  it("webhook.process ignores unconsumed events without enqueuing payment.settle", async () => {
    const { db, updates } = buildDb({
      webhookEvent: {
        id: WEBHOOK_EVENT_ID,
        company_id: COMPANY_ID,
        connection_id: CONNECTION_ID,
        provider: "myfatoorah",
        signature_valid: true,
        processed: false,
        raw_payload: {
          Event: { Name: "RECURRING_STATUS_CHANGED", Reference: "WH-1" },
          Data: {},
        },
      },
    });
    companyClientMock.mockReturnValue(db);

    const handler = createInboundHandlers()["webhook.process"]!;
    const result = await handler({
      jobRequestId: "job-req-1",
      companyId: COMPANY_ID,
      payload: { webhookEventId: WEBHOOK_EVENT_ID },
      attempt: 1,
    });

    expect(companyClientMock).toHaveBeenCalledWith(COMPANY_ID, { allowSuspended: true });
    expect(result).toEqual({ ok: true, ignored: true, reason: "event_not_consumed" });
    expect(updates).toContainEqual({
      table: "webhook_events",
      values: { processed: true, result: "ignored" },
    });
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });

  it("webhook.process enqueues payment.settle for a paid event", async () => {
    const { db, updates } = buildDb({
      webhookEvent: {
        id: WEBHOOK_EVENT_ID,
        company_id: COMPANY_ID,
        connection_id: CONNECTION_ID,
        provider: "myfatoorah",
        signature_valid: true,
        processed: false,
        raw_payload: {
          Event: { Name: "PAYMENT_STATUS_CHANGED", Reference: "WH-2" },
          Data: {
            Invoice: { Id: "9001", Status: "PAID" },
            Transaction: { Status: "SUCCESS", PaymentId: "PAY-9001", PaymentMethod: "KNET" },
          },
        },
      },
    });
    companyClientMock.mockReturnValue(db);
    findPaymentRequestMock.mockResolvedValue({ id: PREQ_ID, status: "pending" });
    enqueueJobMock.mockResolvedValue({ jobId: "settle-job-1" });

    const handler = createInboundHandlers()["webhook.process"]!;
    const result = await handler({
      jobRequestId: "job-req-2",
      companyId: COMPANY_ID,
      payload: { webhookEventId: WEBHOOK_EVENT_ID },
      attempt: 1,
    });

    expect(enqueueJobMock).toHaveBeenCalledWith(
      db,
      "payment.settle",
      { paymentRequestId: PREQ_ID },
      { dedupeKey: `payment.settle:${PREQ_ID}` },
    );
    expect(updates).toContainEqual({
      table: "webhook_events",
      values: { processed: true, result: "completed" },
    });
    expect(result).toEqual({
      ok: true,
      paymentRequestId: PREQ_ID,
      settlementJobId: "settle-job-1",
    });
  });

  it("payment.settle refuses legacy unbound payment requests without falling back to env", async () => {
    const { db } = buildDb({
      paymentRequest: {
        id: PREQ_ID,
        code: "PREQ-0000001",
        status: "pending",
        gateway_connection_id: null,
        provider_invoice_id: "9001",
        provider_payment_id: null,
      },
    });
    companyClientMock.mockReturnValue(db);

    const handler = createInboundHandlers()["payment.settle"]!;
    await expect(
      handler({
        jobRequestId: "job-req-3",
        companyId: COMPANY_ID,
        payload: { paymentRequestId: PREQ_ID },
        attempt: 1,
      }),
    ).rejects.toThrow("LEGACY_UNBOUND_PAYMENT_REQUEST");
    expect(loadGatewayConnectionMock).not.toHaveBeenCalled();
  });
});
