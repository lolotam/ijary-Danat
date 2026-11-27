import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requirePermission } from "@/fns/requirePermission";
import { findInFlightJobRequest, type QueuedGenerateJob } from "@/fns/generateInvoices";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { enqueueJob } from "@/jobs/enqueue";

const generateElectricityChargesSchema = z.object({
  periodMonth: z.number().int().min(1).max(12),
  periodYear: z.number().int().min(2000).max(2200),
  unitId: z.string().uuid().nullable().optional(),
});

export type GenerateElectricityChargesInput = z.infer<typeof generateElectricityChargesSchema>;

/**
 * نتيجة التوليد: عمل ضخم حُجز للعامل، أو توليد وحدة واحدة تمّ في الطلب.
 *
 * The catalogue payload for `electricity.generate` carries the period only
 * (contracts/jobs.md section 5), so a single-unit scope cannot travel to the
 * worker. A one-unit generation is one idempotent RPC call, not bulk work, so
 * it stays here and keeps answering immediately; the whole-period run — the
 * bulk case — is the queued one.
 */
export type GenerateElectricityChargesResult =
  | QueuedGenerateJob
  | { queued: false; created: number };

/**
 * يولّد رسوم كهرباء لفترة — خارج الطلب للنطاق الكامل، وفي الطلب لوحدة واحدة.
 *
 * The whole-period request validates, checks the permission, and hands one
 * `electricity.generate` job to the worker, which processes the units in
 * chunks of 200 (contracts/jobs.md section 1). The dedupe key carries a fresh
 * request nonce (section 5), so every click queues its own job — more readings
 * can land after an earlier run, and a failed run must be re-runnable. A click
 * while the same period is still in flight is answered with the running job's
 * id and `alreadyRunning` instead of a second run.
 */
export const generateElectricityCharges = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(generateElectricityChargesSchema)
  .handler(async ({ data, context }): Promise<GenerateElectricityChargesResult> => {
    await requirePermission(context, {
      code: "electricity.create",
      attempted: "electricity.generate_charges",
      refusal: "You do not have permission to generate electricity charges.",
    });

    const company = requireRequestCompany();
    const db = companyClient(company.id);

    if (data.unitId) {
      const generatedCharges = await db.rpc("generate_electricity_charges", {
        p_period_month: data.periodMonth,
        p_period_year: data.periodYear,
        p_unit_id: data.unitId,
      });
      if (generatedCharges.error) throw new Error(generatedCharges.error.message);
      return { queued: false, created: generatedCharges.data?.length ?? 0 };
    }

    const period = `${data.periodYear}-${String(data.periodMonth).padStart(2, "0")}`;
    const inFlight = await findInFlightJobRequest(db, company.id, "electricity.generate", {
      period,
    });
    if (inFlight) {
      return { queued: true, jobRequestId: inFlight.id, alreadyRunning: true };
    }

    const requestId = crypto.randomUUID();
    const { jobId } = await enqueueJob(
      db,
      "electricity.generate",
      { period },
      { dedupeKey: `electricity.generate:${period}:${requestId}`, requestedBy: context.userId },
    );

    return { queued: true, jobRequestId: jobId };
  });
