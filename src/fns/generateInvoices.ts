import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requirePermission } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/database.types";
import { enqueueJob } from "@/jobs/enqueue";
import type { QueuedBulkJob } from "@/jobs/handlers/bulk";

/**
 * حالات طلب المهمة التي يعني أن العمل فيها لم ينتهِ بعد.
 *
 * `skipped` is terminal like `succeeded`: a skipped request ran its course and
 * must never block the next click.
 */
const IN_FLIGHT_JOB_STATES = ["pending", "published", "running"] as const;

/**
 * نتيجة حجز توليد ضخم: مهمة محجوزة، وعلامة أن مهمة مماثلة كانت لا تزال تعمل.
 *
 * `alreadyRunning` is set instead of enqueueing when a request for the same
 * year/period is still in flight: the click is answered with the running job's
 * id rather than a second run of the same scope.
 */
export type QueuedGenerateJob = QueuedBulkJob & { alreadyRunning?: true };

/**
 * يبحث عن طلب مهمة غير منتهٍ لنفس النوع والحمولة، لمنع حجز تشغيل ثانٍ متزامن.
 *
 * The bulk dedupe key is per click (a fresh request nonce, GR-001), so the key
 * itself can no longer stop a second run of the same year/period — this lookup
 * is the guard instead. Terminal rows (`succeeded`, `failed`, `skipped`) never
 * block: re-running a finished or failed period is exactly what the button is
 * for. `enqueue_job`'s `on conflict do nothing` cannot serve as the guard,
 * because job_requests rows are never purged and a stale terminal row would
 * answer every later click with a dead job id.
 */
export async function findInFlightJobRequest(
  db: SupabaseClient<Database>,
  companyId: string,
  kind: "invoices.generate" | "electricity.generate",
  payloadMatch: Record<string, unknown>,
): Promise<{ id: string } | null> {
  const { data, error } = await db
    .from("job_requests")
    .select("id, payload")
    .eq("company_id", companyId)
    .eq("kind", kind)
    .in("status", [...IN_FLIGHT_JOB_STATES]);
  if (error) {
    throw new Error(`job_requests(${kind}) in-flight lookup failed: ${error.message}`);
  }
  const matches = (payload: Record<string, unknown>): boolean =>
    Object.entries(payloadMatch).every(([key, value]) => payload[key] === value);
  const row = (data ?? []).find((candidate) =>
    matches((candidate.payload ?? {}) as Record<string, unknown>),
  );
  return row ? { id: row.id } : null;
}

/**
 * يولّد فواتير سنة كاملة خارج الطلب: يتحقق ثم يحجز مهمة `invoices.generate`.
 *
 * The request no longer generates anything: it validates, checks the
 * permission, and hands one `invoices.generate` job to the worker
 * (contracts/jobs.md section 1), which processes the contracts in chunks of
 * 200 and reports the counts back as the requester's notice. A year of
 * invoices is thousands of inserts; none of them block the browser now.
 *
 * The dedupe key carries a fresh request nonce (contracts/jobs.md section 5),
 * so every click queues its own job: re-running a finished year regenerates
 * idempotently instead of being answered with a dead job id. A click while the
 * same year is still in flight is answered with the running job's id and
 * `alreadyRunning`, so one scope never runs twice at once.
 */
const schema = z.object({
  year: z.number().int().min(2000).max(2100),
});

export type GenerateInvoicesInput = z.infer<typeof schema>;

export const generateInvoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }): Promise<QueuedGenerateJob> => {
    await requirePermission(context, {
      code: "invoices.create",
      attempted: "invoice.generate",
      refusal: "You do not have permission to generate invoices.",
    });

    const company = requireRequestCompany();
    const db = companyClient(company.id);

    const inFlight = await findInFlightJobRequest(db, company.id, "invoices.generate", {
      year: data.year,
    });
    if (inFlight) {
      return { queued: true, jobRequestId: inFlight.id, alreadyRunning: true };
    }

    const requestId = crypto.randomUUID();
    const { jobId } = await enqueueJob(
      db,
      "invoices.generate",
      { year: data.year },
      { dedupeKey: `invoices.generate:${data.year}:${requestId}`, requestedBy: context.userId },
    );

    return { queued: true, jobRequestId: jobId };
  });
