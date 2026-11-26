import type { Json, PaymentMethod, Tables } from "@/integrations/supabase/database.types";
import type { BlockingPayment } from "@/lib/gatewayReconciliation";
import { getSuppressedPaymentIds } from "@/lib/suppressedPayments";

import {
  asMoney,
  type EventDetails,
  invoicePaymentReference,
  type SettlementDb,
} from "./gatewaySettlementReads";

/*
 * كتابات تسوية البوابة: الدفعات والتخصيص والإيصالات وإكمال الطلب.
 *
 * Split out of `gatewaySettlement.ts` when it passed the file ceiling (Phase
 * 2C). The order in which these run is the settlement core's decision.
 */

/**
 * ينشئ دفعة مؤكدة لشهر فاتورة واحد من حدث البوابة، ويربطها بطلب الدفع.
 *
 * `payment_request_id` is the D5 provenance column: `resulting_payment_id` is
 * a scalar and cannot name every month a single request settled.
 *
 * `amount` is decided by the caller, not read off the invoice: it is the
 * month's balance capped at what is left of the captured charge, so a balance
 * that grew after the link was issued is never booked beyond the money that
 * actually arrived (Phase 2C).
 */
export async function createConfirmedPaymentForInvoice(
  db: SettlementDb,
  input: {
    amount: number;
    companyId: string | null;
    details: EventDetails;
    invoice: Tables<"invoices">;
    paymentReference: string;
    paymentRequest: Tables<"payment_requests">;
  },
) {
  const method: PaymentMethod = input.details.method ?? "card";
  const amount = asMoney(input.amount);
  if (amount <= 0) {
    throw new Error(`Invoice ${input.invoice.code} has no remaining balance to settle.`);
  }
  const paymentQuery = await db
    .from("payments")
    .insert({
      company_id: input.companyId,
      tenant_id: input.paymentRequest.tenant_id,
      account_type: "commercial_account",
      method,
      // One payment per invoice month, for that month's share of the charge.
      amount,
      currency: input.paymentRequest.currency,
      payment_date: new Date().toISOString().slice(0, 10),
      reference: input.paymentReference,
      unit_id: input.invoice.unit_id,
      note: `MyFatoorah ${input.paymentRequest.code} — ${input.invoice.period_month}/${input.invoice.period_year}`,
      status: "confirmed",
      payment_request_id: input.paymentRequest.id,
    })
    .select("id")
    .single();
  if (!paymentQuery.error) return paymentQuery.data.id;
  if (paymentQuery.error.code !== "23505") throw new Error(paymentQuery.error.message);
  const concurrentQuery = await db
    .from("payments")
    .select("id")
    .eq("reference", input.paymentReference)
    .single();
  if (concurrentQuery.error) throw new Error(concurrentQuery.error.message);
  return concurrentQuery.data.id;
}

/** يربط الدفعة بطلب الدفع الذي جاءت منه. */
export async function linkPaymentRequest(
  db: SettlementDb,
  paymentRequest: Tables<"payment_requests">,
  details: EventDetails,
  paymentId: string,
) {
  const linkQuery = await db
    .from("payment_requests")
    .update({
      provider_payment_id: details.paymentId ?? paymentRequest.provider_payment_id,
      resulting_payment_id: paymentId,
    })
    .eq("id", paymentRequest.id);
  if (linkQuery.error) throw new Error(linkQuery.error.message);
}

/**
 * يتبنّى الدفعات المؤقتة التي أنشأها المسؤول لهذا الطلب.
 *
 * Relabel admin placeholder payments as the gateway payments they always stood
 * in for. Amount, allocation and invoice state are untouched — no money moves,
 * this only corrects `method`, `reference` and `payment_request_id` — and
 * every relabel is audited with the method actually read, never an assumed one.
 *
 * The provenance column travels with the relabel: an adopted placeholder was
 * inserted by hand with a null `payment_request_id`, and 192's backfill only
 * ran once, so without it the invoice breakdown would call the gateway
 * settlement "manual" for good.
 */
export async function adoptPlaceholderPayments(
  db: SettlementDb,
  payments: BlockingPayment[],
  method: PaymentMethod,
  referencePrefix: string,
  paymentRequestId: string,
): Promise<string[]> {
  const adopted: string[] = [];
  for (const payment of payments) {
    const nextReference = invoicePaymentReference(referencePrefix, payment.invoiceCode);
    const update = await db
      .from("payments")
      .update({ method, reference: nextReference, payment_request_id: paymentRequestId })
      .eq("id", payment.id);
    if (update.error) throw new Error(update.error.message);

    const audit = await db.rpc("write_audit", {
      p_action: "payment.gateway_reconciled",
      p_entity_type: "payment",
      p_entity_id: payment.id,
      p_before: { method: payment.method, reference: payment.reference },
      p_after: { method, reference: nextReference, payment_request_id: paymentRequestId },
      p_result: "success",
      p_error_code: null,
    });
    if (audit.error) throw new Error(`Audit log write failed: ${audit.error.message}`);
    adopted.push(payment.id);
  }
  return adopted;
}

/** يخصّص الدفعة للفاتورة. */
export async function allocatePaymentToInvoice(
  db: SettlementDb,
  paymentId: string,
  invoice: Tables<"invoices">,
  amount: number,
) {
  const allocationQuery = await db.rpc("apply_payment_allocation", {
    p_payment_id: paymentId,
    p_allocations: [{ invoice_id: invoice.id, amount }],
  });
  if (allocationQuery.error) throw new Error(allocationQuery.error.message);
}

/** مرجع دفعة الفائض لطلب دفع: فريد، فيعيد استدعاءٌ مكرّر استخدام الدفعة نفسها. */
export function excessPaymentReference(referencePrefix: string) {
  return `${referencePrefix}#EXCESS`;
}

/**
 * يسجّل ما حصّلته البوابة زيادةً على ما سُجّل للفواتير كدفعة مؤكدة غير مخصّصة.
 *
 * The gateway charged `payment_requests.amount`, fixed when the link was
 * issued. Settlement books each month at its CURRENT balance, so a month paid
 * or part-paid elsewhere in the meantime leaves captured money with no row —
 * until this. The difference becomes one confirmed, UNALLOCATED payment the
 * office can allocate or refund from the payments screen; the portal already
 * shows an unallocated payment as the tenant's unapplied money.
 *
 * Deliberately not spent on other open invoices: that would settle months the
 * tenant did not choose, migration 217's oldest-first rule would refuse it, and
 * undoing it needs a person. The unique `MF:%` reference makes this idempotent:
 * a replayed or resumed callback finds the payment it wrote before and does not
 * audit it twice. Returns the excess payment's id, or null when nothing is over.
 */
export async function recordGatewayExcess(
  db: SettlementDb,
  input: {
    booked: number;
    companyId: string | null;
    details: EventDetails;
    paymentRequest: Tables<"payment_requests">;
    referencePrefix: string;
  },
): Promise<string | null> {
  const captured = asMoney(input.paymentRequest.amount);
  const excess = asMoney(captured - input.booked);
  if (excess <= 0) return null;
  const reference = excessPaymentReference(input.referencePrefix);

  const insert = await db
    .from("payments")
    .insert({
      company_id: input.companyId,
      tenant_id: input.paymentRequest.tenant_id,
      account_type: "commercial_account",
      method: input.details.method ?? "card",
      amount: excess,
      currency: input.paymentRequest.currency,
      payment_date: new Date().toISOString().slice(0, 10),
      reference,
      unit_id: null,
      note: `MyFatoorah ${input.paymentRequest.code} — captured ${captured}, booked ${input.booked}; unallocated excess to allocate or refund`,
      status: "confirmed",
      payment_request_id: input.paymentRequest.id,
    })
    .select("id")
    .single();
  if (insert.error) {
    if (insert.error.code !== "23505") throw new Error(insert.error.message);
    const existing = await db.from("payments").select("id").eq("reference", reference).single();
    if (existing.error) throw new Error(existing.error.message);
    return existing.data.id;
  }

  const record = {
    paymentRequest: input.paymentRequest.code,
    captured,
    booked: input.booked,
    excess,
    excessPayment: insert.data.id,
  };
  console.error(
    "[settleGatewayPayment] gateway captured more than it booked",
    JSON.stringify(record),
  );
  const audit = await db.rpc("write_audit", {
    p_action: "payment.gateway_excess",
    p_entity_type: "payment_request",
    p_entity_id: input.paymentRequest.id,
    p_before: null,
    p_after: record,
    p_result: "success",
    p_error_code: null,
  });
  if (audit.error) throw new Error(`Audit log write failed: ${audit.error.message}`);
  return insert.data.id;
}

/**
 * يُظهر إيصالات الدفعات للمستأجر في البوابة.
 *
 * Gateway receipts must be visible in the tenant portal so the callback CTA
 * ("View & download receipt") and /portal/receipts are not empty. Tenant-level
 * `receipt_visible_to_tenant` defaults to false for manual office receipts.
 *
 * Suppressed contracts never have their receipts flipped visible: a payment
 * whose settled invoices include ANY invoice on a suppressed contract is skipped
 * entirely, so a roof receipt is never exposed to the tenant via the portal.
 * This mirrors the tenant-notification suppression in
 * `src/fns/notifyPaymentSuccess.ts`, which also uses ANY (not ALL) because the
 * receipt document cannot be filtered per-invoice.
 */
export async function makeReceiptsVisibleToTenant(db: SettlementDb, paymentIds: string[]) {
  if (!paymentIds.length) return;
  let visibleIds: string[];
  try {
    const suppressedPaymentIds = await getSuppressedPaymentIds(paymentIds);
    if (!suppressedPaymentIds.size) {
      visibleIds = paymentIds;
    } else {
      visibleIds = paymentIds.filter((id) => !suppressedPaymentIds.has(id));
    }
  } catch (error) {
    // Fail closed, but make the failure observable. A bare catch would
    // silently leave every receipt in the batch invisible while the webhook
    // reports success, with nothing in the logs to explain the missing CTA.
    console.error(
      "[makeReceiptsVisibleToTenant] failed to resolve suppressed contracts",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  if (!visibleIds.length) return;
  const update = await db
    .from("receipts")
    .update({ visible_to_tenant: true })
    .in("payment_id", visibleIds);
  if (update.error) throw new Error(update.error.message);
}

/** يعلّم طلب الدفع مكتملاً ويسجّله في التدقيق مع دفعته وإيصالها. */
export async function finalizePaymentRequest(
  db: SettlementDb,
  input: {
    details: EventDetails;
    paymentId: string;
    paymentRequest: Tables<"payment_requests">;
    payload: Json;
  },
) {
  const receiptQuery = await db
    .from("receipts")
    .select("id")
    .eq("payment_id", input.paymentId)
    .single();
  if (receiptQuery.error) throw new Error(receiptQuery.error.message);
  const auditQuery = await db.rpc("write_audit", {
    p_action: "payment_request.complete",
    p_entity_type: "payment_request",
    p_entity_id: input.paymentRequest.id,
    p_before: { status: input.paymentRequest.status },
    p_after: { status: "completed", payment_id: input.paymentId, receipt_id: receiptQuery.data.id },
    p_result: "success",
    p_error_code: null,
  });
  if (auditQuery.error) throw new Error(`Audit log write failed: ${auditQuery.error.message}`);
  const completeQuery = await db
    .from("payment_requests")
    .update({
      status: "completed",
      provider_payment_id: input.details.paymentId ?? input.paymentRequest.provider_payment_id,
      resulting_payment_id: input.paymentId,
      gateway_response: {
        execute: input.paymentRequest.gateway_response,
        webhook: input.payload,
      },
    })
    .eq("id", input.paymentRequest.id);
  if (completeQuery.error) throw new Error(completeQuery.error.message);
}
