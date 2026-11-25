import { describe, expect, test } from "vitest";

import {
  assertNotRowCapped,
  chunkIds,
  fetchInChunks,
  ID_CHUNK_SIZE,
  PGRST_MAX_ROWS,
} from "./idChunks";

/** معرّفات مرقّمة بالعدد المطلوب، لاختبار الحدود حول `ID_CHUNK_SIZE`. */
function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `id-${index}`);
}

describe("chunkIds", () => {
  test("an empty list produces no requests at all", () => {
    // A single empty chunk would issue `in(...)` with nothing in it, which
    // PostgREST answers with every row rather than none.
    expect(chunkIds([])).toEqual([]);
  });

  test("a list at the limit stays one request", () => {
    expect(chunkIds(ids(ID_CHUNK_SIZE))).toHaveLength(1);
  });

  test("one id past the limit splits, and the remainder is kept", () => {
    const chunks = chunkIds(ids(ID_CHUNK_SIZE + 1));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(ID_CHUNK_SIZE);
    expect(chunks[1]).toEqual([`id-${ID_CHUNK_SIZE}`]);
  });

  test("an exact multiple leaves no trailing empty chunk", () => {
    expect(chunkIds(ids(ID_CHUNK_SIZE * 2)).map((chunk) => chunk.length)).toEqual([
      ID_CHUNK_SIZE,
      ID_CHUNK_SIZE,
    ]);
  });
});

describe("fetchInChunks", () => {
  test("concatenates the rows of every chunk in order", async () => {
    const asked: number[] = [];
    const rows = await fetchInChunks(ids(ID_CHUNK_SIZE + 2), (chunk) => {
      asked.push(chunk.length);
      return Promise.resolve({ data: chunk.map((id) => ({ id })), error: null });
    });
    expect(asked).toEqual([ID_CHUNK_SIZE, 2]);
    expect(rows).toHaveLength(ID_CHUNK_SIZE + 2);
    expect(rows[rows.length - 1]).toEqual({ id: `id-${ID_CHUNK_SIZE + 1}` });
  });

  test("an empty id list issues no request", async () => {
    let calls = 0;
    const rows = await fetchInChunks([], () => {
      calls += 1;
      return Promise.resolve({ data: [], error: null });
    });
    expect(calls).toBe(0);
    expect(rows).toEqual([]);
  });

  test("a failing chunk throws instead of returning the rows already collected", async () => {
    // The dangerous outcome is a short list that looks complete: the caller
    // would render it as the whole answer.
    const failing = fetchInChunks(ids(ID_CHUNK_SIZE + 1), (chunk) =>
      chunk.length === ID_CHUNK_SIZE
        ? Promise.resolve({ data: chunk.map((id) => ({ id })), error: null })
        : Promise.resolve({ data: null, error: new Error("gateway said no") }),
    );
    await expect(failing).rejects.toThrow("gateway said no");
  });

  test("a chunk that comes back null contributes no rows", async () => {
    // PostgREST returns `data: null` alongside a 204; treating it as a row
    // would push `undefined` into the list.
    const rows = await fetchInChunks(ids(3), () => Promise.resolve({ data: null, error: null }));
    expect(rows).toEqual([]);
  });
});

/**
 * PR #161 review (Codex, P2), widened after measuring production: `ID_CHUNK_SIZE`
 * bounds how many ids ride in the URL and says nothing about how many rows they
 * match. The worst 200 invoices in this database carry 2,800 `invoice_items`,
 * and PostgREST answers an unranged request with its first `PGRST_DB_MAX_ROWS`
 * (1,000) and no error — so the units column of a multi-unit invoice silently
 * came back empty. These pin the split that completes such a chunk.
 */
describe("fetchInChunks row limit", () => {
  /** معرّفات مرقّمة بالعدد المطلوب. */
  function ids(count: number): string[] {
    return Array.from({ length: count }, (_, index) => `id-${index}`);
  }

  /**
   * يبني مصدرًا يردّ عددًا ثابتًا من الصفوف لكل معرّف، مقصوصًا عند حدّ الصفوف.
   *
   * Mirrors PostgREST: the clip is silent, so a caller that trusts the response
   * length cannot tell a complete answer from a truncated one.
   */
  function source(rowsPerId: number) {
    const asked: number[][] = [];
    const fetchChunk = (chunk: string[]) => {
      asked.push(chunk.map((id) => Number(id.slice("id-".length))));
      const all = chunk.flatMap((id) => Array.from({ length: rowsPerId }, (_, n) => ({ id, n })));
      return Promise.resolve({ data: all.slice(0, PGRST_MAX_ROWS), error: null });
    };
    return { asked, fetchChunk };
  }

  test("returns every row when one chunk matches more than the row limit", async () => {
    // 200 ids × 14 rows = 2,800 — the shape measured on this database.
    const { asked, fetchChunk } = source(14);

    const rows = await fetchInChunks(ids(ID_CHUNK_SIZE), fetchChunk);

    expect(rows).toHaveLength(ID_CHUNK_SIZE * 14);
    // Every id is represented, which a clipped response could not manage.
    expect(new Set(rows.map((row) => row.id)).size).toBe(ID_CHUNK_SIZE);
    // The full chunk was tried first, then split until each part fitted.
    expect(asked[0]).toHaveLength(ID_CHUNK_SIZE);
    expect(asked.length).toBeGreaterThan(1);
  });

  test("asks once when the rows fit inside the limit", async () => {
    const { asked, fetchChunk } = source(2);

    const rows = await fetchInChunks(ids(100), fetchChunk);

    expect(rows).toHaveLength(200);
    expect(asked).toEqual([Array.from({ length: 100 }, (_, index) => index)]);
  });

  test("refuses to report a truncated answer it cannot split any further", async () => {
    const { fetchChunk } = source(PGRST_MAX_ROWS);

    await expect(fetchInChunks(ids(2), fetchChunk)).rejects.toThrow(/truncated/i);
  });
});

describe("assertNotRowCapped", () => {
  test("passes a list comfortably short of the cap", () => {
    expect(() => assertNotRowCapped(new Array(238).fill(0), "invoices")).not.toThrow();
  });

  test("passes a list one row short of the cap", () => {
    expect(() =>
      assertNotRowCapped(new Array(PGRST_MAX_ROWS - 1).fill(0), "invoices"),
    ).not.toThrow();
  });

  test("refuses a list that reached the cap, naming what was probably clipped", () => {
    expect(() =>
      assertNotRowCapped(new Array(PGRST_MAX_ROWS).fill(0), "The contract's invoices"),
    ).toThrow(/The contract's invoices returned 1000 rows/);
  });
});
