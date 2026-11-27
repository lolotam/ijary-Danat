import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requirePermission } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { enqueueJob } from "@/jobs/enqueue";
import type { QueuedBulkJob } from "@/jobs/handlers/bulk";

const schema = z.object({ contractId: z.string().uuid() });

export type RegenerateContractInvoicesInput = z.infer<typeof schema>;

/** What the engine did to each invoice it considered. */
export type RegenerationAction =
  | "updated"
  | "inserted"
  | "cancelled"
  | "deleted"
  | "skipped"
  | "blocked";

export interface RegenerationSummary {
  updated: number;
  inserted: number;
  cancelled: number;
  deleted: number;
  skipped: number;
  blocked: number;
}

/**
 * Counts by action.
 *
 * Reported instead of a single total because the cancellations are exactly the
 * rows a human needs to look at — an invoice that left the contract's range
 * while still carrying money or a live payment link. A bare count would bury
 * them among routine updates.
 *
 * `blocked` (migration 139) is the same idea one step further: a month the
 * contract says is billable but which the engine refuses to touch — a
 * discounted invoice sitting inside a newly-free month, or a month whose only
 * invoice is cancelled and must not be resurrected automatically. Reporting a
 * clean result for those would claim a synchronisation that did not happen.
 */
export function summarizeRegeneration(
  rows: ReadonlyArray<{ action: string }> | null | undefined,
): RegenerationSummary {
  const summary: RegenerationSummary = {
    updated: 0,
    inserted: 0,
    cancelled: 0,
    deleted: 0,
    skipped: 0,
    blocked: 0,
  };
  for (const row of rows ?? []) {
    if (row.action in summary) summary[row.action as RegenerationAction] += 1;
  }
  return summary;
}

/**
 * يوحّد فواتير عقد بعد تغيّره، خارج الطلب: يتحقق ثم يحجز مهمة
 * `invoices.regenerate`.
 *
 * The request no longer reconciles anything: it validates, checks the
 * permission, reads the contract so a wrong id fails here and not in a job
 * that would fail a minute later with nothing on screen, and hands one
 * `invoices.regenerate` job to the worker (contracts/jobs.md section 1).
 *
 * Each request mints its own `requestId`, and the dedupe key is contract +
 * request id (contracts/jobs.md section 5): an admin editing a contract twice
 * in a row gets two jobs, while a double-click of one submit queues one.
 *
 * The permission stays at this boundary rather than in a database trigger:
 * the underlying function requires `invoices.create`, and an accountant holds
 * `contracts.update` without it — a trigger would raise 42501 inside their
 * contract save and abort it. The save succeeds and only the reconciliation
 * is refused.
 */
export const regenerateContractInvoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }): Promise<QueuedBulkJob> => {
    await requirePermission(context, {
      code: "invoices.create",
      attempted: "invoice.regenerate",
      refusal: "You do not have permission to regenerate contract invoices.",
    });

    const company = requireRequestCompany();
    const db = companyClient(company.id);

    const contractRes = await db.from("contracts").select("id").eq("id", data.contractId).single();
    if (contractRes.error || !contractRes.data) {
      throw new Error(contractRes.error?.message ?? "Contract not found");
    }

    const requestId = crypto.randomUUID();
    const { jobId } = await enqueueJob(
      db,
      "invoices.regenerate",
      { contractId: data.contractId, requestId },
      {
        dedupeKey: `invoices.regenerate:${data.contractId}:${requestId}`,
        requestedBy: context.userId,
      },
    );

    return { queued: true, jobRequestId: jobId };
  });
