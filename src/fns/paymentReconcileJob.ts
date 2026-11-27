import type { SupabaseClient } from "@supabase/supabase-js";

import { companyClient } from "@/company/companyClient.server";
import {
  getRequestCompany,
  requireRequestCompany,
  runWithRequestCompany,
} from "@/company/requestCompany.server";
import { settleGatewayPayment } from "@/fns/gatewaySettlement";
import { GatewayConnectionError, loadGatewayConnection } from "@/gateways/connectionStore.server";
import { gatewayRegistry } from "@/gateways/registry";
import type { Database } from "@/integrations/supabase/database.types";

/**
 * عدد الأيام التي يُستعلم فيها عن طلبات الدفع المعلّقة قبل عدّها مهجورة.
 *
 * Pending rows keep the window: a link nobody paid in a week should not cost a
 * gateway round-trip every tick forever. Superseded rows have no window because
 * their links remain payable at the gateway.
 */
const RECONCILE_WINDOW_DAYS = 7;

type ReconcileDb = SupabaseClient<Database>;

interface PendingRequest {
  code: string;
  gateway_connection_id: string | null;
  id: string;
  provider_invoice_id: string | null;
  provider_payment_id: string | null;
  status: string;
}

type ReconcileOutcome =
  | { kind: "settled" | "failed" | "unchanged" }
  | { kind: "skipped"; reason: string };

/**
 * يستعلم من محوّل الاتصال المسجّل على طلب الدفع عن حالته ويسوّيه عند الدفع.
 *
 * Loads the request's own `gateway_connection_id` so an in-flight payment
 * settles on its original connection even after the company switches gateways;
 * a missing or deleted connection leaves the request pending and is reported
 * without ever falling back to another connection.
 */
async function reconcileOneRequest(
  db: ReconcileDb,
  companyId: string,
  request: PendingRequest,
): Promise<ReconcileOutcome> {
  if (!request.gateway_connection_id) {
    return { kind: "skipped", reason: `${request.code}: missing gateway_connection_id` };
  }

  let loaded: Awaited<ReturnType<typeof loadGatewayConnection>>;
  try {
    loaded = await loadGatewayConnection(db, request.gateway_connection_id);
  } catch (error) {
    if (error instanceof GatewayConnectionError && error.code === "CONNECTION_NOT_FOUND") {
      return { kind: "skipped", reason: `${request.code}: ${error.message}` };
    }
    throw error;
  }

  const gateway = gatewayRegistry.create(loaded.connection);
  const status = await gateway.getPaymentStatus({
    providerInvoiceId: request.provider_invoice_id,
    providerPaymentId: request.provider_payment_id,
  });

  if (status.outcome === "paid") {
    await settleGatewayPayment(
      {
        eventType: "cron.reconcile",
        invoiceId: status.providerInvoiceId ?? request.provider_invoice_id,
        method: status.method ?? "card",
        paymentId: status.providerPaymentId ?? request.provider_payment_id,
        providerEventId: `reconcile:${request.code}`,
        status: "PAID",
      },
      status.raw,
      { companyId },
    );
    return { kind: "settled" };
  }

  // A superseded link that failed is simply dead; its row stays superseded
  // rather than looking like the selection's current request failed.
  if (status.outcome === "failed" && request.status === "pending") {
    const update = await db
      .from("payment_requests")
      .update({ status: "failed" })
      .eq("id", request.id)
      .eq("status", "pending");
    if (update.error) throw new Error(update.error.message);
    return { kind: "failed" };
  }

  // "pending" means the renter may still be mid-payment — leave it alone.
  return { kind: "unchanged" };
}

/**
 * يجمع طلبات الدفع التي يجب سؤال البوابة عنها لشركة محدّدة: المعلّقة ضمن النافذة والمُستبدَلة كلها.
 */
async function requestsToPoll(
  db: ReconcileDb,
  companyId: string,
  since: string,
): Promise<PendingRequest[]> {
  const columns =
    "id, code, provider_invoice_id, provider_payment_id, gateway_connection_id, status";
  const [pending, superseded] = await Promise.all([
    db
      .from("payment_requests")
      .select(columns)
      .eq("company_id", companyId)
      .eq("status", "pending")
      .not("provider_invoice_id", "is", null)
      .gt("created_at", since)
      .order("created_at"),
    db
      .from("payment_requests")
      .select(columns)
      .eq("company_id", companyId)
      .eq("status", "superseded")
      .not("provider_invoice_id", "is", null)
      .order("created_at"),
  ]);
  if (pending.error) throw new Error(pending.error.message);
  if (superseded.error) throw new Error(superseded.error.message);
  return [...(superseded.data ?? []), ...(pending.data ?? [])];
}

/**
 * ينفّذ حلقة المطابقة على طلبات شركة واحدة ويسجّل النتيجة في سجل المراجعة.
 */
async function executeCompanyReconcile(db: ReconcileDb, companyId: string) {
  const since = new Date(Date.now() - RECONCILE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const requests = await requestsToPoll(db, companyId, since);
  const errors: string[] = [];
  let settled = 0;
  let failed = 0;
  let skipped = 0;

  for (const request of requests) {
    try {
      const outcome = await reconcileOneRequest(db, companyId, request);
      if (outcome.kind === "settled") settled += 1;
      if (outcome.kind === "failed") failed += 1;
      if (outcome.kind === "skipped") {
        skipped += 1;
        errors.push(outcome.reason);
      }
    } catch (error) {
      // One unreachable request must not stop the rest: a gateway blip would
      // otherwise strand every later request until the next tick.
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${request.code}: ${message}`);
      console.error("[paymentReconcileJob] request failed", request.code, message);
    }
  }

  await db.rpc("write_audit", {
    p_action: "job.payment_reconcile",
    p_entity_type: "payment_request",
    p_entity_id: null,
    p_before: null,
    p_after: { count: requests.length, settled, failed, skipped, errors: errors.length },
    p_result: errors.length ? "failure" : "success",
    p_error_code: errors.length ? "RECONCILE_PARTIAL_FAILURE" : null,
  });

  return { count: requests.length, settled, failed, skipped, errors };
}

/**
 * يسوّي طلبات الدفع المعلّقة التي حُصّلت عبر البوابة لشركة محددة أو لشركة الطلب الحالي.
 *
 * `asOf` is ignored: this job asks each connection's gateway for live status.
 * The parameter exists because the shared cron signature passes it to every job.
 */
export async function runPaymentReconcileJob(_asOf: string | null = null, companyId?: string) {
  const activeCompany = getRequestCompany();
  const resolvedCompanyId = companyId ?? requireRequestCompany().id;
  // Payment settlement reconciliation may settle pending links even when suspended.
  const db = companyClient(resolvedCompanyId, { allowSuspended: true });

  if (activeCompany?.id === resolvedCompanyId) {
    return executeCompanyReconcile(db, resolvedCompanyId);
  }
  return runWithRequestCompany(
    {
      id: resolvedCompanyId,
      slug: activeCompany?.slug ?? "",
      status: "active",
      host: activeCompany?.host ?? "",
    },
    () => executeCompanyReconcile(db, resolvedCompanyId),
  );
}
