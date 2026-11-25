/**
 * Shared 1-based page math for server-side list queries.
 *
 * All admin list pages use page starting at 1 (see `Pager` in Phase2Ui).
 * PostgREST `.range(from, to)` is inclusive on both ends.
 */

export function pageRange(page: number, pageSize: number): { from: number; to: number } {
  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeSize = Math.max(1, Math.floor(pageSize) || 1);
  const from = (safePage - 1) * safeSize;
  return { from, to: from + safeSize - 1 };
}

/** Number of pages for a total row count (at least 1 so empty lists show "1 / 1"). */
export function pageCount(total: number, pageSize: number): number {
  const safeSize = Math.max(1, Math.floor(pageSize) || 1);
  return Math.max(1, Math.ceil(Math.max(0, total) / safeSize));
}

/**
 * After a delete, the current page may be past the last page.
 * Clamp so the UI does not sit on an empty impossible page.
 */
export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(1, page), pageCount(total, pageSize));
}
