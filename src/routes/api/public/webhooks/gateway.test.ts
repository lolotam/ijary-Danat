import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { LoadedGatewayConnection } from "@/gateways/connectionStore.server";
import {
  handleGatewayWebhook,
  type GatewayConnectionLookup,
} from "@/routes/api/public/webhooks/$provider.$connectionId";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const WEBHOOK_SECRET = "whsec_test_company_a";

/** يبني اتصال ماي فاتورة محمّلاً بالسر للاختبار. */
function makeLoadedConnection(
  overrides: Partial<LoadedGatewayConnection> = {},
): LoadedGatewayConnection {
  return {
    id: CONNECTION_ID,
    companyId: COMPANY_ID,
    provider: "myfatoorah",
    mode: "test",
    isActive: true,
    credentialsVersion: 1,
    connection: {
      provider: "myfatoorah",
      mode: "test",
      credentials: {
        apiKey: "mf_test_key",
        webhookSecret: WEBHOOK_SECRET,
      },
      publicConfig: {},
    },
    ...overrides,
  };
}

/** يبني توقيع ماي فاتورة الصحيح لحدث PAYMENT_STATUS_CHANGED. */
function signMyFatoorahPayload(
  fields: {
    invoiceId: string;
    invoiceStatus: string;
    paymentId: string;
    transactionStatus: string;
  },
  secret: string,
): string {
  const canonical = [
    `Invoice.Id=${fields.invoiceId}`,
    `Invoice.Status=${fields.invoiceStatus}`,
    `Transaction.Status=${fields.transactionStatus}`,
    `Transaction.PaymentId=${fields.paymentId}`,
    `Invoice.ExternalIdentifier=`,
  ].join(",");
  return createHmac("sha256", secret).update(canonical, "utf8").digest("base64");
}

/** يبني عميل قاعدة بيانات وهمي لتسجيل صفوف `webhook_events` وكشف التكرار. */
function createFakeWebhookDb(opts: { duplicate?: boolean } = {}) {
  const insertedRows: Array<Record<string, unknown>> = [];

  const db = {
    from: vi.fn((table: string) => {
      if (table !== "webhook_events") {
        throw new Error(`Unexpected table: ${table}`);
      }
      return {
        insert: vi.fn((row: Record<string, unknown>) => {
          if (opts.duplicate) {
            return {
              select: () => ({
                single: async () => ({
                  data: null,
                  error: { code: "23505", message: "duplicate key value" },
                }),
              }),
              then: (resolve: (v: unknown) => unknown) =>
                resolve({ data: null, error: { code: "23505", message: "duplicate key value" } }),
            };
          }
          const saved = { id: "33333333-3333-4333-8333-333333333333", ...row };
          insertedRows.push(saved);
          return {
            select: () => ({
              single: async () => ({ data: { id: saved.id }, error: null }),
            }),
            then: (resolve: (v: unknown) => unknown) => resolve({ data: saved, error: null }),
          };
        }),
      };
    }),
  };

  return { db, insertedRows };
}

/** يبني طلب HTTP وارد إلى مسار الويب هوك. */
function makeRequest(body: unknown, signature?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== undefined) {
    headers["myfatoorah-signature"] = signature;
  }
  return new Request(`https://app.ijary.test/api/public/webhooks/myfatoorah/${CONNECTION_ID}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const VALID_PAYLOAD = {
  Event: { Name: "PAYMENT_STATUS_CHANGED", Reference: "WH-990011" },
  Data: {
    Invoice: { Id: "9001", Status: "PAID", Reference: "REF-1" },
    Transaction: { Status: "SUCCESS", PaymentId: "PAY-9001", PaymentMethod: "KNET" },
  },
};

describe("T137 per-connection gateway webhook route", () => {
  it.each([
    {
      name: "unknown provider returns 404",
      provider: "unknown_gw",
      connectionId: CONNECTION_ID,
      lookup: async () => ({ companyId: COMPANY_ID, provider: "myfatoorah" as const }),
    },
    {
      name: "non-uuid connectionId returns 404",
      provider: "myfatoorah",
      connectionId: "not-a-uuid",
      lookup: async () => ({ companyId: COMPANY_ID, provider: "myfatoorah" as const }),
    },
    {
      name: "unknown connection returns 404 without company detail",
      provider: "myfatoorah",
      connectionId: CONNECTION_ID,
      lookup: async () => null,
    },
    {
      name: "mismatched provider for connection returns 404",
      provider: "myfatoorah",
      connectionId: CONNECTION_ID,
      lookup: async (): Promise<GatewayConnectionLookup> => ({
        companyId: COMPANY_ID,
        provider: "tap",
      }),
    },
  ])("$name", async ({ provider, connectionId, lookup }) => {
    const { db, insertedRows } = createFakeWebhookDb();
    const enqueueWebhookJob = vi.fn();

    const response = await handleGatewayWebhook(
      makeRequest(VALID_PAYLOAD, "any-sig"),
      { provider, connectionId },
      {
        lookupConnection: lookup,
        createDb: () => db as never,
        enqueueWebhookJob,
      },
    );

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json).toEqual({ error: "Not found." });
    expect(insertedRows).toHaveLength(0);
    expect(enqueueWebhookJob).not.toHaveBeenCalled();
  });

  it("stores a bad signature without claiming the event id, and enqueues nothing", async () => {
    const { db, insertedRows } = createFakeWebhookDb();
    const enqueueWebhookJob = vi.fn();

    const response = await handleGatewayWebhook(
      makeRequest(VALID_PAYLOAD, "invalid-signature-value"),
      { provider: "myfatoorah", connectionId: CONNECTION_ID },
      {
        lookupConnection: async () => ({ companyId: COMPANY_ID, provider: "myfatoorah" }),
        loadConnection: async () => makeLoadedConnection(),
        createDb: () => db as never,
        enqueueWebhookJob,
      },
    );

    expect(response.status).toBe(401);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      company_id: COMPANY_ID,
      connection_id: CONNECTION_ID,
      provider: "myfatoorah",
      provider_event_id: null,
      signature_valid: false,
      result: "invalid_signature",
      processed: true,
      // T201 F2: an unverified body is attacker-controlled and never stored.
      raw_payload: null,
    });
    expect(enqueueWebhookJob).not.toHaveBeenCalled();
  });

  it("returns 200 and enqueues nothing on duplicate provider event id", async () => {
    const { db } = createFakeWebhookDb({ duplicate: true });
    const enqueueWebhookJob = vi.fn();
    const signature = signMyFatoorahPayload(
      {
        invoiceId: "9001",
        invoiceStatus: "PAID",
        paymentId: "PAY-9001",
        transactionStatus: "SUCCESS",
      },
      WEBHOOK_SECRET,
    );

    const response = await handleGatewayWebhook(
      makeRequest(VALID_PAYLOAD, signature),
      { provider: "myfatoorah", connectionId: CONNECTION_ID },
      {
        lookupConnection: async () => ({ companyId: COMPANY_ID, provider: "myfatoorah" }),
        loadConnection: async () => makeLoadedConnection(),
        createDb: () => db as never,
        enqueueWebhookJob,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, replay: true });
    expect(enqueueWebhookJob).not.toHaveBeenCalled();
  });

  it("stores valid new event and enqueues webhook.process", async () => {
    const { db, insertedRows } = createFakeWebhookDb();
    const enqueueWebhookJob = vi.fn().mockResolvedValue({ jobId: "job-1" });
    const signature = signMyFatoorahPayload(
      {
        invoiceId: "9001",
        invoiceStatus: "PAID",
        paymentId: "PAY-9001",
        transactionStatus: "SUCCESS",
      },
      WEBHOOK_SECRET,
    );

    const response = await handleGatewayWebhook(
      makeRequest(VALID_PAYLOAD, signature),
      { provider: "myfatoorah", connectionId: CONNECTION_ID },
      {
        lookupConnection: async () => ({ companyId: COMPANY_ID, provider: "myfatoorah" }),
        loadConnection: async () => makeLoadedConnection(),
        createDb: () => db as never,
        enqueueWebhookJob,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      company_id: COMPANY_ID,
      connection_id: CONNECTION_ID,
      provider: "myfatoorah",
      provider_event_id: "WH-990011",
      signature_valid: true,
      result: "queued",
      processed: false,
    });
    expect(enqueueWebhookJob).toHaveBeenCalledTimes(1);
    expect(enqueueWebhookJob).toHaveBeenCalledWith(db, "33333333-3333-4333-8333-333333333333");
  });
});
