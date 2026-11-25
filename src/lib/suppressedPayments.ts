import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * الدفعات التي تلمس عقدًا مكبوتًا أو مخفيًا عن البوابة — استعلام خادم واحد يخدم مسارين.
 *
 * Which payments are tainted by such a contract is one rule, not two.
 * Both `notifyPaymentSuccess` (should the tenant be mailed?) and
 * `makeReceiptsVisibleToTenant` (should the receipt be flipped visible?) need
 * the same lookup: payment ids in, the subset touching a suppressed contract
 * out. Keeping it in one place means a change to the column name or to the
 * ANY-vs-ALL granularity is a one-line fix, not three.
 *
 * Throws on any database failure so callers can fail closed (do not expose a
 * roof receipt) while still making the failure observable via their own
 * logging, which matches this repository's existing `console.error` /
 * `console.warn` style in the webhook and notification paths. The helper
 * itself does not log — it has no opinion about what "observable" means for
 * its caller.
 */
/**
 * يربط الدفعات غير المخصّصة بفواتير طلب الدفع الذي جاءت منه.
 *
 * A gateway `#EXCESS` payment (Phase 2C) settles no invoice, so it has no
 * allocation to trace — yet it is money for the contract the tenant chose to
 * pay, and a hidden contract's excess must stay hidden too. Its request's
 * `requested_invoice_ids` names those invoices.
 */
async function requestedInvoiceLinks(
  paymentIds: readonly string[],
): Promise<Array<{ payment_id: string; invoice_id: string }>> {
  if (!paymentIds.length) return [];
  const paymentsResult = await supabaseAdmin
    .from("payments")
    .select("id, payment_request_id")
    .in("id", [...paymentIds]);
  if (paymentsResult.error) throw new Error(paymentsResult.error.message);
  const requestIdByPayment = new Map(
    ((paymentsResult.data ?? []) as Array<{ id: string; payment_request_id: string | null }>)
      .filter((payment) => payment.payment_request_id)
      .map((payment) => [payment.id, payment.payment_request_id as string]),
  );
  if (!requestIdByPayment.size) return [];

  const requestsResult = await supabaseAdmin
    .from("payment_requests")
    .select("id, requested_invoice_ids")
    .in("id", [...new Set(requestIdByPayment.values())]);
  if (requestsResult.error) throw new Error(requestsResult.error.message);
  const invoiceIdsByRequest = new Map(
    ((requestsResult.data ?? []) as Array<{ id: string; requested_invoice_ids: string[] }>).map(
      (request) => [request.id, request.requested_invoice_ids],
    ),
  );
  return [...requestIdByPayment].flatMap(([paymentId, requestId]) =>
    (invoiceIdsByRequest.get(requestId) ?? []).map((invoiceId) => ({
      payment_id: paymentId,
      invoice_id: invoiceId,
    })),
  );
}

export async function getSuppressedPaymentIds(paymentIds: readonly string[]): Promise<Set<string>> {
  if (!paymentIds.length) return new Set();

  const allocationsResult = await supabaseAdmin
    .from("payment_allocations")
    .select("payment_id, invoice_id")
    .in("payment_id", [...paymentIds]);
  if (allocationsResult.error) throw new Error(allocationsResult.error.message);
  const allocated = (allocationsResult.data ?? []) as Array<{
    payment_id: string;
    invoice_id: string;
  }>;
  const allocatedIds = new Set(allocated.map((row) => row.payment_id));
  const allocations = [
    ...allocated,
    ...(await requestedInvoiceLinks(paymentIds.filter((id) => !allocatedIds.has(id)))),
  ];
  if (!allocations.length) return new Set();

  const invoiceIds = [...new Set(allocations.map((row) => row.invoice_id))];
  const invoicesResult = await supabaseAdmin
    .from("invoices")
    .select("id, contract_id")
    .in("id", invoiceIds);
  if (invoicesResult.error) throw new Error(invoicesResult.error.message);
  const invoices = (invoicesResult.data ?? []) as Array<{ id: string; contract_id: string | null }>;

  const contractIds = [
    ...new Set(
      invoices.map((invoice) => invoice.contract_id).filter((id): id is string => Boolean(id)),
    ),
  ];
  if (!contractIds.length) return new Set();

  const contractsResult = await supabaseAdmin
    .from("contracts")
    .select("id, suppress_tenant_billing_docs, hide_from_portal")
    .in("id", contractIds);
  if (contractsResult.error) throw new Error(contractsResult.error.message);
  const suppressedContractIds = new Set<string>();
  for (const row of (contractsResult.data ?? []) as Array<{
    id: string;
    suppress_tenant_billing_docs: boolean | null;
    hide_from_portal: boolean | null;
  }>) {
    // Either flag taints the payment. Review round 4 on PR #209: this helper
    // still read only the older one, so a staff-generated KNET link on a
    // contract hidden but never suppressed had its receipt hidden by migration
    // 214's trigger and then flipped straight back to visible by
    // `makeReceiptsVisibleToTenant` — which also mails the tenant the PDF
    // through `notifyPaymentSuccess`. The trigger and this helper have to agree,
    // because the webhook runs after the allocation.
    if (row.suppress_tenant_billing_docs === true || row.hide_from_portal === true) {
      suppressedContractIds.add(row.id);
    }
  }
  if (!suppressedContractIds.size) return new Set();

  const invoiceContractById = new Map(invoices.map((invoice) => [invoice.id, invoice.contract_id]));
  const suppressedPaymentIds = new Set<string>();
  for (const allocation of allocations) {
    const contractId = invoiceContractById.get(allocation.invoice_id);
    if (contractId && suppressedContractIds.has(contractId)) {
      suppressedPaymentIds.add(allocation.payment_id);
    }
  }
  return suppressedPaymentIds;
}
