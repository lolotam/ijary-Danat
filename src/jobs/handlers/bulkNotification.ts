import type { SupabaseClient } from "@supabase/supabase-js";

import { companyClient } from "@/company/companyClient.server";
import { runWithRequestCompany } from "@/company/requestCompany.server";
import { notificationDispatchDedupeKey, type JobPayload } from "@/jobs/catalog";
import { enqueueJob } from "@/jobs/enqueue";
import type { Database } from "@/integrations/supabase/database.types";
import type { JobHandler, JobHandlerContext } from "@/worker/runJob";

import { runInChunks, type BulkRunResult } from "./bulkChunks";

/** صف إشعار مُرحَّل من صفوف دفعة الإرسال الجماعي. */
interface StagedNotificationRow {
  id: string;
  state: string;
}

/**
 * يبني معالج مهمة `notification.bulk`: يسلّم صفوف دفعة الإرسال الجماعي إلى
 * عامل الإشعارات، دفعةً دفعة.
 *
 * The request stored the per-tenant rows in the `notifications` table — the
 * batch's existing staging place — with `delivery_key` idempotency, and
 * enqueued this one job (contracts/jobs.md section 5: dedupe request id). The
 * handler fans each staged row out to a `notification.dispatch` job in chunks
 * of 200, so a large batch reaches the notify worker promptly and paced,
 * instead of waiting for the daily drain's 100-row window and its 72-hour
 * stale cancel.
 *
 * Rerunning is safe twice over: the batch rows carry their own state, and
 * every dispatch job dedupes on `notification.dispatch:<notificationId>`
 * (the outbox's unique `(company_id, kind, dedupe_key)`), so a retry after a
 * crash re-reads the rows and creates no second message per tenant.
 */
export function createNotificationBulkHandler(): JobHandler {
  return async (ctx: JobHandlerContext) => {
    const { requestId } = ctx.payload as JobPayload<"notification.bulk">;
    return runWithRequestCompany(
      { id: ctx.companyId, slug: "", status: "active", host: "" },
      async () => {
        const db = companyClient(ctx.companyId);
        return runInChunks<StagedNotificationRow>(
          (offset, limit) => loadBatchChunk(db, requestId, offset, limit),
          (chunk) => fanOutChunk(db, chunk),
        );
      },
    );
  };
}

/**
 * يقرأ دفعة من صفوف الدفعة المُرحَّلة، مرتّبةً بالمعرّف حتى تثبت مواضع
 * القراءة بين محاولتين.
 *
 * The sort is what makes the range pagination stable across a retry: rows an
 * earlier attempt already processed sit at the same offsets and are re-read
 * as "nothing left to do", never lost or double-read.
 */
async function loadBatchChunk(
  db: SupabaseClient<Database>,
  batchId: string,
  offset: number,
  limit: number,
): Promise<StagedNotificationRow[]> {
  const { data, error } = await db
    .from("notifications")
    .select("id, state")
    .contains("payload", { batch_id: batchId })
    .order("id")
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`notification.bulk load failed: ${error.message}`);
  return data ?? [];
}

/**
 * يسلّم صفوف دفعة واحدة إلى عامل الإشعارات ويجمع عدّاداتها.
 *
 * A row that already has a dispatch job — handed over by this handler before
 * a crash, or by `enqueueNotification` itself — is counted `skipped`, not
 * created again: that lookup is the "already exists" check behind the counts,
 * while the dedupe key is the one behind the rows. Rows that ended `failed`
 * or `needs_review` count `failed` so the requester's outcome names them;
 * re-sending them is the manual retry button's decision, not a fan-out's.
 */
async function fanOutChunk(
  db: SupabaseClient<Database>,
  chunk: readonly StagedNotificationRow[],
): Promise<BulkRunResult> {
  const outcome: BulkRunResult = { created: 0, skipped: 0, failed: 0, errors: [] };
  const heldIds = await loadHeldNotificationIds(
    db,
    chunk.map((row) => row.id),
  );
  for (const row of chunk) {
    if (row.state === "sent" || row.state === "skipped") {
      outcome.skipped += 1;
      continue;
    }
    if (row.state !== "queued") {
      outcome.failed += 1;
      outcome.errors.push(`notification ${row.id} is ${row.state}`);
      continue;
    }
    if (heldIds.has(row.id)) {
      outcome.skipped += 1;
      continue;
    }
    // An enqueue failure is systemic (the outbox is unreachable), so it is
    // thrown for the job to retry rather than counted as one row's bad luck.
    await enqueueJob(
      db,
      "notification.dispatch",
      { notificationId: row.id },
      { dedupeKey: notificationDispatchDedupeKey(row.id) },
    );
    outcome.created += 1;
  }
  return outcome;
}

/**
 * يقرأ معرّفات الإشعارات التي لها مهمة إرسال مسجّلة بالفعل، لتُحسب مُنجزة.
 *
 * The same lookup the notification drain uses to leave held rows alone: a row
 * whose dispatch job exists was already handed over, so a rerun counts it
 * `skipped` instead of claiming a second creation.
 */
async function loadHeldNotificationIds(
  db: SupabaseClient<Database>,
  notificationIds: readonly string[],
): Promise<Set<string>> {
  const { data, error } = await db
    .from("job_requests")
    .select("payload")
    .eq("kind", "notification.dispatch")
    .in("payload->>notificationId", [...notificationIds]);
  if (error) throw new Error(`notification.bulk held jobs failed: ${error.message}`);
  const held = new Set<string>();
  for (const row of data ?? []) {
    const payload = row.payload as { notificationId?: unknown } | null;
    if (payload && typeof payload.notificationId === "string") held.add(payload.notificationId);
  }
  return held;
}
