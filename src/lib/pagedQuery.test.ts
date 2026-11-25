import { describe, expect, it } from "vitest";

import { fetchAllPages, keysetAfter, type KeysetKey, type RangeQuery } from "./pagedQuery";

interface Row {
  id: number;
  day: string;
}

const KEYS: KeysetKey<Row>[] = [
  { column: "day", ascending: false, value: (row) => row.day },
  { column: "id", ascending: true, value: (row) => row.id },
];

/** ترتيب المصدر المزيّف: اليوم تنازلياً ثم المعرّف تصاعدياً — نفس مفاتيح `KEYS`. */
function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => (a.day === b.day ? a.id - b.id : a.day < b.day ? 1 : -1));
}

/**
 * مصدر مزيّف يتصرف كـ PostgREST بمفتاح صفحات: يعيد الصفوف التي تلي `after`
 * بترتيب `KEYS`، مقصوصة بالمدى المطلوب، ويبلّغ العدّ الدقيق، ويحصي الطلبات.
 * `onPage` يُستدعى بين الطلبات حتى يحاكي اختبارٌ تغيّر الجدول أثناء التصدير.
 */
function fakeSource(
  initial: Row[],
  options: { reportCount?: boolean; onPage?: (rows: Row[], page: number) => void } = {},
) {
  const table = [...initial];
  let builds = 0;
  const build = (after: Row | null): RangeQuery<Row> => {
    builds += 1;
    options.onPage?.(table, builds);
    return {
      range: (from, to) => {
        const ordered = sortRows(table);
        const start = after
          ? ordered.findIndex((row) => row.day === after.day && row.id === after.id) + 1
          : 0;
        return Promise.resolve({
          data: ordered.slice(start).slice(from, to + 1),
          error: null,
          count: options.reportCount === false ? null : ordered.length,
        });
      },
    };
  };
  return { build, builds: () => builds, table };
}

/** يولّد `total` صفاً موزّعة على خمسة أيام، حتى تتكرر مفاتيح الفرز وتُختبر كسور التعادل. */
function rowsOf(total: number): Row[] {
  return Array.from({ length: total }, (_, id) => ({ id, day: `2026-01-${(id % 5) + 1}` }));
}

describe("keysetAfter", () => {
  it("builds the lexicographic successor filter for mixed directions", () => {
    expect(keysetAfter(KEYS, { id: 7, day: "2026-01-03" })).toBe(
      'day.lt."2026-01-03",and(day.eq."2026-01-03",id.gt.7)',
    );
  });

  it("quotes strings so grammar characters in a value cannot split the filter", () => {
    const keys: KeysetKey<{ name: string; id: string }>[] = [
      { column: "name", ascending: true, value: (row) => row.name },
      { column: "id", ascending: true, value: (row) => row.id },
    ];
    expect(keysetAfter(keys, { name: 'Al-Sabah, "Co" (KW)', id: "u1" })).toBe(
      'name.gt."Al-Sabah, \\"Co\\" (KW)",and(name.eq."Al-Sabah, \\"Co\\" (KW)",id.gt."u1")',
    );
  });
});

/**
 * يثبّت أن التصدير يجمع كل الصفوف مهما بلغ عددها، بترتيب المفاتيح، وبأقل
 * عدد طلبات، وأنه لا يفقد صفاً ولا يكرره حين يتغيّر الجدول بين صفحتين.
 */
describe("fetchAllPages", () => {
  it.each([
    { total: 0, expectedBuilds: 1 },
    { total: 5, expectedBuilds: 1 },
    { total: 1000, expectedBuilds: 2 },
    { total: 2001, expectedBuilds: 3 },
  ])(
    "returns all $total rows in key order using $expectedBuilds request(s)",
    async ({ total, expectedBuilds }) => {
      const source = fakeSource(rowsOf(total));
      const result = await fetchAllPages(source.build, 1000);
      expect(result.rows).toEqual(sortRows(rowsOf(total)));
      expect(result.count).toBe(total);
      expect(source.builds()).toBe(expectedBuilds);
    },
  );

  it("passes the last row of each page back as the cursor", async () => {
    const seen: Array<Row | null> = [];
    const inner = fakeSource(rowsOf(7));
    const build = (after: Row | null) => {
      seen.push(after);
      return inner.build(after);
    };
    await fetchAllPages(build, 3);
    const ordered = sortRows(rowsOf(7));
    expect(seen).toEqual([null, ordered[2], ordered[5]]);
  });

  it("neither duplicates nor drops a row when one is inserted at the front mid-export", async () => {
    const source = fakeSource(rowsOf(5), {
      onPage: (table, page) => {
        // A brand-new row that sorts before everything already exported.
        if (page === 2) table.push({ id: 99, day: "2026-12-31" });
      },
    });
    const result = await fetchAllPages(source.build, 2);
    const ids = result.rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([0, 1, 2, 3, 4]));
  });

  it("keeps every original row when one is deleted from the front mid-export", async () => {
    const source = fakeSource(rowsOf(6), {
      onPage: (table, page) => {
        if (page === 2) table.splice(0, table.length, ...table.filter((row) => row.id !== 4));
      },
    });
    const result = await fetchAllPages(source.build, 2);
    const ids = result.rows.map((row) => row.id).sort((a, b) => a - b);
    // Row 4 was already exported on page 1 (it sorts first: day 5); the other
    // five must all still be present exactly once.
    expect(ids).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("returns a row only once when its sort key moves behind the cursor mid-export", async () => {
    const source = fakeSource(rowsOf(6), {
      onPage: (table, page) => {
        // Row 4 was exported on page 1 (day 5, sorts first); its date is then
        // edited to the oldest day so the keyset filter would hand it back again.
        if (page === 2) {
          const moved = table.find((row) => row.id === 4);
          if (moved) moved.day = "2026-01-01";
        }
      },
    });
    const result = await fetchAllPages(source.build, 2);
    const ids = result.rows.map((row) => row.id);
    expect(ids.filter((id) => id === 4)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stops on a short page when no count is reported", async () => {
    const source = fakeSource(rowsOf(2000), { reportCount: false });
    const result = await fetchAllPages(source.build, 1000);
    expect(result.rows).toHaveLength(2000);
    expect(result.count).toBe(2000);
    expect(source.builds()).toBe(3);
  });

  it("rejects with the server error instead of returning the partial rows", async () => {
    const error = { message: "permission denied" };
    let builds = 0;
    const build = (): RangeQuery<Row> => {
      builds += 1;
      return {
        range: () =>
          Promise.resolve(
            builds === 1
              ? {
                  data: [
                    { id: 0, day: "2026-01-01" },
                    { id: 1, day: "2026-01-01" },
                  ],
                  error: null,
                  count: 3000,
                }
              : { data: null, error, count: null },
          ),
      };
    };
    await expect(fetchAllPages(build, 2)).rejects.toBe(error);
    expect(builds).toBe(2);
  });
});
