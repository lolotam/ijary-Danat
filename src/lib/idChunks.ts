/**
 * عدد المعرّفات في كل دفعة، بحيث لا يتجاوز طول الرابط حدّ البوابة.
 *
 * A PostgREST `in(...)` filter travels in the query string, and a UUID plus its
 * separator costs ~39 bytes there. 200 keeps a chunk near 8 KB — comfortably
 * inside the usual gateway limit with room for the rest of the URL. Past it
 * Kong answers 414, which surfaces as an empty column rather than a visible
 * failure, so the ceiling has to be respected before the request is built.
 */
export const ID_CHUNK_SIZE = 200;

/** يقسّم قائمة المعرّفات إلى دفعات صالحة لمرشِّح `in()` واحد. */
export function chunkIds(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
    chunks.push(ids.slice(start, start + ID_CHUNK_SIZE));
  }
  return chunks;
}

/**
 * أقصى عدد صفوف تُعيده PostgREST لطلب بلا مدى محدد.
 *
 * `PGRST_DB_MAX_ROWS=1000` on this deployment. A request that matches more is
 * answered with the first thousand and no error — the clip is only visible in
 * the `Content-Range` header, which supabase-js does not surface unless the
 * caller asked for a count.
 */
export const PGRST_MAX_ROWS = 1000;

/**
 * يرفض قائمة بلغت حدّ الصفوف، لأنها على الأرجح مقصوصة بلا إشعار.
 *
 * A query with no `.range()` is capped at `PGRST_MAX_ROWS`, and the clip is
 * invisible: no error, no flag, just a list that ends early and renders as if
 * it were complete. This codebase has shipped that defect three times — a page
 * cap, then a URL cap, then this one — and each time it presented as a wrong
 * answer rather than a failure. Where the result is bounded in practice but not
 * in code, refuse the ambiguous case rather than display it.
 *
 * Reaching the limit exactly is far likelier to be a clip than a coincidence,
 * and the caller's own bound is the thing to raise if it ever is one.
 */
export function assertNotRowCapped(rows: readonly unknown[], subject: string): void {
  if (rows.length < PGRST_MAX_ROWS) return;
  throw new Error(
    `${subject} returned ${PGRST_MAX_ROWS} rows, the server's cap for a request with no range, so the list is probably incomplete.`,
  );
}

/**
 * ينفّذ استعلام `in()` على دفعات ويجمع صفوفها كاملة في قائمة واحدة.
 *
 * The caller supplies the query builder for one chunk, so this stays unaware of
 * which table is being read while still owning the three rules every such fetch
 * shares: never put more than `ID_CHUNK_SIZE` ids in one URL, never return a
 * response the row limit clipped, and let a failed chunk throw rather than
 * returning the partial rows that reached us. A silent partial list is the
 * worse outcome — it renders as real data.
 *
 * Ordering is per chunk, not across chunks. Every caller here chunks on the key
 * it groups by, so a group's rows always land in one chunk and keep their
 * order; a caller that needs a total order must sort the result itself.
 */
export async function fetchInChunks<T>(
  ids: readonly string[],
  fetchChunk: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (const chunk of chunkIds(ids)) {
    rows.push(...(await fetchWholeChunk(chunk, fetchChunk)));
  }
  return rows;
}

/**
 * يجلب صفوف دفعة واحدة كاملةً، ويقسمها إن بلغ الردّ حدّ الصفوف.
 *
 * `ID_CHUNK_SIZE` bounds how many ids travel in the URL; it says nothing about
 * how many rows they match. 200 invoices carry up to 2,800 line items in this
 * database, so the id ceiling alone let PostgREST return its first thousand and
 * drop the rest — the units column of a multi-unit invoice simply came back
 * empty. Splitting the chunk when the response reaches the limit is what makes
 * the result complete, and it needs no cooperation from the ~20 call sites,
 * which is the point: a rule every caller must remember is a rule one of them
 * will forget.
 *
 * A response *exactly* at the limit is usually a clip and occasionally an exact
 * fit; splitting either way costs one extra request and returns the same rows.
 * Recursion is bounded — 200 ids halve to 1 in eight steps — and a single id
 * that alone reaches the limit throws rather than silently truncating.
 */
async function fetchWholeChunk<T>(
  chunk: string[],
  fetchChunk: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const { data, error } = await fetchChunk(chunk);
  if (error) throw error;
  const received = data ?? [];
  if (received.length < PGRST_MAX_ROWS) return received;
  if (chunk.length === 1) {
    throw new Error(
      `One id matched at least ${PGRST_MAX_ROWS} rows, so the response was truncated and cannot be completed by splitting.`,
    );
  }
  const middle = Math.ceil(chunk.length / 2);
  const [head, tail] = await Promise.all([
    fetchWholeChunk(chunk.slice(0, middle), fetchChunk),
    fetchWholeChunk(chunk.slice(middle), fetchChunk),
  ]);
  return [...head, ...tail];
}
