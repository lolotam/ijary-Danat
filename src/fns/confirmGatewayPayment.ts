import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requirePermission } from "@/fns/requirePermission";
import { loadGatewayConnection } from "@/gateways/connectionStore.server";
import { gatewayRegistry } from "@/gateways/registry";
import type { GatewayPaymentStatus } from "@/gateways/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/database.types";

import { getFromGateway, postToGateway, type GatewayConfig } from "./myfatoorahGateway";
import { settleGatewayPayment } from "./myfatoorahWebhook";

const paymentRefSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[0-9A-Za-z-]+$/, "Invalid payment reference.");

const inputSchema = z
  .object({
    /** MyFatoorah transaction PaymentId from the redirect (must stay a string). */
    paymentId: paymentRefSchema.optional(),
    /** Our PREQ-… code embedded in the redirect URL as a corruption-proof fallback. */
    paymentRequestCode: z
      .string()
      .min(1)
      .max(40)
      .regex(/^PREQ-\d+$/i, "Invalid payment request code.")
      .optional(),
  })
  .refine((value) => Boolean(value.paymentId || value.paymentRequestCode), {
    message: "paymentId or paymentRequestCode is required.",
  });

/**
 * Classic GetPaymentStatus body (POST /v2/GetPaymentStatus).
 * Sandbox (`apitest.myfatoorah.com`) does **not** expose /v3/GetPaymentStatus;
 * this is the reliable inquiry endpoint on both test and live.
 */
const v2StatusSchema = z.object({
  IsSuccess: z.boolean().optional(),
  Message: z.string().nullish(),
  Data: z
    .object({
      InvoiceId: z.union([z.string(), z.number()]).nullish(),
      InvoiceStatus: z.string().nullish(),
      InvoiceTransactions: z
        .array(
          z.object({
            TransactionStatus: z.string().nullish(),
            PaymentGateway: z.string().nullish(),
            PaymentId: z.string().nullish(),
            // v2 keeps the decline reason flat: a message plus a separate code.
            Error: z.string().nullish(),
            ErrorCode: z.string().nullish(),
          }),
        )
        .optional(),
    })
    .optional(),
});

/**
 * Hosted-page inquiry body (GET /v3/payments/{paymentId}).
 * Nested Invoice / Transaction shape — only valid with the gateway PaymentId,
 * not the InvoiceId.
 */
const v3DetailsSchema = z.object({
  IsSuccess: z.boolean().optional(),
  Message: z.string().nullish(),
  Data: z
    .object({
      Invoice: z
        .object({
          Id: z.union([z.string(), z.number()]).nullish(),
          Status: z.string().nullish(),
        })
        .optional(),
      Transaction: z
        .object({
          Status: z.string().nullish(),
          PaymentMethod: z.string().nullish(),
          PaymentId: z.string().nullish(),
          // v3 nests the same reason as an object instead of two flat fields.
          Error: z.object({ Code: z.string().nullish(), Message: z.string().nullish() }).nullish(),
        })
        .optional(),
    })
    .optional(),
});

export type GatewayPaymentOutcome = "paid" | "pending" | "failed";

interface NormalizedPaymentStatus {
  /** Gateway's own reason for a non-paid transaction, e.g. "MF020: IPAY0100044-…". */
  error: string | null;
  invoiceId: string | null;
  invoiceStatus: string | null;
  methodRaw: string | null;
  providerPaymentId: string;
  raw: Json;
  transactionStatus: string | null;
}

/**
 * ينسّق سبب رفض البوابة لمعاملة غير مدفوعة من شكلي v2 وv3.
 *
 * MyFatoorah reports a decline in two different shapes: v2 gives a flat `Error`
 * string alongside `ErrorCode`, v3 nests `{ Code, Message }`. Either way this is
 * the only place the gateway explains *why* a charge failed — "MF020:
 * IPAY0100044-Problem occured while loading payment page." means KNET never
 * rendered its page, which is not the same event as a tenant who cancelled,
 * even though both surface to the tenant as the same message.
 */
function formatGatewayError(
  code: string | null | undefined,
  message: string | null | undefined,
): string | null {
  const trimmedCode = code?.trim();
  const trimmedMessage = message?.trim();
  if (trimmedCode && trimmedMessage) return `${trimmedCode}: ${trimmedMessage}`;
  return trimmedMessage || trimmedCode || null;
}

/**
 * يطبع حالتي الفاتورة والمعاملة إلى نتيجة موحّدة (`paid` أو `pending` أو `failed`).
 *
 * Exported so the reconciliation job classifies gateway status with the same
 * vocabulary the callback uses. Two copies of this list would drift, and the
 * drift would show up as "the portal says paid, the job says pending".
 */
export function paymentOutcome(invoiceStatus: string | null, transactionStatus: string | null) {
  const normalize = (value: string | null) => value?.toLowerCase().replace(/[\s_-]/g, "") ?? "";
  const invoice = normalize(invoiceStatus);
  const transaction = normalize(transactionStatus);
  if (invoice === "paid" || ["success", "succss", "succeeded", "captured"].includes(transaction)) {
    return "paid" as const;
  }
  if (
    ["failed", "canceled", "cancelled", "declined", "expired"].includes(transaction) ||
    ["canceled", "cancelled", "expired"].includes(invoice)
  ) {
    return "failed" as const;
  }
  return "pending" as const;
}

/** يطبّع رد استعلام v2 إلى البنية الموحّدة لحالة الدفعة. */
function normalizeV2Status(v2Body: unknown, fallbackPaymentId: string): NormalizedPaymentStatus {
  const v2 = v2StatusSchema.parse(v2Body);
  if (v2.IsSuccess === false || !v2.Data) {
    throw new Error(v2.Message ?? "MyFatoorah payment lookup failed.");
  }
  const transactions = v2.Data.InvoiceTransactions ?? [];
  const latest = transactions[transactions.length - 1] ?? null;
  return {
    error: formatGatewayError(latest?.ErrorCode, latest?.Error),
    invoiceId: v2.Data.InvoiceId?.toString() ?? null,
    invoiceStatus: v2.Data.InvoiceStatus ?? null,
    methodRaw: latest?.PaymentGateway ?? null,
    providerPaymentId: latest?.PaymentId ?? fallbackPaymentId,
    raw: v2Body as Json,
    transactionStatus: latest?.TransactionStatus ?? null,
  };
}

/**
 * يستعلم عن حالة الدفعة لدى ماي فاتورة بالترتيب الآمن لبيئة الاختبار (v3 ثم v2).
 *
 * Resolve gateway payment status for the callback PaymentId.
 *
 * Order of attempts (sandbox-safe):
 * 1. GET /v3/payments/{paymentId} — official hosted-page docs shape
 * 2. POST /v2/GetPaymentStatus KeyType=PaymentId
 * 3. POST /v2/GetPaymentStatus KeyType=InvoiceId — when the redirect param is
 *    the MyFatoorah InvoiceId instead of the transaction PaymentId
 *
 * Never call POST /v3/GetPaymentStatus — that route 404s on the test API.
 */
export async function fetchGatewayPaymentStatus(
  config: GatewayConfig,
  paymentId: string,
): Promise<NormalizedPaymentStatus> {
  // 1) Official v3 payment details (PaymentId only)
  try {
    const v3Body = await getFromGateway(config, `/v3/payments/${encodeURIComponent(paymentId)}`);
    const v3 = v3DetailsSchema.safeParse(v3Body);
    if (v3.success && v3.data.IsSuccess !== false && v3.data.Data?.Invoice) {
      const invoice = v3.data.Data.Invoice;
      const transaction = v3.data.Data.Transaction ?? null;
      return {
        error: formatGatewayError(transaction?.Error?.Code, transaction?.Error?.Message),
        invoiceId: invoice.Id?.toString() ?? null,
        invoiceStatus: invoice.Status ?? null,
        methodRaw: transaction?.PaymentMethod ?? null,
        providerPaymentId: transaction?.PaymentId ?? paymentId,
        raw: v3Body as Json,
        transactionStatus: transaction?.Status ?? null,
      };
    }
  } catch {
    // Fall through to v2 — common when the key is an InvoiceId or test routing differs.
  }

  // 2) Classic v2 status by PaymentId
  try {
    const v2Body = await postToGateway(config, "/v2/GetPaymentStatus", {
      Key: paymentId,
      KeyType: "PaymentId",
    });
    return normalizeV2Status(v2Body, paymentId);
  } catch (paymentIdError) {
    // 3) Same endpoint with InvoiceId — some sandbox redirects pass InvoiceId.
    try {
      const v2InvoiceBody = await postToGateway(config, "/v2/GetPaymentStatus", {
        Key: paymentId,
        KeyType: "InvoiceId",
      });
      return normalizeV2Status(v2InvoiceBody, paymentId);
    } catch {
      // Re-throw the PaymentId attempt's error unchanged when it is already an
      // Error (postToGateway and normalizeV2Status only ever throw Errors);
      // anything else gets the generic lookup failure message.
      throw paymentIdError instanceof Error
        ? paymentIdError
        : new Error("MyFatoorah payment lookup failed.");
    }
  }
}

export type ConfirmGatewayPaymentInput = z.infer<typeof inputSchema>;
export interface ConfirmGatewayPaymentResult {
  status: GatewayPaymentOutcome;
  tenantId: string;
}

/** يتحقق من أن المستخدم يملك تأكيد طلب الدفع (صاحب الطلب أو موظف بصلاحية `payment_links.create`). */
async function authorizePaymentRequest(
  supabase: SupabaseClient<Database>,
  userId: string,
  tenantId: string,
) {
  const profileQuery = await supabase
    .from("profiles")
    .select("tenant_id")
    .eq("id", userId)
    .single();
  if (profileQuery.error) throw new Error(profileQuery.error.message);
  if (profileQuery.data.tenant_id === tenantId) return;

  // Paying one's own invoices is ownership, not a permission; only a caller
  // confirming someone else's payment is asked for one, and recorded if refused.
  await requirePermission(
    { supabase, userId },
    {
      code: "payment_links.create",
      attempted: "payment.confirm_gateway",
      refusal: "This payment belongs to another tenant's account.",
      entityType: "tenant",
      entityId: tenantId,
    },
  );
}

export const LEGACY_UNBOUND_PAYMENT_REQUEST = "LEGACY_UNBOUND_PAYMENT_REQUEST";

interface BoundPaymentRequest {
  id: string;
  tenant_id: string;
  provider_invoice_id: string | null;
  provider_payment_id: string | null;
  code: string;
  gateway_connection_id: string | null;
  credentials_version: number | null;
}

const BOUND_PAYMENT_REQUEST_COLUMNS =
  "id, tenant_id, provider_invoice_id, provider_payment_id, code, gateway_connection_id, credentials_version";

/**
 * يبحث عن طلب الدفع المرتبط بالمعاملة بالرمز أو بمعرّف الدفعة أو الفاتورة لدى المزوّد.
 */
async function findPaymentRequestForConfirmation(
  db: SupabaseClient<Database>,
  input: ConfirmGatewayPaymentInput,
): Promise<BoundPaymentRequest> {
  if (input.paymentRequestCode) {
    const preqQuery = await db
      .from("payment_requests")
      .select(BOUND_PAYMENT_REQUEST_COLUMNS)
      .eq("code", input.paymentRequestCode.toUpperCase())
      .maybeSingle();
    if (preqQuery.error) throw new Error(preqQuery.error.message);
    if (preqQuery.data) return preqQuery.data;
    throw new Error("No payment request matches this payment.");
  }

  if (input.paymentId) {
    const byPaymentId = await db
      .from("payment_requests")
      .select(BOUND_PAYMENT_REQUEST_COLUMNS)
      .eq("provider_payment_id", input.paymentId)
      .maybeSingle();
    if (byPaymentId.error) throw new Error(byPaymentId.error.message);
    if (byPaymentId.data) return byPaymentId.data;

    const byInvoiceId = await db
      .from("payment_requests")
      .select(BOUND_PAYMENT_REQUEST_COLUMNS)
      .eq("provider_invoice_id", input.paymentId)
      .maybeSingle();
    if (byInvoiceId.error) throw new Error(byInvoiceId.error.message);
    if (byInvoiceId.data) return byInvoiceId.data;
  }

  throw new Error("No payment request matches this payment.");
}

/**
 * يؤكد حالة دفع بوابة الدفع بعد عودة المستأجر إلى صفحة الاستلام،
 * باستخدام الاتصال المسجّل على طلب الدفع نفسه، ويسجّل الدفع في الفواتير إن نجح.
 *
 * Every failure path throws an `Error`, never a `Response`. TanStack Start
 * hands a thrown `Response` back to the client as the mutation's SUCCESS
 * value (marked `x-tss-raw`), so a `throw new Response("…", { status: 500 })`
 * here used to run the callback page's `onSuccess` with `result.status === 500`
 * — a number that matched none of the page's state branches, leaving the
 * tenant a blank confirmation page while their card had been charged. Same
 * trap as `deleteAppUser.ts`; do not reintroduce the pattern.
 */
export const confirmGatewayPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(inputSchema)
  .handler(async ({ data: requestInput, context }): Promise<ConfirmGatewayPaymentResult> => {
    const company = requireRequestCompany();
    // Settlement path is explicitly allowed to complete in-flight charges even if suspended.
    const db = companyClient(company.id, { allowSuspended: true });
    const paymentRequest = await findPaymentRequestForConfirmation(db, requestInput);
    await authorizePaymentRequest(context.supabase, context.userId, paymentRequest.tenant_id);

    if (!paymentRequest.gateway_connection_id) {
      console.error(
        "[confirmGatewayPayment] payment request has no bound gateway_connection_id",
        JSON.stringify({ paymentRequestId: paymentRequest.id, code: paymentRequest.code }),
      );
      throw new Error(
        `${LEGACY_UNBOUND_PAYMENT_REQUEST}: Payment request has no bound gateway connection.`,
      );
    }

    const loadedConnection = await loadGatewayConnection(db, paymentRequest.gateway_connection_id, {
      credentialsVersion: paymentRequest.credentials_version,
    });
    const gateway = gatewayRegistry.create(loadedConnection.connection);

    const status: GatewayPaymentStatus = await gateway.getPaymentStatus({
      providerPaymentId: requestInput.paymentId ?? paymentRequest.provider_payment_id,
      providerInvoiceId: paymentRequest.provider_invoice_id,
    });

    if (status.outcome !== "paid") {
      // The portal can only tell the tenant "the payment did not complete" — it
      // must not leak a gateway code into the UI. Without this line the reason
      // is lost entirely, and telling a broken gateway apart from a tenant who
      // cancelled costs a live query against the gateway.
      console.warn(
        "[confirmGatewayPayment] gateway did not report a paid invoice",
        JSON.stringify({
          outcome: status.outcome,
          invoiceId: status.providerInvoiceId,
          paymentId: status.providerPaymentId,
          gatewayError: status.error,
        }),
      );
      return { status: status.outcome, tenantId: paymentRequest.tenant_id };
    }

    // The paymentId comes from the browser, so it may name another paid
    // payment on the same MyFatoorah account. Settle only when the gateway
    // reports this request's own invoice, as the return page does (T155
    // review #5); otherwise leave the request to the webhook and reconcile.
    if (
      !paymentRequest.provider_invoice_id ||
      status.providerInvoiceId !== paymentRequest.provider_invoice_id
    ) {
      console.warn(
        "[confirmGatewayPayment] paid status names another invoice; not settling",
        JSON.stringify({
          paymentRequestId: paymentRequest.id,
          expectedInvoiceId: paymentRequest.provider_invoice_id,
          reportedInvoiceId: status.providerInvoiceId,
        }),
      );
      return { status: "pending", tenantId: paymentRequest.tenant_id };
    }

    // Card / KNET / etc. — never leave method null after a successful charge.
    const method = status.method ?? "card";
    const inquiryKey =
      requestInput.paymentId ??
      requestInput.paymentRequestCode ??
      status.providerPaymentId ??
      paymentRequest.code;
    try {
      await settleGatewayPayment(
        {
          eventType: "callback.inquiry",
          invoiceId: paymentRequest.provider_invoice_id,
          method,
          paymentId: status.providerPaymentId,
          providerEventId: `inquiry:${inquiryKey}`,
          status: "PAID",
        },
        status.raw,
        { companyId: company.id },
      );
    } catch (settleError) {
      // Surface a clear log line in Dokploy/docker logs — the portal only shows
      // a generic "could not verify" message for any thrown error.
      console.error(
        "[confirmGatewayPayment] settle failed",
        inquiryKey,
        status.providerInvoiceId,
        settleError instanceof Error ? settleError.message : settleError,
      );
      // Re-throw the settlement's own Error unchanged so its message (the
      // actual reason settlement failed) reaches the caller; only a non-Error
      // throw is replaced with the generic message.
      throw settleError instanceof Error ? settleError : new Error("Payment settlement failed.");
    }
    return { status: "paid", tenantId: paymentRequest.tenant_id };
  });
