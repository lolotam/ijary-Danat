import { PGRST_MAX_ROWS } from "@/lib/idChunks";

/**
 * ما يحتاجه الجلب الصفحي من منشئ الاستعلام: `range` يعيد وعداً بالصفوف والعدّ
 * والخطأ. الواجهة بنيوية حتى تُختبر الدالة بمصدر مزيّف بلا عميل Supabase.
 */
export interface RangeResult<Row> {
  data: Row[] | null;
  error: { message: string } | null;
  count: number | null;
}

export interface RangeQuery<Row> {
  range(from: number, to: number): PromiseLike<RangeResult<Row>>;
}

/**
 * عمود ترتيب واحد من مفتاح الصفحات: اسمه، اتجاهه، وكيف يُقرأ من صف.
 *
 * The last key must be unique (`id`), or two rows with equal keys could
 * straddle a page boundary and one of them be skipped.
 */
export interface KeysetKey<Row> {
  column: string;
  ascending: boolean;
  value: (row: Row) => string | number;
}

export interface PagedRows<Row> {
  rows: Row[];
  /** العدّ الدقيق كما أبلغت عنه الصفحة الأولى، أو عدد الصفوف إن لم يُطلب عدّ. */
  count: number;
}

/**
 * يقتبس قيمة لتُدرج في مرشّح PostgREST داخل `or(...)`.
 *
 * Numbers are safe bare. Strings go inside double quotes with `\` and `"`
 * escaped, which is PostgREST's own quoting for values that may contain the
 * grammar's reserved characters — a tenant name with a comma or a parenthesis
 * would otherwise split the filter.
 */
export function quoteFilterValue(value: string | number): string {
  if (typeof value === "number") return String(value);
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * يبني مرشّح "ما بعد هذا الصف" وفق ترتيب المفاتيح، بصيغة `or` التي يفهمها PostgREST.
 *
 * For keys (a desc, b asc, id asc) and a last row (A, B, ID) this is the
 * standard lexicographic successor test:
 *   a < A, or (a = A and b > B), or (a = A and b = B and id > ID)
 * expressed as `a.lt.A,and(a.eq.A,b.gt.B),and(a.eq.A,b.eq.B,id.gt.ID)`.
 */
export function keysetAfter<Row>(keys: readonly KeysetKey<Row>[], last: Row): string {
  const clauses = keys.map((key, index) => {
    const op = key.ascending ? "gt" : "lt";
    const equalPrefix = keys
      .slice(0, index)
      .map((prior) => `${prior.column}.eq.${quoteFilterValue(prior.value(last))}`);
    const step = `${key.column}.${op}.${quoteFilterValue(key.value(last))}`;
    return equalPrefix.length ? `and(${[...equalPrefix, step].join(",")})` : step;
  });
  return clauses.join(",");
}

/**
 * حجم الدفعة الافتراضي للجلب الإزاحي، دون سقف الخادم (1000) حتى لا تُقصّ أي صفحة.
 *
 * Was `INVOICE_PAGE_CHUNK` when the offset pager lived in `useInvoices`; the
 * value moved with the function so invoice fetching behaves exactly as before.
 */
const OFFSET_PAGE_CHUNK = 500;

/**
 * يجمع كل صفحات الفواتير المطابقة، لا الصفحة الأولى وحدها.
 *
 * A twenty-year lease raises ~240 monthly invoices. The contract tab on the
 * tenant page asked for a single page of 200 ordered by `created_at` newest
 * first, and rendered whatever came back with no page control: on CON-00052
 * that silently dropped 2024-08 through 2027-09, so the tab looked as though
 * 2026 had never been generated. A list with no way to reach page two must
 * fetch the whole list; raising the cap only moves the cliff.
 *
 * **Use this only where the query carries a total order.** Offset paging is
 * stable against a deterministic row order, and every caller here appends the
 * primary key as a unique tiebreaker for that reason. It is still not immune
 * to a row inserted or deleted BETWEEN two requests, which shifts later
 * offsets; `fetchAllPages` below pages by keyset and is immune to that.
 * Offset is used for the exports because each of those hooks already exposes a
 * `fetchX({ page, pageSize })` shape this fits without rewriting the query, an
 * export completes in seconds, and this database takes very few concurrent
 * writes. If exports ever run against a busy table, move them to the keyset
 * helper rather than widening this one.
 *
 * The offset advances by the rows actually returned, never by the requested
 * chunk: PostgREST enforces its own `db-max-rows` ceiling (1000 on this
 * deployment) and hands back a short page when a request exceeds it. Treating a
 * short page as the last one would reintroduce the very truncation this
 * replaces the moment that ceiling drops below the chunk size. The loop ends on
 * an empty page, or once the exact count PostgREST reports has been collected.
 */
export async function fetchAllOffsetPages<T>(
  fetchPage: (from: number, to: number) => Promise<{ rows: T[]; count: number }>,
  chunkSize: number = OFFSET_PAGE_CHUNK,
): Promise<{ rows: T[]; count: number }> {
  const rows: T[] = [];
  let count: number;
  for (;;) {
    // Rows already collected are the offset, so a page shorter than asked for
    // resumes where it actually stopped rather than skipping the difference.
    const page = await fetchPage(rows.length, rows.length + chunkSize - 1);
    count = page.count;
    rows.push(...page.rows);
    if (!page.rows.length) break;
    if (count > 0 && rows.length >= count) break;
  }
  return { rows, count };
}

/**
 * سقف أمان وحيد لكل تصديرات CSV: يوقف حلقة جلب لا تنتهي، ولا يحدّ تصديراً حقيقياً.
 *
 * Every real dataset this portfolio produces sits far below it — tens of
 * units, hundreds of contracts, a few thousand monthly invoices — so the
 * ceiling exists to stop a runaway paging loop (a source that keeps answering
 * full pages forever), not to bound a real export. When paging stops here the
 * export result carries `truncated: true` so the screen can warn instead of
 * handing the operator a silently short CSV.
 */
export const EXPORT_ROW_CEILING = 50_000;

/**
 * يجلب كل الصفوف المطابقة للتصدير عبر المجلب الإزاحي، مع سقف الأمان وراية اقتصاص.
 *
 * The ceiling is enforced around {@link fetchAllOffsetPages} rather than inside
 * it, so the moved loop keeps exactly the termination its documentation
 * promises: the guard answers an empty page once `EXPORT_ROW_CEILING` rows
 * have been collected, which is the pager's own "done" signal. `truncated` is
 * set only when that guard actually fired — a dataset that ends exactly at the
 * ceiling stopped on its count, and nothing was lost.
 */
export async function fetchExportRows<T>(
  fetchPage: (from: number, to: number) => Promise<{ rows: T[]; count: number }>,
  chunkSize: number = OFFSET_PAGE_CHUNK,
): Promise<{ rows: T[]; count: number; truncated: boolean }> {
  let collected = 0;
  let lastCount = 0;
  let hitCeiling = false;
  const { rows, count } = await fetchAllOffsetPages(async (from, to) => {
    if (collected >= EXPORT_ROW_CEILING) {
      hitCeiling = true;
      return { rows: [] as T[], count: lastCount };
    }
    const page = await fetchPage(from, to);
    collected += page.rows.length;
    lastCount = page.count;
    return page;
  }, chunkSize);
  return { rows, count, truncated: hitCeiling };
}

/**
 * يجلب كل الصفوف المطابقة صفحةً صفحة بمفتاح ترتيب، لا بإزاحة رقمية.
 *
 * PostgREST answers a request with no `.range()` with its first
 * `PGRST_MAX_ROWS` rows and no error, so "drop the range to get everything"
 * silently shortened every CSV past a thousand rows (B1 report §4.5). Paging
 * fixes the cap; paging by *offset* would still let a row inserted or deleted
 * between two requests shift every later page, duplicating one row and losing
 * another while the count still matched. Keyset paging asks each page for
 * "rows after the last one I have" in the query's own order, so a concurrent
 * insert can only add a row that sorts after the cursor — never displace one.
 *
 * `build(after)` is invoked once per page because a PostgREST builder is
 * consumed by awaiting it; the caller applies `keysetAfter(keys, after)` when
 * `after` is not null and must order by exactly `keys`. Every page uses
 * `range(0, pageSize - 1)`. The loop stops only on a short page: a count-based
 * stop would drop a row inserted after the count was taken, and the one extra
 * empty request when the total is a multiple of the page size is cheaper than
 * a CSV missing a row.
 *
 * Known boundary: a row whose *sort key* is edited between two pages can move
 * across the cursor — behind it (it would be returned again) or ahead of it
 * (it is missed). Repeats are removed by `id` below; a miss cannot be detected
 * without a server-side snapshot, which PostgREST does not offer over separate
 * requests. An export takes seconds and the keys are dates and names, so this
 * is documented rather than engineered around; a snapshot RPC is the fix if it
 * ever matters.
 */
export async function fetchAllPages<Row>(
  build: (after: Row | null) => RangeQuery<Row>,
  pageSize: number = PGRST_MAX_ROWS,
): Promise<PagedRows<Row>> {
  const rows: Row[] = [];
  const seen = new Set<unknown>();
  let count: number | null = null;
  let after: Row | null = null;
  for (;;) {
    // Annotated so the cursor's type does not feed back into its own
    // inference through `page` (TS7022).
    const result: RangeResult<Row> = await build(after).range(0, pageSize - 1);
    if (result.error) throw result.error;
    const page: Row[] = result.data ?? [];
    for (const row of page) {
      const id = (row as { id?: unknown }).id;
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      rows.push(row);
    }
    count ??= result.count;
    if (page.length < pageSize) break;
    after = page[page.length - 1];
  }
  return { rows, count: count ?? rows.length };
}
