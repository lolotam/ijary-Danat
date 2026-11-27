import type { SupabaseClient } from "@supabase/supabase-js";

import { companyClient } from "@/company/companyClient.server";
import { runWithRequestCompany } from "@/company/requestCompany.server";
import { summarizeRegeneration, type RegenerationSummary } from "@/fns/regenerateContractInvoices";
import type { Database } from "@/integrations/supabase/database.types";
import type { JobPayload } from "@/jobs/catalog";
import type { JobHandler, JobHandlerContext } from "@/worker/runJob";

import { hasSqlState, runInChunks, type BulkRunResult } from "./bulkChunks";

/** عقد يحتاج توليد فواتيره: معرّفه فقط، والقرار كله في وظائف SQL. */
interface ContractRow {
  id: string;
}

/** نتيجة مهمة `invoices.regenerate`: العدّادات ومعها ملخّص أفعال المحرّك. */
interface RegenerateRunResult extends BulkRunResult {
  summary: RegenerationSummary;
}

/**
 * يبني معالج مهمة `invoices.generate`: يولّد فواتير سنة كاملة، عقداً عقداً،
 * على دفعات من 200 عقد.
 *
 * The request only enqueued the year (contracts/jobs.md section 5: dedupe
 * in-flight only — the handler is idempotent per contract, so a re-run after a
 * finish is safe); the generator SQL does the real work per contract
 * (`generate_invoices`), and its insert is guarded by the unique
 * `(contract_id, period_year, period_month)` constraint, so a retry after a
 * crash re-reads the same contracts and creates nothing twice. `created`
 * counts invoices actually inserted — the RPC returns only new rows.
 */
export function createInvoicesGenerateHandler(): JobHandler {
  return async (ctx: JobHandlerContext) => {
    const { year } = ctx.payload as JobPayload<"invoices.generate">;
    return runWithRequestCompany(
      { id: ctx.companyId, slug: "", status: "active", host: "" },
      async () => {
        const db = companyClient(ctx.companyId);
        return runInChunks<ContractRow>(
          (offset, limit) => loadContractsToGenerate(db, year, offset, limit),
          (chunk) => generateForContracts(db, chunk, year),
        );
      },
    );
  };
}

/**
 * يبني معالج مهمة `invoices.regenerate`: يوحّد فواتير عقود الطلب، عقداً عقداً،
 * على دفعات من 200 عقد.
 *
 * The catalogue payload names one contract per request (`contractId` plus the
 * request's own `requestId`, dedupe contract + request), but the work is
 * row-generic so a request that ever names several contracts reuses the same
 * chunked machinery. `regenerate_contract_invoices` reconciles in place under
 * the same unique period constraint, so a rerun updates rather than
 * duplicates.
 */
export function createInvoicesRegenerateHandler(): JobHandler {
  return async (ctx: JobHandlerContext) => {
    const { contractId } = ctx.payload as JobPayload<"invoices.regenerate">;
    return runWithRequestCompany(
      { id: ctx.companyId, slug: "", status: "active", host: "" },
      async () => {
        const db = companyClient(ctx.companyId);
        const summary: RegenerationSummary = {
          updated: 0,
          inserted: 0,
          cancelled: 0,
          deleted: 0,
          skipped: 0,
          blocked: 0,
        };
        const totals = await runInChunks<ContractRow>(
          (offset, limit) => loadContractById(db, contractId, offset, limit),
          (chunk) => regenerateForContracts(db, chunk, summary),
        );
        return { ...totals, summary } satisfies RegenerateRunResult;
      },
    );
  };
}

/**
 * يقرأ العقود التي يشملها توليد السنة: غير المؤرشفة وتقع نهايتها بعد مطلع
 * أول سنة يشملها الطلب.
 *
 * Mirrors the SQL generator's own scope (`generate_invoices` clamps to
 * `least(target, current year)` and skips archived contracts): reading the
 * same set here keeps one contract one call, so the chunk boundaries are real
 * and the counts are per contract.
 */
async function loadContractsToGenerate(
  db: SupabaseClient<Database>,
  year: number,
  offset: number,
  limit: number,
): Promise<ContractRow[]> {
  const scopeStart = `${Math.min(year, new Date().getUTCFullYear())}-01-01`;
  const { data, error } = await db
    .from("contracts")
    .select("id")
    .is("archived_at", null)
    .gte("end_date", scopeStart)
    .order("id")
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`invoices.generate load failed: ${error.message}`);
  return data ?? [];
}

/**
 * يقرأ العقود التي يعيد الطلب توحيد فواتيرها.
 *
 * The request already checked the contract exists; this read is what scopes
 * the job to this company's rows and keeps the pagination stable across a
 * retry.
 */
async function loadContractById(
  db: SupabaseClient<Database>,
  contractId: string,
  offset: number,
  limit: number,
): Promise<ContractRow[]> {
  const { data, error } = await db
    .from("contracts")
    .select("id")
    .eq("id", contractId)
    .order("id")
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`invoices.regenerate load failed: ${error.message}`);
  return data ?? [];
}

/**
 * يولّد فواتير عقود دفعة واحدة ويجمع العدّادات.
 *
 * A generator refusal that carries a SQLSTATE is one contract's data problem:
 * it counts `failed` and the chunk continues, so one bad contract cannot block
 * 449 good ones. An error with no SQLSTATE is a system failure and is thrown
 * wrapped with the call name, like the loads above — `hasSqlState` classifies
 * the Supabase error before the wrap — so the job retries instead of ending
 * "succeeded" with nothing done.
 */
async function generateForContracts(
  db: SupabaseClient<Database>,
  chunk: readonly ContractRow[],
  year: number,
): Promise<BulkRunResult> {
  const outcome: BulkRunResult = { created: 0, skipped: 0, failed: 0, errors: [] };
  for (const contract of chunk) {
    const { data, error } = await db.rpc("generate_invoices", {
      p_contract_id: contract.id,
      p_through_year: year,
    });
    if (error) {
      if (hasSqlState(error)) {
        outcome.failed += 1;
        outcome.errors.push(`generate_invoices(${contract.id}) failed: ${error.message}`);
        continue;
      }
      throw new Error(`generate_invoices(${contract.id}) failed: ${error.message}`);
    }
    if (data && data.length) outcome.created += data.length;
    else outcome.skipped += 1;
  }
  return outcome;
}

/**
 * يوحّد فواتير عقود دفعة واحدة ويجمع العدّادات وملخّص الأفعال.
 *
 * `created` counts the engine's `inserted` actions and `failed` its `blocked`
 * ones (a month it refuses to touch — migration 139); the full six-action
 * summary accumulates beside the counts because a cancellation is a row a
 * human must look at and the three counts alone would bury it.
 */
async function regenerateForContracts(
  db: SupabaseClient<Database>,
  chunk: readonly ContractRow[],
  summary: RegenerationSummary,
): Promise<BulkRunResult> {
  const outcome: BulkRunResult = { created: 0, skipped: 0, failed: 0, errors: [] };
  for (const contract of chunk) {
    const { data, error } = await db.rpc("regenerate_contract_invoices", {
      p_contract_id: contract.id,
    });
    if (error) {
      if (hasSqlState(error)) {
        outcome.failed += 1;
        outcome.errors.push(
          `regenerate_contract_invoices(${contract.id}) failed: ${error.message}`,
        );
        continue;
      }
      throw new Error(`regenerate_contract_invoices(${contract.id}) failed: ${error.message}`);
    }
    const rowSummary = summarizeRegeneration(data ?? []);
    for (const action of Object.keys(rowSummary) as Array<keyof RegenerationSummary>) {
      summary[action] += rowSummary[action];
    }
    outcome.created += rowSummary.inserted;
    outcome.skipped += rowSummary.skipped;
    outcome.failed += rowSummary.blocked;
  }
  return outcome;
}
