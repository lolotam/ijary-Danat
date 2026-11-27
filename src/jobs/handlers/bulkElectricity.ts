import type { SupabaseClient } from "@supabase/supabase-js";

import { companyClient } from "@/company/companyClient.server";
import { runWithRequestCompany } from "@/company/requestCompany.server";
import type { Database } from "@/integrations/supabase/database.types";
import type { JobPayload } from "@/jobs/catalog";
import type { JobHandler, JobHandlerContext } from "@/worker/runJob";

import { hasSqlState, runInChunks, type BulkRunResult } from "./bulkChunks";

/** وحدة لها عدّاد كهرباء نشط: معرّفها فقط، والتصفية كاملة في SQL. */
interface UnitRow {
  id: string;
}

/**
 * يبني معالج مهمة `electricity.generate`: يولّد رسوم كهرباء فترة واحدة،
 * وحدةً وحدة، على دفعات من 200 وحدة.
 *
 * The request only enqueued the period (contracts/jobs.md section 5: dedupe
 * in-flight only — the handler is idempotent per unit, so a re-run after a
 * finish is safe). Each unit's charges come from `generate_electricity_charges`,
 * whose insert is guarded by the unique `(meter_id, period_year, period_month)`
 * constraint with `on conflict do nothing`, so a retry after a crash
 * re-processes the same units and creates no second charge. `created` counts
 * charges actually inserted — the RPC returns only new rows.
 */
export function createElectricityGenerateHandler(): JobHandler {
  return async (ctx: JobHandlerContext) => {
    const { period } = ctx.payload as JobPayload<"electricity.generate">;
    return runWithRequestCompany(
      { id: ctx.companyId, slug: "", status: "active", host: "" },
      async () => {
        const db = companyClient(ctx.companyId);
        const year = Number(period.slice(0, 4));
        const month = Number(period.slice(5, 7));
        return runInChunks<UnitRow>(
          (offset, limit) => loadUnitsWithMeters(db, offset, limit),
          (chunk) => generateForUnits(db, chunk, year, month),
        );
      },
    );
  };
}

/**
 * يقرأ الوحدات ذات العدّادات النشطة — نطاق التوليد — مرتّبةً بالمعرّف.
 *
 * The readings' period is left to the RPC: a unit whose meter read nothing
 * this period is a legitimate `skipped` (its generator call inserts nothing),
 * and keeping this read to the meter join makes the pagination a stable list
 * of units that inserts cannot reorder.
 */
async function loadUnitsWithMeters(
  db: SupabaseClient<Database>,
  offset: number,
  limit: number,
): Promise<UnitRow[]> {
  const { data, error } = await db
    .from("units")
    .select("id, electricity_meters!inner(id)")
    .eq("electricity_meters.is_active", true)
    .order("id")
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`electricity.generate load failed: ${error.message}`);
  return (data ?? []) as UnitRow[];
}

/**
 * يولّد رسوم وحدات دفعة واحدة ويجمع العدّادات.
 *
 * A unit whose generator refuses with a SQLSTATE is that unit's data problem
 * (counted `failed`, chunk continues); an error with no SQLSTATE is a system
 * failure thrown wrapped with the call name, like the load above —
 * `hasSqlState` classifies the Supabase error before the wrap — so the job
 * retries instead of ending "succeeded" with nothing done.
 */
async function generateForUnits(
  db: SupabaseClient<Database>,
  chunk: readonly UnitRow[],
  year: number,
  month: number,
): Promise<BulkRunResult> {
  const outcome: BulkRunResult = { created: 0, skipped: 0, failed: 0, errors: [] };
  for (const unit of chunk) {
    const { data, error } = await db.rpc("generate_electricity_charges", {
      p_period_year: year,
      p_period_month: month,
      p_unit_id: unit.id,
    });
    if (error) {
      if (hasSqlState(error)) {
        outcome.failed += 1;
        outcome.errors.push(`generate_electricity_charges(${unit.id}) failed: ${error.message}`);
        continue;
      }
      throw new Error(`generate_electricity_charges(${unit.id}) failed: ${error.message}`);
    }
    if (data && data.length) outcome.created += data.length;
    else outcome.skipped += 1;
  }
  return outcome;
}
