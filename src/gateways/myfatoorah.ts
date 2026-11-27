import { z } from "zod";

import type { GatewayPaymentMethod, Json } from "@/integrations/supabase/database.types";
import { roundToFils } from "@/lib/fils";
import { isRecord, verifySignature } from "@/lib/myfatoorahSignature";

import type {
  CreatedGatewayPayment,
  CreateGatewayPaymentInput,
  GatewayConnection,
  GatewayPaymentStatus,
  GatewayPaymentStatusQuery,
  GatewayTestResult,
  GatewayWebhookEvent,
  PaymentGateway,
  VerifyWebhookInput,
  WebhookVerification,
} from "./types";

/*
 * محول بوابة ماي فاتورة: يحوّل صيغة المزوّد إلى صيغة `PaymentGateway` الموحّدة.
 *
 * The adapter owns the provider's wire format; the callers own storage and
 * settlement (R14). Nothing here reads the environment or the database.
 */

/** رابط خدمة ماي فاتورة في بيئة التشغيل الحيّ. */
const LIVE_BASE_URL = "https://api.myfatoorah.com";
/** رابط خدمة ماي فاتورة في بيئة الاختبار. */
const TEST_BASE_URL = "https://apitest.myfatoorah.com";
/** اسم سر الـ API داخل `company_secrets` (عمود `name`). */
export const MYFATOORAH_API_KEY_CREDENTIAL = "apiKey";
/** الوسائل التي تدعمها صفحة ماي فاتورة المستضافة (حقل `PaymentMethod` في v3). */
const SUPPORTED_METHODS = ["knet", "applepay", "googlepay", "card"] as const;
/** تهجئة الوسائل كما يقبلها المزوّد؛ اسماً غير مطابق يفشل عند المزوّد لا عندنا. */
const PROVIDER_METHOD: Record<GatewayPaymentMethod, string> = {
  applepay: "APPLE_PAY",
  card: "CARD",
  googlepay: "GOOGLE_PAY",
  knet: "KNET",
};

/**
 * A bare `fetch` has no timeout. If MyFatoorah accepts the connection and then
 * never replies, the request hangs for as long as the socket stays open — the
 * server function never returns, and the caller's UI waits forever with nothing
 * to report. Twenty seconds is well past the gateway's normal sub-second
 * response while still bounding the failure.
 */
const GATEWAY_TIMEOUT_MS = 20_000;

/** بيانات الاتصال بماي فاتورة: مفتاح الـ API ورابط الخدمة. */
export interface MyFatoorahConfig {
  apiKey: string;
  baseUrl: string;
}

/** يبني إعدادات الاتصال: المفتاح من الأسرار المفكوكة، ورابط الخدمة من وضع الاتصال
 * — لا من متغيرات البيئة. اتصال بلا مفتاح لا يصل البوابة أصلاً. */
function myfatoorahConfig(connection: GatewayConnection): MyFatoorahConfig {
  const apiKey = connection.credentials[MYFATOORAH_API_KEY_CREDENTIAL]?.trim();
  if (!apiKey) {
    throw new Error("MyFatoorah is not configured: this connection has no API key.");
  }
  const baseUrl = connection.mode === "live" ? LIVE_BASE_URL : TEST_BASE_URL;
  return { apiKey, baseUrl };
}

/**
 * يرسل الطلب إلى ماي فاتورة ويعيد الرد كما هو؛ المهلة وفشل DNS يصلان معاً،
 * فسمِّ أيّهما انتهى.
 */
async function sendGatewayRequest(
  config: MyFatoorahConfig,
  path: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  } catch (error) {
    // A timeout and a DNS failure both arrive here. Name which one, because
    // "MyFatoorah request failed" alone sends the next person to the wrong log.
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `did not respond within ${GATEWAY_TIMEOUT_MS / 1000}s`
        : `could not be reached: ${error instanceof Error ? error.message : String(error)}`;
    throw new Error(`MyFatoorah ${reason}`, { cause: error });
  }
}

/** يقرأ جسم الرد: يفكّ JSON، ويحوّل فشل HTTP إلى خطأ يحمل نص المزوّد. */
async function readGatewayResponse(response: Response): Promise<Json> {
  const responseText = await response.text();
  let responseBody: Json;
  try {
    responseBody = JSON.parse(responseText) as Json;
  } catch {
    responseBody = { message: responseText || response.statusText };
  }
  if (!response.ok) {
    throw new Error(
      `MyFatoorah request failed (${response.status}): ${responseText || response.statusText}`,
    );
  }
  return responseBody;
}

/** يرسل طلب POST إلى ماي فاتورة ويعيد الجسم المُفكَّك. */
export async function postToMyFatoorah(
  config: MyFatoorahConfig,
  path: string,
  payload: Json,
): Promise<Json> {
  return readGatewayResponse(
    await sendGatewayRequest(config, path, { method: "POST", body: JSON.stringify(payload) }),
  );
}

/** يرسل طلب GET إلى ماي فاتورة ويعيد الجسم المُفكَّك. */
export async function getFromMyFatoorah(config: MyFatoorahConfig, path: string): Promise<Json> {
  return readGatewayResponse(await sendGatewayRequest(config, path, { method: "GET" }));
}

/** علم نجاح المزوّد: يرسله نصاً أحياناً ومنطقياً أحياناً. */
const successFlag = z.union([z.boolean(), z.string()]).optional();
/** نص قد يأتي فارغاً أو غائباً. */
const optionalText = z.string().nullish();
/** معرّف يرسله المزوّد نصاً أو رقماً. */
const providerId = z.union([z.string(), z.number()]).nullish();

/**
 * غلاف الرد المشترك لكل مسارات المزوّد: `IsSuccess` و`Message` و`Data`؛
 * الفرق بين المسارات الثلاثة في حقل `Data` وحده.
 */
const providerResponseSchema = z.object({
  IsSuccess: successFlag,
  Message: optionalText,
  Data: z
    .object({
      // The created payment (`POST /v3/payments`) and the invoice status, flat
      // in v2 (`POST /v2/GetPaymentStatus`).
      PaymentURL: z.string().optional(),
      PaymentId: providerId,
      InvoiceId: providerId,
      InvoiceStatus: optionalText,
      InvoiceTransactions: z
        .array(
          z.object({
            TransactionStatus: optionalText,
            PaymentGateway: optionalText,
            PaymentId: optionalText,
            Error: optionalText,
            ErrorCode: optionalText,
          }),
        )
        .optional(),
      // The invoice status, nested in v3 (`GET /v3/payments/{paymentId}`), and
      // the account's enabled methods (`GET /v3/payment-methods`).
      Invoice: z.object({ Id: providerId, Status: optionalText }).optional(),
      Transaction: z
        .object({
          Status: optionalText,
          PaymentMethod: optionalText,
          PaymentId: optionalText,
          Error: z.object({ Code: optionalText, Message: optionalText }).nullish(),
        })
        .optional(),
      PaymentMethods: z.array(z.object({ ApiName: optionalText })).nullish(),
    })
    .optional(),
});

/** يقرأ `IsSuccess` الذي يرسله المزوّد، منطقياً كان أم نصاً. */
function isSuccessFlag(value: boolean | string | undefined): boolean {
  return value !== false && value !== "false";
}

/** يجمع سبب رفض المزوّد لدفعة غير مدفوعة: v2 يعطي `Error` و`ErrorCode` نصّين
 * منفصلين، وv3 يضعهما في `{ Code, Message }`. */
function formatGatewayError(code?: string | null, message?: string | null): string | null {
  const trimmedCode = code?.trim();
  const trimmedMessage = message?.trim();
  if (trimmedCode && trimmedMessage) return `${trimmedCode}: ${trimmedMessage}`;
  return trimmedMessage || trimmedCode || null;
}

/** يحوّل حالتي الفاتورة والمعاملة إلى الحالة المطبّعة؛ و"succss" خطأ المزوّد نفسه
 * لا خطأ هنا. */
function paymentOutcome(
  invoiceStatus: string | null,
  transactionStatus: string | null,
): GatewayPaymentStatus["outcome"] {
  const normalize = (value: string | null) => value?.toLowerCase().replace(/[\s_-]/g, "") ?? "";
  const invoice = normalize(invoiceStatus);
  const transaction = normalize(transactionStatus);
  if (invoice === "paid" || ["success", "succss", "succeeded", "captured"].includes(transaction)) {
    return "paid";
  }
  if (
    ["failed", "canceled", "cancelled", "declined", "expired"].includes(transaction) ||
    ["canceled", "cancelled", "expired"].includes(invoice)
  ) {
    return "failed";
  }
  return "pending";
}

/** يحوّل اسم وسيلة الدفع الذي يسمّيه المزوّد إلى المسمّى الموحّد؛ أي وسيلة مفعّلة
 * على الحساب (VISA/MASTER, MADA, ...) تُحسب بطاقة: المال تحرّك حين نراه. */
function normalizeProviderMethod(value: string | null): GatewayPaymentMethod | null {
  const normalized = value?.toLowerCase().replace(/[\s_-]/g, "") ?? "";
  if (!normalized) return null;
  if (normalized.includes("knet")) return "knet";
  if (normalized.includes("applepay")) return "applepay";
  if (normalized.includes("googlepay")) return "googlepay";
  return "card";
}

/** يبني جسم إنشاء الدفعة بالتقسيط الذي يتوقّعه المزوّد. */
function hostedPaymentPayload(input: CreateGatewayPaymentInput): Json {
  return {
    NotificationOption: "LINK",
    Order: { Amount: roundToFils(input.amount), Currency: "KWD" },
    Customer: { Name: input.customerName, Reference: input.paymentRequestCode },
    IntegrationUrls: { Redirection: input.redirectUrl },
    UserDefinedField: input.customerReference,
    // Spread rather than a plain key. MyFatoorah treats an ABSENT PaymentMethod
    // as "show every enabled method", so the key must not appear at all when
    // no method was requested.
    ...(input.method ? { PaymentMethod: PROVIDER_METHOD[input.method] } : {}),
  };
}

/**
 * ينشئ دفعة مستضافة لدى ماي فاتورة ويعيد رابطها ومعرّفاتها؛ معرّف الدفعة يبقى
 * فارغاً هنا لأن الساكن لم يدفع بعد.
 */
async function createHostedPayment(
  config: MyFatoorahConfig,
  input: CreateGatewayPaymentInput,
): Promise<CreatedGatewayPayment> {
  const requestPayload = hostedPaymentPayload(input);
  const responseBody = await postToMyFatoorah(config, "/v3/payments", requestPayload);
  const created = providerResponseSchema.parse(responseBody);
  if (!created.Data?.PaymentURL || !isSuccessFlag(created.IsSuccess)) {
    throw new Error(created.Message ?? "MyFatoorah did not return a payment URL.");
  }
  return {
    gatewayResponse: responseBody,
    paymentUrl: created.Data.PaymentURL,
    providerInvoiceId: created.Data.InvoiceId?.toString() ?? null,
    providerPaymentId: created.Data.PaymentId?.toString() ?? null,
    requestPayload,
  };
}

/**
 * يفكّ جسم الحالة عند المزوّد ويحوّله إلى الحالة المطبّعة: v2 يُبقي الفاتورة
 * مسطّحة وv3 يتداخلها، وكلاهما يُقرأ هنا ليرى المتصل صيغة واحدة.
 */
function normalizedStatus(body: Json, fallbackPaymentId: string): GatewayPaymentStatus {
  const parsed = providerResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("MyFatoorah payment lookup failed.");
  }
  if (!isSuccessFlag(parsed.data.IsSuccess) || !parsed.data.Data) {
    throw new Error(parsed.data.Message ?? "MyFatoorah payment lookup failed.");
  }
  const invoice = parsed.data.Data;
  const transactions = invoice.InvoiceTransactions ?? [];
  const latest = transactions[transactions.length - 1] ?? null;
  const transaction = invoice.Transaction ?? null;
  return {
    outcome: paymentOutcome(
      invoice.Invoice?.Status ?? invoice.InvoiceStatus ?? null,
      transaction?.Status ?? latest?.TransactionStatus ?? null,
    ),
    method: normalizeProviderMethod(transaction?.PaymentMethod ?? latest?.PaymentGateway ?? null),
    providerInvoiceId: invoice.Invoice?.Id?.toString() ?? invoice.InvoiceId?.toString() ?? null,
    providerPaymentId: transaction?.PaymentId ?? latest?.PaymentId ?? fallbackPaymentId,
    error: transaction?.Error
      ? formatGatewayError(transaction.Error.Code, transaction.Error.Message)
      : formatGatewayError(latest?.ErrorCode, latest?.Error),
    raw: body,
  };
}

/** يقرأ تفاصيل الدفعة من مسار v3 (الشكل المتداخل للصفحة المستضافة). */
async function v3PaymentDetails(
  config: MyFatoorahConfig,
  paymentId: string,
): Promise<GatewayPaymentStatus> {
  const body = await getFromMyFatoorah(config, `/v3/payments/${encodeURIComponent(paymentId)}`);
  const status = normalizedStatus(body, paymentId);
  if (!status.providerInvoiceId) {
    // v3 answers for a PaymentId only; the invoice route below covers the rest.
    throw new Error("MyFatoorah payment details are unavailable.");
  }
  return status;
}

/** يقرأ حالة الدفعة من مسار v2 الكلاسيكي. */
async function v2PaymentStatus(
  config: MyFatoorahConfig,
  key: string,
  keyType: "PaymentId" | "InvoiceId",
): Promise<GatewayPaymentStatus> {
  const body = await postToMyFatoorah(config, "/v2/GetPaymentStatus", {
    Key: key,
    KeyType: keyType,
  });
  return normalizedStatus(body, key);
}

/**
 * يسأل ماي فاتورة عن حالة دفعة: تفاصيل v3 ثم حالة v2 بمعرّف الدفعة ثم حالة v2
 * بمعرّف الفاتورة — بهذا الترتيب تعمل البيئة الحية.
 *
 * Never call POST /v3/GetPaymentStatus — that route 404s on the test API.
 */
async function lookupPaymentStatus(
  config: MyFatoorahConfig,
  query: GatewayPaymentStatusQuery,
): Promise<GatewayPaymentStatus> {
  const paymentId = query.providerPaymentId;
  const invoiceId = query.providerInvoiceId;
  if (paymentId) {
    try {
      return await v3PaymentDetails(config, paymentId);
    } catch {
      // v3 answers for a PaymentId only; the v2 route below covers the rest.
    }
    try {
      return await v2PaymentStatus(config, paymentId, "PaymentId");
    } catch (paymentIdError) {
      if (!invoiceId) throw paymentIdError;
      try {
        return await v2PaymentStatus(config, invoiceId, "InvoiceId");
      } catch {
        // The PaymentId attempt explains the failure better than the invoice one.
        throw paymentIdError;
      }
    }
  }
  if (invoiceId) return v2PaymentStatus(config, invoiceId, "InvoiceId");
  throw new Error("MyFatoorah payment lookup needs an invoice id or a payment id.");
}

/** يفكّ جسم الويب هوك الخام؛ غير الصالح يُقرأ كنص. */
function parseJsonBody(rawBody: string): Json {
  try {
    return JSON.parse(rawBody) as Json;
  } catch {
    return { raw: rawBody };
  }
}
/** يقرأ قيمة نصية من مسار متداخل داخل الحمولة. */
function nestedString(record: Record<string, unknown>, path: string): string | null {
  let cursor: unknown = record;
  for (const segment of path.split(".")) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[segment];
  }
  if (typeof cursor === "string") return cursor.trim() || null;
  if (typeof cursor === "number") return cursor.toString();
  return null;
}
/** يقرأ أول قيمة نصية من قائمة مسارات مفصولة بـ `|`، متجاهلاً الفارغ. */
function firstNestedValue(record: Record<string, unknown>, paths: string): string | null {
  for (const path of paths.split("|")) {
    const value = nestedString(record, path);
    if (value) return value;
  }
  return null;
}

/**
 * مسارات قراءة كل حقل في حمولة ماي فاتورة: المتداخل أولاً ثم المسطّح؛ حمولة v2
 * تتداخل درجة أعمق، وكلا القراءةين محفوظتان.
 */
const FIELD_PATHS = {
  eventType: "Event.Name|EventType|EventName|eventType|event_type|Type",
  invoiceId: "Invoice.Id|InvoiceId|InvoiceID|invoiceId|invoice_id",
  method: "Transaction.PaymentMethod|PaymentMethod|PaymentGateway|PaymentMethodEn|paymentMethod",
  paymentId: "Transaction.PaymentId|PaymentId|PaymentID|paymentId|payment_id",
  status:
    "Invoice.Status|Transaction.Status|InvoiceStatus|TransactionStatus|PaymentStatus|Status|status",
};

/** يحسب بصمة النص حين لا يحمل الحدث معرّفاً خاصاً به. */
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** يحوّل حمولة الويب هوك إلى الحدث المطبّع للتسوية. */
async function webhookEvent(payload: Json, rawBody: string): Promise<GatewayWebhookEvent> {
  const root = isRecord(payload) ? payload : {};
  const nestedValue = root.Data ?? root.data;
  const nestedBody = isRecord(nestedValue) ? nestedValue : root;
  const event = isRecord(root.Event) ? root.Event : {};
  const read = (paths: string) =>
    firstNestedValue(nestedBody, paths) ?? firstNestedValue(root, paths);
  const explicitEventId =
    // `Event.Reference` ("WH-35939205") is MyFatoorah's own per-delivery id and
    // is what makes replay detection exact rather than a hash of the bytes.
    nestedString(event, "Reference") ??
    firstNestedValue(root, "EventId|EventID|eventId|event_id|Id|id") ??
    firstNestedValue(nestedBody, "EventId|EventID|eventId|event_id");
  return {
    eventType: read(FIELD_PATHS.eventType),
    invoiceId: read(FIELD_PATHS.invoiceId),
    method: normalizeProviderMethod(read(FIELD_PATHS.method)),
    paymentId: read(FIELD_PATHS.paymentId),
    providerEventId: explicitEventId ?? (await sha256(rawBody)),
    // Invoice.Status is PAID/…; Transaction.Status is SUCCESS/…. Either alone
    // is enough for the settlement, and the invoice is the money-truth.
    status: read(FIELD_PATHS.status),
  };
}

/**
 * يتحقق من توقيع ويب هوك ماي فاتورة بسر الاتصال.
 *
 * The expected signature is deliberately not logged: printing it would turn the
 * endpoint into a forgery oracle — anyone able to read the logs could read back
 * the signature a payload needs, and settle an invoice without the secret.
 */
async function verifyWebhookSignature(input: VerifyWebhookInput): Promise<WebhookVerification> {
  const payload = parseJsonBody(input.rawBody);
  const suppliedSignature =
    input.headers["myfatoorah-signature"] ??
    input.headers["x-myfatoorah-signature"] ??
    input.headers["authorization"] ??
    null;
  const check = await verifySignature(payload, suppliedSignature, input.secret);
  if (!check.valid) {
    const reason = check.canonical === null ? "unsupported_event_type" : "signature_mismatch";
    console.warn(
      "[myfatoorahGateway] signature rejected",
      // The supplied value can be the raw `Authorization` header, so only its
      // presence is logged, never the value itself.
      JSON.stringify({ reason, canonical: check.canonical, supplied: suppliedSignature !== null }),
    );
  }
  return { valid: check.valid };
}

/**
 * يختبر بيانات الاتصال بطلب خفيف لا يغيّر شيئاً لدى المزوّد:
 * `GET /v3/payment-methods` قائمة قراءة للوسائل المفعّلة على الحساب.
 *
 * A failure is reported as a result, not thrown — the settings screen shows
 * this message, so it must survive a refused key.
 */
async function testMyFatoorahConnection(config: MyFatoorahConfig): Promise<GatewayTestResult> {
  try {
    const body = await getFromMyFatoorah(config, "/v3/payment-methods");
    const parsed = providerResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, message: "MyFatoorah returned an unexpected answer." };
    }
    if (!isSuccessFlag(parsed.data.IsSuccess)) {
      return { ok: false, message: parsed.data.Message ?? "MyFatoorah refused the connection." };
    }
    const enabled = (parsed.data.Data?.PaymentMethods ?? []).flatMap(
      (method) => method.ApiName ?? [],
    );
    return {
      ok: true,
      message: `MyFatoorah responded successfully. Enabled methods: ${enabled.join(", ") || "none reported"}.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "MyFatoorah connection test failed.",
    };
  }
}

/**
 * يبني محول ماي فاتورة لاتصال واحد بأسراره المفكوكة؛ لا شيء يُقرأ من البيئة
 * فلا تتشارك شركتان على حسابين مفتاحاً واحداً.
 */
export function createMyFatoorahGateway(connection: GatewayConnection): PaymentGateway {
  const config = myfatoorahConfig(connection);
  return {
    supportedMethods: SUPPORTED_METHODS,
    createPayment: (input) => createHostedPayment(config, input),
    getPaymentStatus: (query) => lookupPaymentStatus(config, query),
    verifyWebhook: (input) => verifyWebhookSignature(input),
    parseWebhook: (input) => webhookEvent(parseJsonBody(input.rawBody), input.rawBody),
    testConnection: () => testMyFatoorahConnection(config),
  };
}
