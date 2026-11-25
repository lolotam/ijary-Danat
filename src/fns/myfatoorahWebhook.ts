import { settleGatewayPayment, type EventDetails } from "@/fns/gatewaySettlement";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { GatewayPaymentMethod, Json } from "@/integrations/supabase/database.types";
import { isRecord, verifySignature, type SignatureCheck } from "@/lib/myfatoorahSignature";

// Re-exported so the three callers and their tests keep one import path while
// the settlement and signature code live in their own modules (audit M2).
export { canonicalSignatureString } from "@/lib/myfatoorahSignature";
export {
  invoicePaymentReference,
  settleGatewayPayment,
  type EventDetails,
} from "@/fns/gatewaySettlement";

function stringValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return value.toString();
  }
  return null;
}

export function normalizeMethod(value: string | null): GatewayPaymentMethod | null {
  const normalized = value?.toLowerCase().replace(/[\s_-]/g, "") ?? "";
  if (!normalized) return null;
  if (normalized.includes("knet")) return "knet";
  if (normalized.includes("applepay")) return "applepay";
  if (normalized.includes("googlepay")) return "googlepay";
  // The v3 hosted page can complete with any account-enabled method
  // (VISA/MASTER, MADA, AMEX, ...); the money has moved by the time we see
  // it, so record it as a card payment rather than failing settlement.
  return "card";
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * يقرأ قيمة نصية من مسار متداخل داخل الحمولة.
 *
 * The v2 payload nests everything one level deeper than the flat shape this
 * file was first written against — `Data.Invoice.Id`, not `Data.InvoiceId`.
 * Every field resolved to null as a result, so a webhook that *did* verify was
 * still filed as "ignored" and settled nothing. Both readings are kept: the
 * nested path wins, the flat key remains a fallback for the older shape the
 * existing tests and any v1 sender still use.
 *
 * Do not merge with `valueAtPath` in `lib/myfatoorahSignature.ts`, which walks
 * the same shape: that one must render an absent field as "" and must not
 * trim, because its output is hashed. The split into two modules keeps the
 * two apart on purpose.
 */
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

async function eventDetails(payload: Json, rawBody: string): Promise<EventDetails> {
  const root = isRecord(payload) ? payload : {};
  const nestedValue = root.Data ?? root.data;
  const data = isRecord(nestedValue) ? nestedValue : root;
  const event = isRecord(root.Event) ? root.Event : {};
  const explicitEventId =
    // `Event.Reference` ("WH-35939205") is MyFatoorah's own per-delivery id and
    // is what makes replay detection exact rather than a hash of the bytes.
    nestedString(event, "Reference") ??
    stringValue(root, ["EventId", "EventID", "eventId", "event_id", "Id", "id"]) ??
    stringValue(data, ["EventId", "EventID", "eventId", "event_id"]);
  const methodValue =
    nestedString(data, "Transaction.PaymentMethod") ??
    stringValue(data, ["PaymentMethod", "PaymentGateway", "PaymentMethodEn", "paymentMethod"]) ??
    stringValue(root, ["PaymentMethod", "paymentMethod"]);
  return {
    eventType:
      nestedString(event, "Name") ??
      stringValue(root, ["EventType", "EventName", "eventType", "event_type", "Type"]),
    invoiceId:
      nestedString(data, "Invoice.Id") ??
      stringValue(data, ["InvoiceId", "InvoiceID", "invoiceId", "invoice_id"]) ??
      stringValue(root, ["InvoiceId", "InvoiceID", "invoiceId", "invoice_id"]),
    method: normalizeMethod(methodValue),
    paymentId:
      nestedString(data, "Transaction.PaymentId") ??
      stringValue(data, ["PaymentId", "PaymentID", "paymentId", "payment_id"]) ??
      stringValue(root, ["PaymentId", "PaymentID", "paymentId", "payment_id"]),
    providerEventId: explicitEventId ?? (await sha256(rawBody)),
    status:
      // Invoice.Status is PAID/…; Transaction.Status is SUCCESS/…. Either alone
      // is enough for isSuccessfulEvent, and the invoice is the money-truth.
      nestedString(data, "Invoice.Status") ??
      nestedString(data, "Transaction.Status") ??
      stringValue(data, [
        "InvoiceStatus",
        "TransactionStatus",
        "PaymentStatus",
        "Status",
        "status",
      ]) ??
      stringValue(root, ["InvoiceStatus", "PaymentStatus", "Status", "status"]),
  };
}

/**
 * الأحداث التي لا يستهلكها هذا التطبيق ولا يملك ترتيب حقولها.
 *
 * The merchant portal has every event switched on, but this app consumes none
 * of these — no MyFatoorah recurring plans, disputes or suppliers. Answering
 * 401 would be wrong twice over: it reads as an attack in the logs, and
 * MyFatoorah retries a failing endpoint and eventually disables it, which would
 * take the *payment* webhook down with it. They are acknowledged and dropped
 * instead, and nothing is ever settled from an unverified payload.
 */
const UNCONSUMED_EVENTS = new Set([
  "RECURRING_STATUS_CHANGED",
  "DISPUTE_STATUS_CHANGED",
  "SUPPLIER_UPDATE_REQUEST_CHANGED",
  "SUPPLIER_BANK_DETAILS_CHANGED",
]);

/**
 * يسجّل سبب رفض التوقيع بتفصيل يكفي لتشخيصه دون كشف المفتاح السري.
 *
 * A rejection has three very different causes — wrong secret, wrong field
 * order, or an event type we have no order for — and the stored `webhook_events`
 * row cannot tell them apart. That ambiguity is why this went undiagnosed
 * through five deliveries.
 *
 * **The expected signature is deliberately not logged.** Printing it would turn
 * this endpoint into a forgery oracle: anyone able to read the logs could post
 * a payload of their choosing, read back the signature that payload needs, and
 * resubmit it to settle an invoice — without ever knowing the secret. The
 * canonical string and the sender's own signature are enough to diagnose, and
 * neither helps an attacker: computing the expected value from them still
 * requires the secret. To diagnose, recompute offline from this canonical
 * string using the secret.
 */
function logSignatureRejection(input: {
  check: SignatureCheck;
  details: EventDetails;
  suppliedSignature: string | null;
}) {
  console.warn(
    "[myfatoorahWebhook] signature rejected",
    JSON.stringify({
      event: input.details.eventType,
      reason: input.check.canonical === null ? "unsupported_event_type" : "signature_mismatch",
      canonical: input.check.canonical,
      supplied: input.suppliedSignature,
    }),
  );
}

function isSuccessfulEvent(details: EventDetails) {
  const values = [details.eventType, details.status]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase().replace(/[\s_-]/g, ""));
  return values.some((value) =>
    ["paid", "success", "succeeded", "captured", "paymentsucceeded", "paymentcaptured"].includes(
      value,
    ),
  );
}

async function markEvent(
  eventId: string,
  updates: { error?: string | null; processed?: boolean; result: string },
) {
  const { error } = await supabaseAdmin.from("webhook_events").update(updates).eq("id", eventId);
  if (error) throw new Error(error.message);
}

async function invalidSignatureResponse(payload: Json, details: EventDetails) {
  const insertQuery = await supabaseAdmin.from("webhook_events").insert({
    gateway: "myfatoorah",
    event_type: details.eventType,
    provider_event_id: details.providerEventId,
    provider_payment_id: details.paymentId,
    raw_payload: payload,
    signature_valid: false,
    result: "invalid_signature",
    error: "Signature verification failed.",
  });
  if (insertQuery.error && insertQuery.error.code !== "23505") {
    throw new Error(insertQuery.error.message);
  }
  return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
}

async function claimWebhookEvent(payload: Json, details: EventDetails) {
  const insertQuery = await supabaseAdmin
    .from("webhook_events")
    .insert({
      gateway: "myfatoorah",
      event_type: details.eventType,
      provider_event_id: details.providerEventId,
      provider_payment_id: details.paymentId,
      raw_payload: payload,
      signature_valid: true,
      result: "processing",
    })
    .select("*")
    .single();
  if (!insertQuery.error) return { event: insertQuery.data, replay: false };
  if (insertQuery.error.code !== "23505") throw new Error(insertQuery.error.message);
  const existingQuery = await supabaseAdmin
    .from("webhook_events")
    .select("*")
    .eq("gateway", "myfatoorah")
    .eq("provider_event_id", details.providerEventId)
    .single();
  if (existingQuery.error) throw new Error(existingQuery.error.message);
  if (existingQuery.data.processed || existingQuery.data.result === "processing") {
    return { event: existingQuery.data, replay: true };
  }
  const claimQuery = await supabaseAdmin
    .from("webhook_events")
    .update({ result: "processing", error: null })
    .eq("id", existingQuery.data.id)
    .eq("processed", false)
    .eq("result", existingQuery.data.result ?? "failed")
    .select("*")
    .maybeSingle();
  if (claimQuery.error) throw new Error(claimQuery.error.message);
  return { event: claimQuery.data ?? existingQuery.data, replay: !claimQuery.data };
}

function parsedPayload(rawBody: string): Json {
  try {
    return JSON.parse(rawBody) as Json;
  } catch {
    return { raw: rawBody };
  }
}

export async function respondToMyFatoorahWebhook(request: Request): Promise<Response> {
  const webhookSecret = process.env.MYFATOORAH_WEBHOOK_SECRET;
  if (!webhookSecret) {
    // Fail closed — this endpoint settles money and must never run unverified.
    // But say so out loud: MyFatoorah retries a 503 a few times and then stops,
    // so an unconfigured webhook is otherwise indistinguishable from one that
    // was never called, which is exactly how this went unnoticed in production.
    console.warn(
      "[myfatoorahWebhook] rejected a webhook because MYFATOORAH_WEBHOOK_SECRET is not set",
    );
    return Response.json(
      { error: "MyFatoorah webhook secret is not configured." },
      { status: 503 },
    );
  }
  const rawBody = await request.text();
  const payload = parsedPayload(rawBody);
  const details = await eventDetails(payload, rawBody);
  // MyFatoorah sends `MyFatoorah-Signature`; the other names are kept for
  // manual testing and older configurations.
  const suppliedSignature =
    request.headers.get("myfatoorah-signature") ??
    request.headers.get("x-myfatoorah-signature") ??
    request.headers.get("authorization");
  if (details.eventType && UNCONSUMED_EVENTS.has(details.eventType)) {
    // Acknowledged without verifying, and deliberately not recorded: it carries
    // no invoice or payment, and storing unverified payloads would only make
    // webhook_events harder to read. Settlement is unreachable from here.
    return Response.json({ ok: true, ignored: true, reason: "event_not_consumed" });
  }
  const check = await verifySignature(payload, suppliedSignature, webhookSecret);
  if (!check.valid) {
    logSignatureRejection({ check, details, suppliedSignature });
    return invalidSignatureResponse(payload, details);
  }
  if (check.matchedKeyEncoding === "base64-decoded") {
    // Recorded once per delivery so the two-candidate fallback in
    // `verifySignature` can be narrowed to the single correct encoding rather
    // than kept forever.
    console.info("[myfatoorahWebhook] signature matched using the base64-decoded secret");
  }
  const claim = await claimWebhookEvent(payload, details);
  if (claim.replay) return Response.json({ ok: true, replay: true });
  if (!isSuccessfulEvent(details)) {
    await markEvent(claim.event.id, { processed: true, result: "ignored" });
    return Response.json({ ok: true, ignored: true });
  }
  try {
    const alreadyCompleted = await settleGatewayPayment(details, payload);
    await markEvent(claim.event.id, {
      processed: true,
      result: alreadyCompleted ? "already_completed" : "completed",
    });
    return Response.json({ ok: true, replay: alreadyCompleted });
  } catch (settlementError) {
    const message =
      settlementError instanceof Error ? settlementError.message : "Webhook processing failed.";
    await markEvent(claim.event.id, { processed: false, result: "failed", error: message });
    return Response.json({ error: message }, { status: 500 });
  }
}
