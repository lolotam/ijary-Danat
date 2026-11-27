import { companyClient } from "@/company/companyClient.server";
import { getRequestCompany } from "@/company/requestCompany.server";
import { settleGatewayPayment } from "@/fns/gatewaySettlement";
import type { PaymentReturnState } from "@/fns/paymentReturnPage";
import { loadGatewayConnection } from "@/gateways/connectionStore.server";
import { gatewayRegistry } from "@/gateways/registry";

const PREQ_CODE_REGEX = /^PREQ-\d+$/i;

/**
 * يتحقق من حالة طلب دفع لصفحة العودة دون جلسة مستخدم، مقيّداً بشركة المضيف فقط.
 *
 * Resolves the company from `getRequestCompany()`, scopes the lookup to that
 * company via `companyClient(company.id, { allowSuspended: true })`, and
 * confirms on the payment request's recorded `gateway_connection_id`. The
 * gateway payment id from the redirect is required and must belong to the
 * request's own gateway invoice; otherwise the caller gets `not_found`. A `$preq`
 * belonging to another company returns `{ status: "not_found" }` — identical
 * to a missing code — so no cross-company existence signal leaks.
 *
 * Lives in a `.server.ts` module so the return-page route, which imports
 * `paymentReturnPage.ts` for its server function, never pulls the company
 * client, host context or gateway credential store into the browser bundle.
 */
export async function loadPaymentReturnState(input: {
  preq: string;
  paymentId?: string;
}): Promise<PaymentReturnState> {
  const company = getRequestCompany();
  if (!company) {
    return { status: "not_found" };
  }

  const trimmedCode = input.preq.trim();
  // PREQ codes are sequential, so the code alone proves nothing. The payer
  // holds the gateway's payment id from the redirect; without it nothing is
  // read or revealed, and nobody can enumerate codes to learn their status.
  if (!PREQ_CODE_REGEX.test(trimmedCode) || !input.paymentId) {
    return { status: "not_found" };
  }
  const paymentId = input.paymentId;

  const normalizedCode = trimmedCode.toUpperCase();
  // Settlement path is allowed to complete in-flight charges even if suspended.
  const db = companyClient(company.id, { allowSuspended: true });
  const { data: paymentRequest, error } = await db
    .from("payment_requests")
    .select(
      "id, code, company_id, provider_invoice_id, provider_payment_id, gateway_connection_id, credentials_version, status",
    )
    .eq("code", normalizedCode)
    .eq("company_id", company.id)
    .maybeSingle();

  if (error) {
    throw new Error(`payment_requests lookup failed: ${error.message}`);
  }
  if (!paymentRequest) {
    return { status: "not_found" };
  }
  if (!paymentRequest.gateway_connection_id || !paymentRequest.provider_invoice_id) {
    return { status: "not_found" };
  }

  const loaded = await loadGatewayConnection(db, paymentRequest.gateway_connection_id, {
    credentialsVersion: paymentRequest.credentials_version,
  });
  const gateway = gatewayRegistry.create(loaded.connection);
  // The invoice id is left out on purpose: the adapter falls back to it when
  // the payment id is unknown, which would answer for any guessed code.
  const gatewayStatus = await gateway.getPaymentStatus({
    providerPaymentId: paymentId,
    providerInvoiceId: null,
  });
  if (gatewayStatus.providerInvoiceId !== paymentRequest.provider_invoice_id) {
    return { status: "not_found" };
  }

  if (paymentRequest.status === "completed") {
    return { status: "paid", code: paymentRequest.code };
  }
  if (gatewayStatus.outcome !== "paid") {
    return { status: gatewayStatus.outcome, code: paymentRequest.code };
  }

  const inquiryKey = paymentId;
  await settleGatewayPayment(
    {
      eventType: "callback.inquiry",
      invoiceId: gatewayStatus.providerInvoiceId ?? paymentRequest.provider_invoice_id,
      method: gatewayStatus.method ?? "card",
      paymentId: gatewayStatus.providerPaymentId ?? paymentRequest.provider_payment_id,
      providerEventId: `inquiry:${inquiryKey}`,
      status: "PAID",
    },
    gatewayStatus.raw,
    { companyId: company.id },
  );

  return { status: "paid", code: paymentRequest.code };
}
