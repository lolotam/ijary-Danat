import { fetchGatewayPaymentStatus, paymentOutcome } from "@/fns/confirmGatewayPayment";
import { gatewayConfigFromEnv } from "@/fns/myfatoorahGateway";
import { normalizeMethod, settleGatewayPayment } from "@/fns/myfatoorahWebhook";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Reconcile payment requests the gateway settled but the app never heard about.
 *
 * Settlement is otherwise reachable only from `confirmGatewayPayment`, which
 * needs an authenticated browser sitting on the portal callback page. A tenant
 * who pays a link without signing in — or who simply closes the tab — leaves the
 * money taken and the invoice unpaid, with no path that ever corrects it. The
 * webhook was meant to be that path and had not fired once in production as of
 * 2026-08-06 (`webhook_events` was empty).
 *
 * So this job is the liveness guarantee for the whole gateway money path, not a
 * convenience. It is idempotent: `settleGatewayPayment` returns immediately for
 * a request already marked completed.
 */
const RECONCILE_WINDOW_DAYS = 7;

type PendingRequest = {
  code: string;
  id: string;
  provider_invoice_id: string | null;
  status: string;
};

/**
 * Ask the gateway about one request and act on the answer.
 *
 * Returns which counter the caller should bump, so the decision about what a
 * gateway status *means* stays here and the tallying stays in the job.
 */
async function reconcileOneRequest(
  config: ReturnType<typeof gatewayConfigFromEnv>,
  request: PendingRequest,
): Promise<"settled" | "failed" | "unchanged"> {
  const status = await fetchGatewayPaymentStatus(config, request.provider_invoice_id as string);
  const outcome = paymentOutcome(status.invoiceStatus, status.transactionStatus);

  if (outcome === "paid") {
    await settleGatewayPayment(
      {
        eventType: "cron.reconcile",
        invoiceId: status.invoiceId,
        method: normalizeMethod(status.methodRaw) ?? "card",
        paymentId: status.providerPaymentId,
        providerEventId: `reconcile:${request.code}`,
        status: status.invoiceStatus ?? status.transactionStatus ?? "PAID",
      },
      status.raw,
    );
    return "settled";
  }

  // A superseded link that failed is simply dead; its row stays superseded
  // rather than looking like the selection's current request failed.
  if (outcome === "failed" && request.status === "pending") {
    const update = await supabaseAdmin
      .from("payment_requests")
      .update({ status: "failed" })
      .eq("id", request.id)
      .eq("status", "pending");
    if (update.error) throw new Error(update.error.message);
    return "failed";
  }

  // "pending" means the tenant may still be mid-payment — leave it alone.
  return "unchanged";
}

/**
 * يجمع طلبات الدفع التي يجب سؤال البوابة عنها: المعلّقة ضمن النافذة، والمُستبدَلة كلها.
 *
 * Pending rows keep the window: that is their abandonment rule — a link
 * nobody paid in a week should not cost a gateway round-trip every tick
 * forever. Superseded rows have no window: their links stay payable at the
 * gateway, and while the webhook does not settle, this job is the only thing
 * that records a charge on one (migration 223). They are polled until they
 * settle. Fine at today's scale (~22 payment_requests in total); revisit if
 * superseded rows reach the hundreds.
 */
async function requestsToPoll(since: string): Promise<PendingRequest[]> {
  const [pending, superseded] = await Promise.all([
    supabaseAdmin
      .from("payment_requests")
      .select("id, code, provider_invoice_id, status")
      .eq("status", "pending")
      .not("provider_invoice_id", "is", null)
      .gt("created_at", since)
      .order("created_at"),
    supabaseAdmin
      .from("payment_requests")
      .select("id, code, provider_invoice_id, status")
      .eq("status", "superseded")
      .not("provider_invoice_id", "is", null)
      .order("created_at"),
  ]);
  if (pending.error) throw new Error(pending.error.message);
  if (superseded.error) throw new Error(superseded.error.message);
  return [...(superseded.data ?? []), ...(pending.data ?? [])];
}

/**
 * `asOf` is ignored: this job asks the gateway for live transaction status, and
 * there is no such thing as "what did MyFatoorah think last Tuesday". The
 * parameter exists only because the shared JOBS map passes it to every job.
 */
export async function runPaymentReconcileJob(_asOf: string | null = null) {
  const config = gatewayConfigFromEnv();
  const since = new Date(Date.now() - RECONCILE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const requests = await requestsToPoll(since);
  const errors: string[] = [];
  let settled = 0;
  let failed = 0;

  for (const request of requests) {
    try {
      const outcome = await reconcileOneRequest(config, request);
      if (outcome === "settled") settled += 1;
      if (outcome === "failed") failed += 1;
    } catch (error) {
      // One unreachable request must not stop the rest: a gateway blip would
      // otherwise strand every later request until the next tick.
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${request.code}: ${message}`);
      console.error("[paymentReconcileJob] request failed", request.code, message);
    }
  }

  await supabaseAdmin.rpc("write_audit", {
    p_action: "job.payment_reconcile",
    p_entity_type: "payment_request",
    p_entity_id: null,
    p_before: null,
    p_after: { count: requests.length, settled, failed, errors: errors.length },
    p_result: errors.length ? "failure" : "success",
    p_error_code: errors.length ? "RECONCILE_PARTIAL_FAILURE" : null,
  });

  return { count: requests.length, settled, failed, errors };
}
