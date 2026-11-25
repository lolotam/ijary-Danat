import { describe, expect, it } from "vitest";

import { EXPORT_ROW_CEILING, fetchAllOffsetPages, fetchExportRows } from "./pagedQuery";

/**
 * The tenant detail page showed contract CON-00052 (a twenty-year lease, 238
 * invoices) starting at 2027-10: it asked for one page of 200 ordered by
 * `created_at` descending and rendered it with no page control, so the oldest
 * 38 periods — every 2024, 2025 and 2026 invoice — were dropped in silence.
 * These pin the paging loop that replaced that cap. The loop lived in
 * `useInvoices.ts` as `fetchAllInvoicePages` until the CSV-export fix (S16
 * finding 1) promoted it here under its offset name.
 */
describe("fetchAllOffsetPages", () => {
  /** يقدّم `total` صفًّا مرقّمًا على صفحات، ويسجّل كل مدى طُلب منه. */
  function pagedSource(total: number) {
    const ranges: Array<[number, number]> = [];
    const rows = Array.from({ length: total }, (_, index) => index);
    const fetchPage = async (from: number, to: number) => {
      ranges.push([from, to]);
      return { rows: rows.slice(from, to + 1), count: total };
    };
    return { fetchPage, ranges };
  }

  it("returns every invoice of a twenty-year lease, not the first page", async () => {
    const { fetchPage, ranges } = pagedSource(238);

    const result = await fetchAllOffsetPages(fetchPage, 200);

    expect(result.rows).toHaveLength(238);
    // The 38 rows the old single-page fetch dropped.
    expect(result.rows.slice(200)).toEqual(Array.from({ length: 38 }, (_, i) => 200 + i));
    expect(result.count).toBe(238);
    expect(ranges).toEqual([
      [0, 199],
      [200, 399],
    ]);
  });

  it("stops on a full last page instead of requesting an empty one", async () => {
    const { fetchPage, ranges } = pagedSource(4);

    const result = await fetchAllOffsetPages(fetchPage, 2);

    expect(result.rows).toEqual([0, 1, 2, 3]);
    expect(ranges).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("makes a single request when the first page is short", async () => {
    const { fetchPage, ranges } = pagedSource(3);

    const result = await fetchAllOffsetPages(fetchPage, 200);

    expect(result.rows).toEqual([0, 1, 2]);
    expect(ranges).toEqual([[0, 199]]);
  });

  it("keeps paging when PostgREST caps the page below the requested chunk", async () => {
    // PGRST_DB_MAX_ROWS is 1000 in production: a request wider than the ceiling
    // comes back short. Reading that as the last page would truncate again.
    const ranges: Array<[number, number]> = [];
    const serverCap = 150;
    const fetchPage = async (from: number, to: number) => {
      ranges.push([from, to]);
      const width = Math.min(to - from + 1, serverCap);
      return {
        rows: Array.from({ length: 238 }, (_, index) => index).slice(from, from + width),
        count: 238,
      };
    };

    const result = await fetchAllOffsetPages(fetchPage, 500);

    expect(result.rows).toHaveLength(238);
    expect(ranges).toEqual([
      [0, 499],
      [150, 649],
    ]);
  });

  it("returns nothing for a contract with no invoices", async () => {
    const { fetchPage, ranges } = pagedSource(0);

    const result = await fetchAllOffsetPages(fetchPage, 200);

    expect(result.rows).toEqual([]);
    expect(result.count).toBe(0);
    expect(ranges).toEqual([[0, 199]]);
  });
});

/**
 * S16 finding 1: eight CSV exports fetched one page at a hard-coded cap, and
 * `PGRST_MAX_ROWS` clipped the widest ask silently. `fetchExportRows` is the
 * one door they all go through now — these pin that the safety ceiling stops a
 * runaway loop *visibly* (`truncated`) and never fires on a complete export.
 */
describe("fetchExportRows ceiling", () => {
  /** مصدر لا ينتهي: يجيب دائماً بصفحة كاملة وعدّ يفوق ما جُمع — كأن الخادم علِق. */
  function endlessSource() {
    const ranges: Array<[number, number]> = [];
    const fetchPage = async (from: number, to: number) => {
      ranges.push([from, to]);
      const width = to - from + 1;
      return {
        rows: Array.from({ length: width }, (_, index) => from + index),
        count: EXPORT_ROW_CEILING * 10,
      };
    };
    return { fetchPage, ranges };
  }

  it("flips truncated and stops paging once the ceiling is reached", async () => {
    const { fetchPage, ranges } = endlessSource();

    const result = await fetchExportRows(fetchPage, 500);

    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(EXPORT_ROW_CEILING);
    // 100 full pages of 500; the ceiling guard ends the loop without letting
    // the runaway source answer a 101st time.
    expect(ranges).toHaveLength(EXPORT_ROW_CEILING / 500);
  });

  it("does not flag truncation when the dataset ends exactly at the ceiling", async () => {
    const total = EXPORT_ROW_CEILING;
    const fetchPage = async (from: number, to: number) => ({
      rows: Array.from({ length: total }, (_, index) => index).slice(from, to + 1),
      count: total,
    });

    const result = await fetchExportRows(fetchPage, 500);

    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(EXPORT_ROW_CEILING);
    expect(result.count).toBe(total);
  });

  it("ends on a short first page with a single request and no truncation flag", async () => {
    const ranges: Array<[number, number]> = [];
    const fetchPage = async (from: number, to: number) => {
      ranges.push([from, to]);
      return { rows: [0, 1, 2], count: 3 };
    };

    const result = await fetchExportRows(fetchPage, 200);

    expect(result.rows).toEqual([0, 1, 2]);
    expect(result.count).toBe(3);
    expect(result.truncated).toBe(false);
    expect(ranges).toEqual([[0, 199]]);
  });
});
