import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/database.types";

import { JOB_CATALOG, type JobKind, type JobPayload } from "./catalog";

export interface EnqueueJobOptions {
  /** Same key for the same kind returns the existing job instead of a second one. */
  dedupeKey?: string;
  /** Staff member who receives the job's notice; `companyClient` JWTs carry no `sub`. */
  requestedBy?: string;
}

/**
 * يسجّل طلب مهمة خلفية في صندوق `job_requests` للشركة الحالية ويعيد معرّفه، بعد التحقق من الحمولة.
 *
 * Only inserts the outbox row through `enqueue_job`; it never contacts Redis, so
 * a failed request leaves no queued work (contracts/jobs.md section 1). `db.rpc`
 * is its own transaction, so money paths must call SQL `enqueue_job` inside their
 * own transaction instead (FR-018, contracts/jobs.md section 1). Call it
 * with `companyClient` — browser sessions have no execute grant.
 */
export async function enqueueJob<K extends JobKind>(
  db: SupabaseClient<Database>,
  kind: K,
  payload: JobPayload<K>,
  opts: EnqueueJobOptions = {},
): Promise<{ jobId: string }> {
  const validated = JOB_CATALOG[kind].payload.parse(payload);
  const { data, error } = await db.rpc("enqueue_job", {
    _kind: kind,
    _payload: validated,
    _dedupe_key: opts.dedupeKey ?? null,
    _requested_by: opts.requestedBy ?? null,
  });
  if (error) throw new Error(`enqueue_job(${kind}) failed: ${error.message}`);
  return { jobId: data };
}
