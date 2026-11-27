import type { SupabaseClient } from "@supabase/supabase-js";

import { companyClient } from "@/company/companyClient.server";
import { settleGatewayPayment } from "@/fns/gatewaySettlement";
import { type EventDetails, findPaymentRequest } from "@/fns/gatewaySettlementReads";
import { loadGatewayConnection } from "@/gateways/connectionStore.server";
import { gatewayRegistry } from "@/gateways/registry";
import type { Database } from "@/integrations/supabase/database.types";
import type { JobKind, JobPayload } from "@/jobs/catalog";
import { enqueueJob } from "@/jobs/enqueue";
import type { JobHandler, JobHandlerContext } from "@/worker/runJob";

/**
 * الأحداث التي لا يستهلكها هذا التطبيق ولا يملك ترتيب حقولها.
 *
 * The merchant portal has every event switched on, but this app consumes none
 * of these — no recurring plans, disputes or suppliers. They are acknowledged
 * and ignored without failing or retrying.
 */
export const UNCONSUMED_WEBHOOK_EVENTS = new Set([
  "RECURRING_STATUS_CHANGED",
  "DISPUTE_STATUS_CHANGED",
  "SUPPLIER_UPDATE_REQUEST_CHANGED",
  "SUPPLIER_BANK_DETAILS_CHANGED",
]);

/**
 * يحدّد ما إذا كان حدث الويب هوك يمثّل عملية دفع مكتملة تستوجب التسوية.
 */
export function isSuccessfulWebhookEvent(details: EventDetails): boolean {
  const values = [details.eventType, details.status]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase().replace(/[\s_-]/g, ""));
  return values.some((value) =>
    ["paid", "success", "succeeded", "captured", "paymentsucceeded", "paymentcaptured"].includes(
      value,
    ),
  );
}

/**
 * يحدّث حالة صف `webhook_events` بعد انتهاء معالجته أو عند تعذّر المطابقة.
 */
async function markWebhookEvent(
  db: SupabaseClient<Database>,
  eventId: string,
  updates: { error?: string | null; processed: boolean; result: string },
): Promise<void> {
  const { error } = await db.from("webhook_events").update(updates).eq("id", eventId);
  if (error) {
    throw new Error(`webhook_events update failed: ${error.message}`);
  }
}

/**
 * يعالج حدث ويب هوك مخزّناً وموثّق التوقيع، ويحجز مهمة `payment.settle` عند نجاح الدفع.
 *
 * Uses `companyClient(companyId, { allowSuspended: true })` so an in-flight
 * payment for a suspended company still settles (contracts/webhooks.md, FR-045).
 */
async function handleWebhookProcess(ctx: JobHandlerContext): Promise<unknown> {
  const payload = ctx.payload as JobPayload<"webhook.process">;
  const db = companyClient(ctx.companyId, { allowSuspended: true });

  const { data: eventRow, error } = await db
    .from("webhook_events")
    .select("*")
    .eq("id", payload.webhookEventId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();

  if (error) {
    throw new Error(`webhook_events lookup failed: ${error.message}`);
  }
  if (!eventRow) {
    throw new Error(`Webhook event ${payload.webhookEventId} not found.`);
  }
  if (eventRow.processed) {
    return { alreadyProcessed: true, result: eventRow.result };
  }
  if (!eventRow.signature_valid) {
    return { ignored: true, reason: "invalid_signature" };
  }
  if (!eventRow.connection_id) {
    throw new Error("LEGACY_UNBOUND_WEBHOOK_EVENT: Webhook event has no connection_id.");
  }

  const loaded = await loadGatewayConnection(db, eventRow.connection_id);
  const gateway = gatewayRegistry.create(loaded.connection);
  const rawBody =
    typeof eventRow.raw_payload === "string"
      ? eventRow.raw_payload
      : JSON.stringify(eventRow.raw_payload ?? {});
  const details = await gateway.parseWebhook({ rawBody });

  if (details.eventType && UNCONSUMED_WEBHOOK_EVENTS.has(details.eventType)) {
    await markWebhookEvent(db, eventRow.id, { processed: true, result: "ignored" });
    return { ok: true, ignored: true, reason: "event_not_consumed" };
  }
  if (!isSuccessfulWebhookEvent(details)) {
    await markWebhookEvent(db, eventRow.id, { processed: true, result: "ignored" });
    return { ok: true, ignored: true };
  }

  const paymentRequest = await findPaymentRequest(db, details.invoiceId, details.paymentId);
  if (!paymentRequest) {
    const message = "No payment request matches this webhook.";
    await markWebhookEvent(db, eventRow.id, {
      processed: false,
      result: "failed",
      error: message,
    });
    throw new Error(message);
  }

  if (paymentRequest.status === "completed") {
    await markWebhookEvent(db, eventRow.id, { processed: true, result: "already_completed" });
    return { ok: true, replay: true, paymentRequestId: paymentRequest.id };
  }

  const { jobId } = await enqueueJob(
    db,
    "payment.settle",
    { paymentRequestId: paymentRequest.id },
    { dedupeKey: `payment.settle:${paymentRequest.id}` },
  );
  await markWebhookEvent(db, eventRow.id, { processed: true, result: "completed" });
  return { ok: true, paymentRequestId: paymentRequest.id, settlementJobId: jobId };
}

/**
 * يسوّي طلب دفع بالتحقق من حالته على اتصال البوابة المسجّل عليه وقت إنشائه،
 * ثم تسجيل الدفعة وتخصيصها ذريّاً عبر `settleGatewayPayment`.
 *
 * Always loads `paymentRequest.gateway_connection_id` — never the currently
 * active connection — so an in-flight payment settles on its original gateway
 * even after the company switches gateways (FR-057).
 */
async function handlePaymentSettle(ctx: JobHandlerContext): Promise<unknown> {
  const payload = ctx.payload as JobPayload<"payment.settle">;
  const db = companyClient(ctx.companyId, { allowSuspended: true });

  const { data: paymentRequest, error } = await db
    .from("payment_requests")
    .select("*")
    .eq("id", payload.paymentRequestId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();

  if (error) {
    throw new Error(`payment_requests lookup failed: ${error.message}`);
  }
  if (!paymentRequest) {
    throw new Error(`Payment request ${payload.paymentRequestId} not found.`);
  }
  if (paymentRequest.status === "completed") {
    return { alreadyCompleted: true, paymentRequestId: paymentRequest.id };
  }
  if (!paymentRequest.gateway_connection_id) {
    console.error(
      "[payment.settle] payment request has no bound gateway_connection_id",
      JSON.stringify({ paymentRequestId: paymentRequest.id, code: paymentRequest.code }),
    );
    throw new Error(
      "LEGACY_UNBOUND_PAYMENT_REQUEST: Payment request has no bound gateway connection.",
    );
  }

  const loaded = await loadGatewayConnection(db, paymentRequest.gateway_connection_id, {
    credentialsVersion: paymentRequest.credentials_version,
  });
  const gateway = gatewayRegistry.create(loaded.connection);
  const status = await gateway.getPaymentStatus({
    providerInvoiceId: paymentRequest.provider_invoice_id,
    providerPaymentId: paymentRequest.provider_payment_id,
  });

  if (status.outcome !== "paid") {
    return { settled: false, outcome: status.outcome, paymentRequestId: paymentRequest.id };
  }

  const alreadyCompleted = await settleGatewayPayment(
    {
      eventType: "payment.settle",
      invoiceId: status.providerInvoiceId ?? paymentRequest.provider_invoice_id,
      method: status.method ?? "card",
      paymentId: status.providerPaymentId ?? paymentRequest.provider_payment_id,
      providerEventId: `settle:${paymentRequest.id}`,
      status: "PAID",
    },
    status.raw,
    { companyId: ctx.companyId },
  );

  return {
    settled: !alreadyCompleted,
    alreadyCompleted,
    paymentRequestId: paymentRequest.id,
  };
}

/**
 * يبني خريطة معالجات طابور الوارد (`webhook.process` و`payment.settle`).
 */
export function createInboundHandlers(): Partial<Record<JobKind, JobHandler>> {
  return {
    "webhook.process": handleWebhookProcess,
    "payment.settle": handlePaymentSettle,
  };
}
