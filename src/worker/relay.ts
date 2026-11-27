import type { JobsOptions } from "bullmq";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/database.types";
import { JOB_CATALOG, type JobKind, type QueueName } from "@/jobs/catalog";

import { QUEUE_CONFIGS } from "./queues";
import type { RelayedJobData } from "./types";

/** صفٌّ من `job_requests` بعد حجزه: ما يحتاجه المرحِّل لنشره. */
export type RelayClaimRow = Database["public"]["Functions"]["relay_claim_jobs"]["Returns"][number];

/** صفٌّ بعينه: معرّفه وشركته، فالكتابة تسمّيهما معاً. */
export interface RelayRowRef {
  id: string;
  company_id: string;
}

/** ما يحتاجه المرحِّل من عميل Supabase: الحجز، وإعادة الصف، وتسجيل الفشل. */
export interface RelayDatabase {
  rpc(
    fn: "relay_claim_jobs",
    args: { _limit: number },
  ): PromiseLike<{ data: RelayClaimRow[] | null; error: { message: string } | null }>;
  /** يعيد الصف إلى `pending` بعد أن فشل نشره، فتنشره جولة لاحقة. */
  resetToPending(row: RelayRowRef): Promise<void>;
  /** ينهي الصف كفشل مع سبب مكتوب في `last_error`. */
  markFailed(row: RelayRowRef, lastError: string): Promise<void>;
}

/** ما يحتاجه المرحِّل من طابور BullMQ: إضافة مهمة واحدة. */
export interface RelayQueue {
  add(name: string, data: RelayedJobData, opts?: JobsOptions): Promise<unknown>;
}

/** الاعتماديات التي يحتاجها المرحِّل: عميل قاعدة البيانات ودالّة جلب الطابور. */
export interface RelayDependencies {
  db: RelayDatabase;
  queueFor: (queueName: QueueName) => RelayQueue;
}

/** عدد الصفوف التي يحجزها المرحِّل في الجولة الواحدة. */
const RELAY_CLAIM_LIMIT = 100;

/** الفترة بين جولات المرحِّل بالمللي ثانية. */
const RELAY_INTERVAL_MS = 1000;

/**
 * قاعدة بيانات المرحِّل: عميل `service_role` يتجاوز RLS، فالصفوف تُسمّى بشركتها.
 */
const relayDatabase: RelayDatabase = {
  rpc: (fn, args) => supabaseAdmin.rpc(fn, args),
  resetToPending: (row) => writeRequestState(row, { status: "pending", published_at: null }),
  markFailed: (row, lastError) =>
    writeRequestState(row, {
      status: "failed",
      last_error: lastError,
      finished_at: new Date().toISOString(),
    }),
};

/**
 * يغيّر حالة صف طلب مهمة، ويسمّيه بمعرّفه وشركته معاً.
 */
async function writeRequestState(
  row: RelayRowRef,
  patch: Database["public"]["Tables"]["job_requests"]["Update"],
): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("job_requests")
    .update(patch)
    .eq("id", row.id)
    .eq("company_id", row.company_id)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`job request ${row.id} update failed: ${error.message}`);
  if (!data) throw new Error(`job request ${row.id} of company ${row.company_id} not found`);
}

/**
 * يتحقق أن نوع المهمة موجود في الكتالوج.
 *
 * `job_requests.kind` only checks the shape of the name, so a row written by an
 * older release can name a kind the catalogue no longer knows.
 */
function isJobKind(kind: string): kind is JobKind {
  return Object.hasOwn(JOB_CATALOG, kind);
}

/**
 * يضيف الصف المحجوز إلى طابور نوعه، ومعرّف مهمة BullMQ هو معرّف الصف نفسه.
 *
 * The job id is the `job_requests` id, so the row stays the source of truth
 * and a republished row collides with the job BullMQ already holds — which
 * BullMQ ignores, so the work runs exactly once (research.md R6).
 */
async function publishRow(
  row: RelayClaimRow,
  queueName: QueueName,
  queueFor: (queueName: QueueName) => RelayQueue,
): Promise<void> {
  const config = QUEUE_CONFIGS[queueName];
  await queueFor(queueName).add(
    row.kind,
    { jobRequestId: row.id, companyId: row.company_id },
    { jobId: row.id, attempts: config.attempts, backoff: config.backoff },
  );
}

/**
 * ينشر صفاً محجوزاً ويعيد ما صار به.
 *
 * One row must not stop the round: a row that cannot be published goes back to
 * `pending`, and a row whose kind this build does not know ends as failed.
 * Both cases leave the other rows published.
 */
async function publishClaimedRow(row: RelayClaimRow, deps: RelayDependencies): Promise<boolean> {
  if (!isJobKind(row.kind)) {
    await failUnknownKind(deps.db, row);
    return false;
  }

  try {
    await publishRow(row, JOB_CATALOG[row.kind].queue, deps.queueFor);
    return true;
  } catch (error) {
    console.error(`[relay] publishing row ${row.id} failed:`, error);
    await releaseRow(deps.db, row);
    return false;
  }
}

/**
 * ينهي صفاً لا يعرفه هذا الإصدار كفشل، فليس له ما يُنشر ولا ما يُشغَّل.
 */
async function failUnknownKind(db: RelayDatabase, row: RelayClaimRow): Promise<void> {
  const message = `unknown job kind: ${row.kind}`;
  console.error(`[relay] ${message} (row ${row.id})`);
  await db.markFailed({ id: row.id, company_id: row.company_id }, message);
}

/**
 * يعيد صفاً إلى `pending` بعد فشل نشره، حتى تنشره جولة لاحقة.
 *
 * A reset that fails is not fatal: the row stays `published`, and the
 * five-minute sweep re-claims it (contracts/jobs.md section 2).
 */
async function releaseRow(db: RelayDatabase, row: RelayClaimRow): Promise<void> {
  try {
    await db.resetToPending({ id: row.id, company_id: row.company_id });
  } catch (error) {
    console.error(`[relay] resetting row ${row.id} to pending failed:`, error);
  }
}

/**
 * ينشر الصفوف المحجوزة إلى طوابير BullMQ ويعيد عدد ما نُشر.
 *
 * The claim happens in one SQL statement, so a row belongs to exactly one
 * round; the queue a row goes to is the one its kind names in the catalogue.
 */
export async function relayOnce(deps: RelayDependencies): Promise<number> {
  const { data, error } = await deps.db.rpc("relay_claim_jobs", { _limit: RELAY_CLAIM_LIMIT });
  if (error) {
    throw new Error(`relay_claim_jobs failed: ${error.message}`);
  }

  let published = 0;
  for (const row of data ?? []) {
    if (await publishClaimedRow(row, deps)) published += 1;
  }
  return published;
}

/**
 * يشغّل جولة واحدة من المرحِّل ويسجّل فشلها بدل ابتلاعه.
 *
 * The rows a failed round would have published stay `published`, so the
 * five-minute sweep re-claims them: a Postgres or Redis blip must not end the
 * worker, and it must not lose the work either.
 */
async function runRound(queueFor: RelayDependencies["queueFor"]): Promise<void> {
  try {
    await relayOnce({ db: relayDatabase, queueFor });
  } catch (error) {
    console.error("[relay] round failed:", error);
  }
}

/**
 * يشغّل حلقة المرحِّل كل `RELAY_INTERVAL_MS` مللي ثانية دون تداخل بين
 * الجولات، ويعيد دالّة توقف الحلقة.
 */
export function startRelay(queueFor: RelayDependencies["queueFor"]): () => void {
  let running = false;
  let stopped = false;

  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    void runRound(queueFor).finally(() => {
      running = false;
    });
  }, RELAY_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
