/**
 * آلة المعالجة المجمّعة المشتركة لمعالجات المهام الضخمة.
 *
 * Bulk handlers process their input rows in chunks of 200 (research.md R7) so
 * two companies' bulk jobs interleave on the `bulk` queue. Each chunk is its
 * own committed unit: every row's effects commit through their own statement,
 * and every row is idempotent (existing unique constraints or an "already
 * done" check), so a retry after a crash resumes without duplicating rows.
 */

/** عدد الصفوف في الدفعة الواحدة — حد الكتالوج للمعالجة الضخمة (research.md R7). */
export const CHUNK_ROW_LIMIT = 200;

/** عدّادات نتيجة العمل الضخم: ما أُنشئ، وما تُخطّى، وما فشل. */
export interface BulkCounts {
  /** عدد السجلات التي أُنشئت فعلاً (رسائل مُسلّمة للعامل، فواتير، رسوم). */
  created: number;
  /** عدد عناصر المدخلات التي كان لا عمل لها: منتهية أو مُنجزة في محاولة سابقة. */
  skipped: number;
  /** عدد عناصر المدخلات التي فشلت بخطأ خاص بها؛ يُذكر سببه في `errors`. */
  failed: number;
}

/** نتيجة تشغيل كاملة: العدّادات ورسائل فشل العناصر، لتُخزَّن في `job_requests.result`. */
export interface BulkRunResult extends BulkCounts {
  /** رسائل أخطاء العناصر الفاشلة؛ الخطأ النظامي يُرمى ولا يُحصى هنا. */
  errors: string[];
}

/** عمل دفعة واحدة من صفوف المدخلات. */
export type ChunkWork<T> = (chunk: readonly T[]) => Promise<BulkRunResult>;

/** قارئ صفوف المدخلات دفعةً دفعة؛ يقرأ الموضع `offset` بحد `limit`. */
export type ChunkLoader<T> = (offset: number, limit: number) => Promise<T[]>;

/**
 * هل يحمل هذا الخطأ رمز حالة SQL فيجل؟
 *
 * A PostgREST/Postgres error carries the SQLSTATE of a row-level refusal
 * (a raise, a constraint, a permission) and is counted as that row's failure;
 * an error with no code is a system failure — network, my own bug — and must
 * crash the chunk so BullMQ retries the job instead of the run "succeeding"
 * with a wall of counted failures and no work done.
 */
export function hasSqlState(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code } = error as { code?: unknown };
  return typeof code === "string" && code.length > 0;
}

/**
 * ينفّذ العمل على دفعات صفوف واحدة تلو الأخرى ويجمع عدّاداتها.
 *
 * The loader is called per chunk — not once up front — so the chunk boundary
 * is a real boundary: the run holds one chunk in memory, a chunk's rows are
 * read after the previous chunk's work committed, and a retry resumes by
 * re-reading the rows and skipping what an earlier attempt already did.
 * A chunk whose rows all have nothing left to do still counts as processed;
 * the loop ends when a loader returns fewer rows than the chunk limit.
 */
export async function runInChunks<T>(
  loadChunk: ChunkLoader<T>,
  work: ChunkWork<T>,
): Promise<BulkRunResult> {
  const totals: BulkRunResult = { created: 0, skipped: 0, failed: 0, errors: [] };
  let offset = 0;
  for (;;) {
    const chunk = await loadChunk(offset, CHUNK_ROW_LIMIT);
    if (!chunk.length) break;
    const outcome = await work(chunk);
    totals.created += outcome.created;
    totals.skipped += outcome.skipped;
    totals.failed += outcome.failed;
    totals.errors.push(...outcome.errors);
    if (chunk.length < CHUNK_ROW_LIMIT) break;
    offset += CHUNK_ROW_LIMIT;
  }
  return totals;
}
