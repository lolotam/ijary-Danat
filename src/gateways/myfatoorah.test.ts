import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMyFatoorahGateway } from "./myfatoorah";
import type { GatewayConnection } from "./types";

/*
 * اختبارات محول ماي فاتورة: صيغة المزوّد وحدها، لا سلوك الواجهة الموحّدة
 * (ذلك في `contract.test.ts`).
 */

/** الرد الذي تجيب به البوابة على إنشاء دفعة. */
const CREATE_RESPONSE = {
  IsSuccess: true,
  Data: { InvoiceId: "6309730", PaymentURL: "https://demo.myfatoorah.com/pay/1" },
};

/** جسم ويب هوك كما يرسله المزوّد، والنص الذي يوقّع عليه. */
const WEBHOOK_BODY = JSON.stringify({
  Event: { Name: "PAYMENT_STATUS_CHANGED", Reference: "WH-1" },
  Data: {
    Invoice: { Id: "INV-1", Status: "PAID" },
    Transaction: { Status: "SUCCESS", PaymentMethod: "KNET", PaymentId: "PAY-1" },
  },
});
const WEBHOOK_CANONICAL =
  "Invoice.Id=INV-1,Invoice.Status=PAID,Transaction.Status=SUCCESS,Transaction.PaymentId=PAY-1,Invoice.ExternalIdentifier=";
const WEBHOOK_SECRET = "webhook-secret";

/** يبني رداً وهمياً كأنه من شبكة HTTP. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** يوقّع نصاً بمفتاح كما يفعل المزوّد (HMAC-SHA256 بترميز base64). */
function providerSignature(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical).digest("base64");
}

/** يبني اتصال شركة بمفتاح وهمي. */
function connection(overrides: Partial<GatewayConnection> = {}): GatewayConnection {
  return {
    provider: "myfatoorah",
    mode: "test",
    credentials: { apiKey: "connection-key" },
    publicConfig: {},
    ...overrides,
  };
}

/** مدخلات إنشاء دفعة صالحة للاختبار. */
const CREATE_INPUT = {
  amount: 12.3456,
  paymentRequestCode: "PREQ-1",
  redirectUrl: "https://app.test/portal/payments/callback/PREQ-1",
  customerName: "Renter",
  customerReference: "tenant-1",
};

describe("createMyFatoorahGateway", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalEnv = process.env;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("sends the hosted-page request with the provider's own field names", async () => {
    fetchMock.mockResolvedValue(jsonResponse(CREATE_RESPONSE));

    const created = await createMyFatoorahGateway(connection()).createPayment({
      ...CREATE_INPUT,
      method: "knet",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://apitest.myfatoorah.com/v3/payments");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer connection-key");
    expect(JSON.parse(String(init.body))).toEqual({
      NotificationOption: "LINK",
      Order: { Amount: 12.346, Currency: "KWD" },
      Customer: { Name: "Renter", Reference: "PREQ-1" },
      IntegrationUrls: { Redirection: "https://app.test/portal/payments/callback/PREQ-1" },
      UserDefinedField: "tenant-1",
      PaymentMethod: "KNET",
    });
    expect(created.paymentUrl).toBe("https://demo.myfatoorah.com/pay/1");
    expect(created.providerInvoiceId).toBe("6309730");
  });

  // MyFatoorah reads an ABSENT PaymentMethod as "show every enabled method",
  // so pinning no method must leave the key out of the body entirely.
  it("omits the payment method when the caller pinned none", async () => {
    fetchMock.mockResolvedValue(jsonResponse(CREATE_RESPONSE));

    await createMyFatoorahGateway(connection()).createPayment(CREATE_INPUT);

    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).not.toHaveProperty("PaymentMethod");
  });

  it("talks to the live host only in live mode", async () => {
    fetchMock.mockResolvedValue(jsonResponse(CREATE_RESPONSE));

    await createMyFatoorahGateway(connection({ mode: "live" })).createPayment(CREATE_INPUT);

    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.myfatoorah.com/v3/payments");
  });

  // The per-company adapter must never fall back to the platform's env key:
  // two companies on two accounts would otherwise share one credential.
  it("authenticates with the connection's key, not the environment's", async () => {
    process.env.MYFATOORAH_API_KEY = "environment-key";
    fetchMock.mockResolvedValue(jsonResponse(CREATE_RESPONSE));

    await createMyFatoorahGateway(connection()).createPayment(CREATE_INPUT);

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer connection-key");
  });

  it("refuses to build an adapter for a connection without an API key", () => {
    expect(() => createMyFatoorahGateway(connection({ credentials: {} }))).toThrow(/no API key/);
  });

  it.each([
    { providerMethod: "KNET", expected: "knet" },
    { providerMethod: "APPLE_PAY", expected: "applepay" },
    { providerMethod: "GOOGLE_PAY", expected: "googlepay" },
    { providerMethod: "VISA/MASTER", expected: "card" },
  ])("maps the provider's method $providerMethod to $expected", async (row) => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        IsSuccess: true,
        Data: {
          Invoice: { Id: "INV-1", Status: "PAID" },
          Transaction: { Status: "SUCCESS", PaymentMethod: row.providerMethod, PaymentId: "PAY-1" },
        },
      }),
    );

    const status = await createMyFatoorahGateway(connection()).getPaymentStatus({
      providerInvoiceId: "INV-1",
      providerPaymentId: "PAY-1",
    });

    expect(status.method).toBe(row.expected);
  });

  it.each([
    { invoiceStatus: "PAID", transactionStatus: "SUCCESS", expected: "paid" },
    { invoiceStatus: "FAILED", transactionStatus: "FAILED", expected: "failed" },
    { invoiceStatus: "PENDING", transactionStatus: "PENDING", expected: "pending" },
  ])("classifies $invoiceStatus as $expected", async (row) => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        IsSuccess: true,
        Data: {
          Invoice: { Id: "INV-1", Status: row.invoiceStatus },
          Transaction: { Status: row.transactionStatus, PaymentMethod: "KNET", PaymentId: "PAY-1" },
        },
      }),
    );

    const status = await createMyFatoorahGateway(connection()).getPaymentStatus({
      providerInvoiceId: "INV-1",
      providerPaymentId: "PAY-1",
    });

    expect(status.outcome).toBe(row.expected);
  });

  // The v3 route answers for a PaymentId only; an answer without an invoice
  // must fall through to the v2 route instead of settling nothing.
  it("falls back to the v2 route when the v3 answer carries no invoice", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ IsSuccess: true, Data: { Transaction: { Status: "SUCCESS" } } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          IsSuccess: true,
          Data: {
            InvoiceId: "INV-1",
            InvoiceStatus: "PAID",
            InvoiceTransactions: [
              { TransactionStatus: "SUCCESS", PaymentGateway: "KNET", PaymentId: "PAY-1" },
            ],
          },
        }),
      );

    const status = await createMyFatoorahGateway(connection()).getPaymentStatus({
      providerInvoiceId: "INV-1",
      providerPaymentId: "PAY-1",
    });

    expect(status.outcome).toBe("paid");
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://apitest.myfatoorah.com/v2/GetPaymentStatus",
    );
  });

  it("accepts a signature the provider produced over the canonical string", async () => {
    const result = await createMyFatoorahGateway(connection()).verifyWebhook({
      rawBody: WEBHOOK_BODY,
      headers: {
        "myfatoorah-signature": providerSignature(WEBHOOK_SECRET, WEBHOOK_CANONICAL),
      },
      url: "https://app.test/api/public/webhooks/myfatoorah/1",
      secret: WEBHOOK_SECRET,
    });

    expect(result).toEqual({ valid: true });
  });

  it("rejects a signature made with another secret", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await createMyFatoorahGateway(connection()).verifyWebhook({
      rawBody: WEBHOOK_BODY,
      headers: {
        "myfatoorah-signature": providerSignature("another-secret", WEBHOOK_CANONICAL),
      },
      url: "https://app.test/api/public/webhooks/myfatoorah/1",
      secret: WEBHOOK_SECRET,
    });

    expect(result).toEqual({ valid: false });
    warn.mockRestore();
  });

  it("turns the nested webhook payload into the normalised event", async () => {
    const event = await createMyFatoorahGateway(connection()).parseWebhook({
      rawBody: WEBHOOK_BODY,
    });

    expect(event).toEqual({
      eventType: "PAYMENT_STATUS_CHANGED",
      invoiceId: "INV-1",
      method: "knet",
      paymentId: "PAY-1",
      providerEventId: "WH-1",
      status: "PAID",
    });
  });

  it("reports the account's enabled methods when the connection works", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        IsSuccess: true,
        Data: { PaymentMethods: [{ ApiName: "KNET" }, { ApiName: "CARD" }] },
      }),
    );

    const result = await createMyFatoorahGateway(connection()).testConnection();

    expect(result.ok).toBe(true);
    expect(result.message).toContain("KNET");
  });

  it("reports a refused key instead of throwing", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ IsSuccess: false, Message: "Invalid API key." }));

    const result = await createMyFatoorahGateway(connection()).testConnection();

    expect(result).toEqual({ ok: false, message: "Invalid API key." });
  });
});
