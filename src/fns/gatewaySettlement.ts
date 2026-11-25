import { notifyPaymentSuccess } from "@/fns/notifyPaymentSuccess";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json, Tables } from "@/integrations/supabase/database.types";
import { classifyBlockingPayments } from "@/lib/gatewayReconciliation";

import {
  asMoney,
  blockingPaymentsForInvoices,
  bookedForRequest,
  type EventDetails,
  existingPaymentsByReference,
  findPaymentRequest,
  invoicePaymentReference,
  orderedRequestInvoices,
  paymentIsAllocated,
  tenantCompanyId,
} from "./gatewaySettlementReads";
import {
  adoptPlaceholderPayments,
  allocatePaymentToInvoice,
  createConfirmedPaymentForInvoice,
  excessPaymentReference,
  finalizePaymentRequest,
  linkPaymentRequest,
  makeReceiptsVisibleToTenant,
  recordGatewayExcess,
} from "./gatewaySettlementWrites";

export { invoicePaymentReference, type EventDetails };

/*
 * تسوية دفعة البوابة: من حدث ماي فاتورة الموثَّق إلى دفعات مؤكدة مخصّصة للفواتير.
 *
 * Split out of `fns/myfatoorahWebhook.ts` (audit M2). Three callers settle
 * through here — the webhook, the portal's payment-confirmation page and the
 * reconcile cron — and none of them is the webhook's transport concern. The
 * webhook keeps parsing, signature checking and event bookkeeping; this file
 * keeps the money. Reads and writes live in `gatewaySettlementReads.ts` and
 * `gatewaySettlementWrites.ts`; the order they run in lives here.
 */

/**
 * يقرّر أي دفعة تُربط بالفاتورة: موجودة أو جديدة.
 *
 * Which payment a zero-balance settlement should attach itself to.
 *
 * Adopts admin placeholders when that is what is holding the balance down, and
 * reports which ids it adopted so the caller can owe them a receipt.
 */
async function resolvePaymentToAttach(input: {
  details: EventDetails;
  existingPaymentIds: string[];
  invoices: Tables<"invoices">[];
  invoicesMissing: boolean;
  paymentRequest: Tables<"payment_requests">;
  referencePrefix: string;
}): Promise<{ adoptedIds: string[]; conflict: boolean; paymentId: string | null }> {
  const alreadyAttached =
    input.existingPaymentIds[0] ?? input.paymentRequest.resulting_payment_id ?? null;
  if (alreadyAttached) return { adoptedIds: [], conflict: false, paymentId: alreadyAttached };

  const decision = classifyBlockingPayments(await blockingPaymentsForInvoices(input.invoices));
  if (decision.kind === "none") {
    // Invoices deleted after the link was issued leave nothing to attach to,
    // and the charge is real: it goes to excess like a conflict does.
    if (input.invoicesMissing) return { adoptedIds: [], conflict: true, paymentId: null };
    throw new Error(
      `Payment request ${input.paymentRequest.code} has nothing left to settle and no payment to attach.`,
    );
  }
  if (decision.kind === "conflict") {
    // A real payment already covers this invoice AND the gateway charged the
    // tenant. That is a double payment, and choosing which one to refund is a
    // human decision. Nothing about the existing payment changes; the caller
    // records the gateway's money as an unallocated excess payment so it is no
    // longer invisible (Phase 2C).
    console.error(
      "[settleGatewayPayment] gateway charge collides with an existing payment",
      JSON.stringify({
        paymentRequest: input.paymentRequest.code,
        conflictingPayment: decision.conflicting.code,
        conflictingReference: decision.conflicting.reference,
        invoice: decision.conflicting.invoiceCode,
      }),
    );
    return { adoptedIds: [], conflict: true, paymentId: decision.conflicting.id };
  }

  const adoptedIds = await adoptPlaceholderPayments(
    decision.payments,
    input.details.method ?? "card",
    input.referencePrefix,
    input.paymentRequest.id,
  );
  return { adoptedIds, conflict: false, paymentId: adoptedIds[0] };
}

/**
 * يُكمل طلب دفع سبق تسديده دون إنشاء دفعات مكرّرة.
 *
 * Settle a request whose requested invoices already carry no balance.
 *
 * Two ways that happens: a newer request settled them, or an admin ticked
 * "mark as paid" while waiting for a settlement that never arrived. Only the
 * second needs the gateway's own method written back over the placeholder's
 * `cash`, and only the second owes anyone a receipt.
 */
async function settleAlreadyPaidRequest(input: {
  details: EventDetails;
  existingPaymentIds: string[];
  invoices: Tables<"invoices">[];
  invoicesMissing: boolean;
  payload: Json;
  paymentRequest: Tables<"payment_requests">;
  referencePrefix: string;
}) {
  const { adoptedIds, conflict, paymentId } = await resolvePaymentToAttach(input);

  // Adopted placeholders now carry this request's id, so they count as booked;
  // a conflicting payment does not, so its whole charge is recorded as excess.
  const excessId = await recordGatewayExcess({
    booked: await bookedForRequest(
      input.paymentRequest.id,
      excessPaymentReference(input.referencePrefix),
    ),
    companyId: await tenantCompanyId(input.paymentRequest.tenant_id),
    details: input.details,
    paymentRequest: input.paymentRequest,
    referencePrefix: input.referencePrefix,
  });
  if (excessId) await makeReceiptsVisibleToTenant([excessId]);
  // The request's money went to the excess payment, not to the payment it
  // collided with, so point the request at what it actually produced.
  const resultingPaymentId = conflict ? (excessId ?? paymentId) : paymentId;
  if (!resultingPaymentId) {
    throw new Error(`Settlement produced no payments for ${input.paymentRequest.code}.`);
  }

  await finalizePaymentRequest({
    details: input.details,
    paymentId: resultingPaymentId,
    paymentRequest: input.paymentRequest,
    payload: input.payload,
  });

  // Adoption is the first moment this settlement is recorded as a gateway
  // payment, so it is also the first moment a receipt is owed.
  if (adoptedIds.length) {
    await makeReceiptsVisibleToTenant(adoptedIds);
    const notifyResult = await notifyPaymentSuccess(adoptedIds);
    if (!notifyResult.ok) {
      console.error("Payment notifications failed:", notifyResult.error);
    }
  }
}

/** يسوّي دفعة البوابة الموثّقة: دفعات مؤكدة مخصّصة للفواتير. */
export async function settleGatewayPayment(details: EventDetails, payload: Json) {
  // Successful gateway charges always settle as some method; default to card so a
  // missing PaymentGateway label cannot leave a paid MyFatoorah invoice orphaned.
  const settledDetails: EventDetails = {
    ...details,
    method: details.method ?? "card",
  };
  const paymentRequest = await findPaymentRequest(
    settledDetails.invoiceId,
    settledDetails.paymentId,
  );
  if (!paymentRequest) throw new Error("No payment request matches this webhook.");
  if (paymentRequest.status === "completed") return true;
  const referencePrefix = `MF:${settledDetails.paymentId ?? settledDetails.invoiceId ?? paymentRequest.code}`;
  const { invoices, missingInvoiceIds } = await orderedRequestInvoices(paymentRequest);
  if (missingInvoiceIds.length) {
    console.error(
      "[settleGatewayPayment] requested invoices no longer exist; their share becomes excess",
      JSON.stringify({ paymentRequest: paymentRequest.code, missingInvoiceIds }),
    );
  }

  // One payment record per invoice month. A tenant settling several months in
  // a single gateway transaction therefore gets a separate payment row per
  // month, which is what the ledger and the monthly reports expect.
  const references = invoices.map((invoice) =>
    invoicePaymentReference(referencePrefix, invoice.code),
  );
  const existingPayments = await existingPaymentsByReference(references);

  // Work items: resume orphan payments (created but not allocated) and settle
  // months that still have a balance. Skip invoices already paid outside this
  // gateway charge so a partially-superseded multi-month PREQ can still finish.
  type WorkItem = {
    invoice: Tables<"invoices">;
    paymentId: string | null;
    reference: string;
  };
  const work: WorkItem[] = [];
  for (const [index, invoice] of invoices.entries()) {
    const reference = references[index];
    const existingId = existingPayments.get(reference)?.id ?? null;
    if (existingId) {
      work.push({ invoice, paymentId: existingId, reference });
      continue;
    }
    if (asMoney(invoice.balance) > 0) {
      work.push({ invoice, paymentId: null, reference });
    }
  }

  if (work.length === 0) {
    await settleAlreadyPaidRequest({
      details: settledDetails,
      existingPaymentIds: [...existingPayments.values()].map((payment) => payment.id),
      invoices,
      invoicesMissing: missingInvoiceIds.length > 0,
      payload,
      paymentRequest,
      referencePrefix,
    });
    return false;
  }

  // The gateway charged `paymentRequest.amount`; months are booked at their
  // CURRENT balance, capped at what is left of that charge. This replaces a
  // throw that fired when the balances no longer summed to the charge: it left
  // money MyFatoorah had already taken unbooked until someone intervened.
  // Over-collection becomes an excess payment below; a balance that grew after
  // the link was issued is left partly open rather than booked beyond the money.
  const captured = asMoney(paymentRequest.amount);
  let bookedSoFar = asMoney(
    work.reduce((sum, item) => sum + (existingPayments.get(item.reference)?.amount ?? 0), 0),
  );
  const companyId = await tenantCompanyId(paymentRequest.tenant_id);

  const paymentIds: string[] = [];
  for (const item of work) {
    let paymentId = item.paymentId;
    let paymentAmount = existingPayments.get(item.reference)?.amount ?? 0;
    if (!paymentId) {
      // Re-read so we never create a zero-amount row after a concurrent settle.
      const freshForCreate = await supabaseAdmin
        .from("invoices")
        .select("*")
        .eq("id", item.invoice.id)
        .single();
      if (freshForCreate.error) throw new Error(freshForCreate.error.message);
      paymentAmount = asMoney(
        Math.min(asMoney(freshForCreate.data.balance), captured - bookedSoFar),
      );
      if (paymentAmount <= 0) continue;
      paymentId = await createConfirmedPaymentForInvoice({
        amount: paymentAmount,
        companyId,
        details: settledDetails,
        invoice: freshForCreate.data,
        paymentReference: item.reference,
        paymentRequest,
      });
      bookedSoFar = asMoney(bookedSoFar + paymentAmount);
    }
    // Re-read balance; if a concurrent allocation already zeroed it, skip.
    if (!(await paymentIsAllocated(paymentId, item.invoice.id))) {
      const fresh = await supabaseAdmin
        .from("invoices")
        .select("*")
        .eq("id", item.invoice.id)
        .single();
      if (fresh.error) throw new Error(fresh.error.message);
      const allocation = asMoney(Math.min(paymentAmount, asMoney(fresh.data.balance)));
      if (allocation > 0) {
        try {
          await allocatePaymentToInvoice(paymentId, fresh.data, allocation);
        } catch (allocateError) {
          // Idempotent resume: a concurrent worker may have allocated already.
          if (!(await paymentIsAllocated(paymentId, item.invoice.id))) {
            throw allocateError;
          }
        }
      }
    }
    paymentIds.push(paymentId);
  }

  const excessId = await recordGatewayExcess({
    booked: await bookedForRequest(paymentRequest.id, excessPaymentReference(referencePrefix)),
    companyId,
    details: settledDetails,
    paymentRequest,
    referencePrefix,
  });

  // Every month can have been paid by someone else mid-run; then the whole
  // charge is excess and that payment is what the request produced.
  const primaryPaymentId = paymentIds[0] ?? excessId;
  if (!primaryPaymentId) {
    throw new Error(`Settlement produced no payments for ${paymentRequest.code}.`);
  }

  // payment_requests carries a single resulting payment; the first month's
  // payment represents the settlement and owns the receipt lookup.
  await linkPaymentRequest(paymentRequest, settledDetails, primaryPaymentId);
  // The excess payment's receipt is shown like the others, but it is left out
  // of the "payment received" notification below: that message names the
  // invoices a payment settled, and this one settled none.
  await makeReceiptsVisibleToTenant(excessId ? [...paymentIds, excessId] : paymentIds);
  await finalizePaymentRequest({
    details: settledDetails,
    paymentId: primaryPaymentId,
    paymentRequest,
    payload,
  });

  // Best-effort: admin + tenant receipt notifications (email/WhatsApp + log).
  if (paymentIds.length) {
    const notifyResult = await notifyPaymentSuccess(paymentIds);
    if (!notifyResult.ok) {
      console.error("Payment notifications failed:", notifyResult.error);
    }
  }

  return false;
}
