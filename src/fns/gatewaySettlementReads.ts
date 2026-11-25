import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { GatewayPaymentMethod, Tables } from "@/integrations/supabase/database.types";
import type { BlockingPayment } from "@/lib/gatewayReconciliation";
import { roundToFils } from "@/lib/fils";

/*
 * قراءات تسوية البوابة: طلب الدفع وفواتيره ودفعاته الموجودة.
 *
 * Split out of `gatewaySettlement.ts` when it passed the file ceiling (Phase
 * 2C). Everything here reads; nothing here moves money.
 */

/** ما يُستخرج من حدث البوابة ويكفي للتسوية. */
export interface EventDetails {
  eventType: string | null;
  invoiceId: string | null;
  method: GatewayPaymentMethod | null;
  paymentId: string | null;
  providerEventId: string;
  status: string | null;
}

/**
 * يجد طلب الدفع بمعرّف فاتورة البوابة أولاً، ثم بمعرّف الدفعة.
 *
 * Deliberately no status filter: a `superseded` request's link is still
 * payable, and its charge must find its row (migration 223).
 */
export async function findPaymentRequest(invoiceId: string | null, paymentId: string | null) {
  if (invoiceId) {
    const result = await supabaseAdmin
      .from("payment_requests")
      .select("*")
      .eq("provider_invoice_id", invoiceId)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (result.data) return result.data;
  }
  if (paymentId) {
    const result = await supabaseAdmin
      .from("payment_requests")
      .select("*")
      .eq("provider_payment_id", paymentId)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data;
  }
  return null;
}

/**
 * يقرأ فواتير طلب الدفع بترتيب معرّفاتها في الطلب، مع معرّفات ما حُذف منها.
 *
 * A requested invoice can be gone by the time the charge arrives: regeneration
 * is blocked only while a request is `pending` (migration 55), and a superseded
 * link stays payable (migration 223). Throwing here left that captured money
 * recorded nowhere; the caller books what survives and records the rest as
 * excess.
 */
export async function orderedRequestInvoices(paymentRequest: Tables<"payment_requests">) {
  const invoiceQuery = await supabaseAdmin
    .from("invoices")
    .select("*")
    .in("id", paymentRequest.requested_invoice_ids);
  if (invoiceQuery.error) throw new Error(invoiceQuery.error.message);
  const invoiceById = new Map(invoiceQuery.data.map((invoice) => [invoice.id, invoice]));
  return {
    invoices: paymentRequest.requested_invoice_ids
      .map((id) => invoiceById.get(id))
      .filter((invoice): invoice is NonNullable<typeof invoice> => invoice !== undefined),
    missingInvoiceIds: paymentRequest.requested_invoice_ids.filter((id) => !invoiceById.has(id)),
  };
}

/**
 * يبني مرجع الدفعة الفريد لفاتورة ضمن طلب دفع.
 *
 * Reference for the payment covering a single invoice period. A multi-month
 * settlement produces one payment per invoice, so the invoice code is part of
 * the reference and each row stays individually idempotent.
 */
export function invoicePaymentReference(prefix: string, invoiceCode: string) {
  return `${prefix}#${invoiceCode}`;
}

/**
 * يجد الدفعات الموجودة مسبقاً بمراجعها، مع مبالغها.
 *
 * Payments already created for this settlement, keyed by their reference. The
 * amount travels with the id because a resumed run must count what an earlier
 * run already booked against the captured charge.
 */
export async function existingPaymentsByReference(references: string[]) {
  const found = new Map<string, { id: string; amount: number }>();
  if (!references.length) return found;
  const paymentQuery = await supabaseAdmin
    .from("payments")
    .select("id,reference,amount")
    .in("reference", references);
  if (paymentQuery.error) throw new Error(paymentQuery.error.message);
  for (const payment of paymentQuery.data) {
    found.set(payment.reference as string, {
      id: payment.id as string,
      amount: asMoney(payment.amount),
    });
  }
  return found;
}

/**
 * هل خُصّصت الدفعة لهذه الفاتورة من قبل؟
 * True when the payment already carries its single invoice allocation. */
export async function paymentIsAllocated(paymentId: string, invoiceId: string) {
  const allocationQuery = await supabaseAdmin
    .from("payment_allocations")
    .select("invoice_id")
    .eq("payment_id", paymentId);
  if (allocationQuery.error) throw new Error(allocationQuery.error.message);
  return allocationQuery.data.some((allocation) => allocation.invoice_id === invoiceId);
}

/**
 * يقرّب قيمة مالية إلى ثلاث خانات عشرية (فلس).
 * PostgREST returns `numeric` as string; coerce before arithmetic/equality. */
export function asMoney(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid money value: ${String(value)}`);
  return roundToFils(n);
}

/**
 * يجد الدفعات التي تمنع تسوية هذه الفواتير.
 *
 * Confirmed payments already allocated to these invoices, for the adoption rule.
 *
 * Reversed payments are excluded deliberately: they are not holding any balance
 * down, so they neither block a settlement nor stand in for one.
 */
export async function blockingPaymentsForInvoices(
  invoices: Tables<"invoices">[],
): Promise<BlockingPayment[]> {
  // Reachable since every requested invoice can be gone; an empty `in` list
  // is not a query worth sending to PostgREST.
  if (!invoices.length) return [];
  const invoiceCodeById = new Map(invoices.map((invoice) => [invoice.id, invoice.code]));
  const allocationQuery = await supabaseAdmin
    .from("payment_allocations")
    .select("invoice_id, payment_id, payments(id, code, method, reference, status)")
    .in(
      "invoice_id",
      invoices.map((invoice) => invoice.id),
    );
  if (allocationQuery.error) throw new Error(allocationQuery.error.message);

  const blocking: BlockingPayment[] = [];
  for (const allocation of allocationQuery.data ?? []) {
    // payment_allocations has exactly one FK to payments, so PostgREST embeds a
    // single object here rather than an array.
    const payment = allocation.payments as unknown as {
      id: string;
      code: string;
      method: string;
      reference: string | null;
      status: string;
    } | null;
    if (!payment || payment.status !== "confirmed") continue;
    const invoiceCode = invoiceCodeById.get(allocation.invoice_id);
    if (!invoiceCode) continue;
    blocking.push({
      id: payment.id,
      code: payment.code,
      invoiceCode,
      method: payment.method,
      reference: payment.reference,
    });
  }
  return blocking;
}

/** شركة المستأجر الذي أنشأ طلب الدفع، لتُكتب على الدفعات الجديدة. */
export async function tenantCompanyId(tenantId: string): Promise<string | null> {
  const tenantQuery = await supabaseAdmin
    .from("tenants")
    .select("company_id")
    .eq("id", tenantId)
    .single();
  if (tenantQuery.error) throw new Error(tenantQuery.error.message);
  return tenantQuery.data.company_id;
}

/**
 * مجموع ما سُجّل من دفعات لطلب دفع واحد، عدا دفعة الفائض نفسها.
 *
 * Every payment this settlement writes or adopts carries `payment_request_id`,
 * so this is what the ledger already holds of the captured charge. Counted from
 * the table rather than from the current run so a resumed or replayed callback
 * sees what an earlier, interrupted run wrote.
 */
export async function bookedForRequest(requestId: string, excessReference: string) {
  const paymentQuery = await supabaseAdmin
    .from("payments")
    .select("amount,reference")
    .eq("payment_request_id", requestId);
  if (paymentQuery.error) throw new Error(paymentQuery.error.message);
  return asMoney(
    paymentQuery.data
      .filter((payment) => payment.reference !== excessReference)
      .reduce((sum, payment) => sum + asMoney(payment.amount), 0),
  );
}
