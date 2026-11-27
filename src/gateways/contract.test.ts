import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GATEWAY_FACTORIES } from "./registry";
import type { GatewayConnection, GatewayProvider, GatewayWebhookEvent } from "./types";
import type { Json } from "@/integrations/supabase/database.types";

/*
 * عقد المحولات: مجموعة واحدة تشترك فيها كل بوابة، تُشغَّل على كل محول مسجّل.
 *
 * The suite knows nothing about MyFatoorah's wire format: each provider brings
 * its own fixtures, and the assertions below are the same for all of them.
 */

/** ما يحتاجه العقد من مزوّد بعينه: عناوينه وأجسامه وأجوبته. */
interface ContractFixture {
  /** مسار إنشاء الدفعة المستضافة. */
  createPath: string;
  /** مسار اختبار الاتصال. */
  testPath: string;
  /** اسم ترويسة توقيع الويب هوك. */
  signatureHeader: string;
  /** سر الاتصال المستعمل في التوقيع. */
  secret: string;
  /** جسم الويب هوك الخام كما يرسله المزوّد. */
  webhookBody: string;
  /** النص الذي يوقّعه المزوّد على ذلك الجسم. */
  webhookCanonical: string;
  /** جسم الرد على إنشاء الدفعة. */
  createResponse: Json;
  /** معرّف الفاتورة كما يعيده المزوّد في رد الإنشاء. */
  expectedInvoiceId: string;
  /** أجسام الرد على استعلام الحالة بحسب نتيجتها. */
  statusResponses: Record<"paid" | "failed" | "pending", Json>;
  /** جسم الرد على اختبار الاتصال. */
  testResponse: Json;
  /** المسار داخل جسم الطلب الذي يحمل المبلغ. */
  amountPath: string[];
  /** المسار داخل جسم الطلب الذي يحمل مرجع طلب الدفع. */
  referencePath: string[];
  /** الحدث المتوقّع بعد تحويل جسم الويب هوك الخام. */
  expectedEvent: GatewayWebhookEvent;
}

/** بيانات عقد ماي فاتورة. */
const MYFATOORAH_FIXTURE: ContractFixture = {
  createPath: "/v3/payments",
  testPath: "/v3/payment-methods",
  signatureHeader: "myfatoorah-signature",
  secret: "contract-secret",
  webhookBody: JSON.stringify({
    Event: { Name: "PAYMENT_STATUS_CHANGED", Reference: "WH-1" },
    Data: {
      Invoice: { Id: "INV-1", Status: "PAID" },
      Transaction: { Status: "SUCCESS", PaymentMethod: "KNET", PaymentId: "PAY-1" },
    },
  }),
  webhookCanonical:
    "Invoice.Id=INV-1,Invoice.Status=PAID,Transaction.Status=SUCCESS,Transaction.PaymentId=PAY-1,Invoice.ExternalIdentifier=",
  createResponse: {
    IsSuccess: true,
    Data: { InvoiceId: "6309730", PaymentURL: "https://demo.myfatoorah.com/pay/1" },
  },
  expectedInvoiceId: "6309730",
  statusResponses: {
    paid: {
      IsSuccess: true,
      Data: {
        Invoice: { Id: "INV-1", Status: "PAID" },
        Transaction: { Status: "SUCCESS", PaymentMethod: "KNET", PaymentId: "PAY-1" },
      },
    },
    failed: {
      IsSuccess: true,
      Data: {
        Invoice: { Id: "INV-1", Status: "FAILED" },
        Transaction: {
          Status: "FAILED",
          PaymentMethod: "VISA/MASTER",
          PaymentId: "PAY-1",
          Error: { Code: "MF020", Message: "declined" },
        },
      },
    },
    pending: {
      IsSuccess: true,
      Data: {
        Invoice: { Id: "INV-1", Status: "PENDING" },
        Transaction: { Status: "PENDING", PaymentMethod: "KNET", PaymentId: "PAY-1" },
      },
    },
  },
  testResponse: {
    IsSuccess: true,
    Data: { PaymentMethods: [{ ApiName: "KNET" }] },
  },
  amountPath: ["Order", "Amount"],
  referencePath: ["Customer", "Reference"],
  expectedEvent: {
    eventType: "PAYMENT_STATUS_CHANGED",
    invoiceId: "INV-1",
    method: "knet",
    paymentId: "PAY-1",
    providerEventId: "WH-1",
    status: "PAID",
  },
};

/** الحالات المطبّعة التي يفرّق بينها العقد. */
const STATUS_CASES = [
  { statusCase: "paid", expected: "paid" },
  { statusCase: "failed", expected: "failed" },
  { statusCase: "pending", expected: "pending" },
] as const;

/** بيانات كل مزوّد مسجّل؛ مزوّد بلا بيانات يسقط العقد بصوت عالٍ. */
const CONTRACT_FIXTURES: Partial<Record<GatewayProvider, ContractFixture>> = {
  myfatoorah: MYFATOORAH_FIXTURE,
};

/** يقرأ بيانات العقد لمزوّد مسجّل. */
function contractFixture(provider: string): ContractFixture {
  const fixture = CONTRACT_FIXTURES[provider as GatewayProvider];
  if (!fixture) {
    throw new Error(`No contract fixture for the gateway provider: ${provider}`);
  }
  return fixture;
}

/** يبني اتصال الشركة الذي يمرّره العقد لكل محول. */
function connectionFor(provider: GatewayProvider): GatewayConnection {
  return {
    provider,
    mode: "test",
    credentials: { apiKey: "contract-api-key" },
    publicConfig: { enabledMethods: ["knet"] },
  };
}

/** يبني رداً وهمياً كأنه من شبكة HTTP. */
function jsonResponse(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** يوقّع نصاً بمفتاح كما يفعل المزوّد (HMAC-SHA256 بترميز base64). */
function providerSignature(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical).digest("base64");
}

/** يقرأ قيمة من جسم JSON عبر مسار متداخل. */
function valueAtPath(body: unknown, path: string[]): unknown {
  let cursor = body;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * يثبّت بديلاً للشبكة يجيب من بيانات العقد: الشبكة هي الحدّ الخارجي الوحيد
 * الذي يُحاكى، ولا يُحاكى أي مساعد داخلي.
 */
function stubGatewayNetwork(fixture: ContractFixture, statusResponse: Json) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith(fixture.createPath)) {
      return jsonResponse(fixture.createResponse);
    }
    if (url.endsWith(fixture.testPath)) {
      return jsonResponse(fixture.testResponse);
    }
    return jsonResponse(statusResponse);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe.each(Object.entries(GATEWAY_FACTORIES))("%s adapter contract", (provider, factory) => {
  const fixture = contractFixture(provider);

  /** يبني المحول من المصنع المسجّل لهذا المزوّد. */
  function buildGateway() {
    if (!factory) {
      throw new Error(`No adapter factory is registered for the gateway provider: ${provider}`);
    }
    return factory(connectionFor(provider as GatewayProvider));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a hosted payment through the provider's create endpoint", async () => {
    const fetchMock = stubGatewayNetwork(fixture, fixture.statusResponses.paid);

    const created = await buildGateway().createPayment({
      amount: 10,
      paymentRequestCode: "PREQ-1",
      redirectUrl: "https://app.test/portal/payments/callback/PREQ-1",
      customerName: "Renter",
      customerReference: "tenant-1",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(fixture.createPath);
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(valueAtPath(body, fixture.referencePath)).toBe("PREQ-1");
    expect(created.paymentUrl).toBeTruthy();
    expect(created.providerInvoiceId).toBe(fixture.expectedInvoiceId);
    expect(created.requestPayload).toEqual(body);
    expect(created.gatewayResponse).toEqual(fixture.createResponse);
  });

  it.each([
    { amount: 12.3456, expected: 12.346 },
    { amount: 10, expected: 10 },
    { amount: 0.001, expected: 0.001 },
  ])("sends the amount $amount as $expected", async ({ amount, expected }) => {
    const fetchMock = stubGatewayNetwork(fixture, fixture.statusResponses.paid);

    await buildGateway().createPayment({
      amount,
      paymentRequestCode: "PREQ-1",
      redirectUrl: "https://app.test/portal/payments/callback/PREQ-1",
      customerName: "Renter",
      customerReference: "tenant-1",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(valueAtPath(body, fixture.amountPath)).toBe(expected);
  });

  it.each(STATUS_CASES)(
    "maps a $statusCase provider status to $expected",
    async ({ statusCase, expected }) => {
      stubGatewayNetwork(fixture, fixture.statusResponses[statusCase]);

      const status = await buildGateway().getPaymentStatus({
        providerInvoiceId: "INV-1",
        providerPaymentId: "PAY-1",
      });

      expect(status.outcome).toBe(expected);
    },
  );

  it("accepts a webhook signature the provider produced", async () => {
    const result = await buildGateway().verifyWebhook({
      rawBody: fixture.webhookBody,
      headers: {
        [fixture.signatureHeader]: providerSignature(fixture.secret, fixture.webhookCanonical),
      },
      url: "https://app.test/api/public/webhooks/provider/1",
      secret: fixture.secret,
    });

    expect(result).toEqual({ valid: true });
  });

  it("rejects a webhook signature made with another secret", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await buildGateway().verifyWebhook({
      rawBody: fixture.webhookBody,
      headers: {
        [fixture.signatureHeader]: providerSignature("another-secret", fixture.webhookCanonical),
      },
      url: "https://app.test/api/public/webhooks/provider/1",
      secret: fixture.secret,
    });

    expect(result).toEqual({ valid: false });
  });

  it("rejects a webhook that carries no signature at all", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await buildGateway().verifyWebhook({
      rawBody: fixture.webhookBody,
      headers: {},
      url: "https://app.test/api/public/webhooks/provider/1",
      secret: fixture.secret,
    });

    expect(result).toEqual({ valid: false });
  });

  it("turns the raw webhook body into the normalised event", async () => {
    const event = await buildGateway().parseWebhook({ rawBody: fixture.webhookBody });

    expect(event).toEqual(fixture.expectedEvent);
  });

  it("reports a working connection when the provider answers", async () => {
    stubGatewayNetwork(fixture, fixture.statusResponses.paid);

    const result = await buildGateway().testConnection();

    expect(result.ok).toBe(true);
  });

  it("reports a failing connection when the provider refuses the credentials", async () => {
    stubGatewayNetwork(
      { ...fixture, testResponse: { IsSuccess: false, Message: "Invalid API key." } },
      fixture.statusResponses.paid,
    );

    const result = await buildGateway().testConnection();

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Invalid API key.");
  });
});
