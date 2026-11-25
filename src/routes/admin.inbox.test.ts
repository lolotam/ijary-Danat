import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * Column alignment in the unified inbox.
 *
 * Regression, 2026-08-01 — the Gmail work added a "Category" column header to
 * the Gmail tab and, by accident, to the Visitors tab as well: both tables end
 * their header row with the same `body` → `actions` pair, and a global
 * search-and-replace matched both. The Visitors tab gained a ninth header with
 * no ninth cell, so every body cell shifted one column left and the delete
 * button rendered under "Category" while "Actions" sat empty.
 *
 * Nothing caught it. It is not a type error, not a lint error, and no test
 * renders these tables — it is only visible by looking at the screen, which is
 * where the owner found it.
 *
 * Counting is scoped to this file rather than applied repo-wide because these
 * four tables render every cell unconditionally. A table with a conditional
 * cell (`{canEdit && <TableCell/>}`) has no single correct count, and a guard
 * that has to guess would be a source of false failures instead of a check.
 */

const SOURCE = readFileSync(join(process.cwd(), "src/routes/admin.inbox.tsx"), "utf8");

interface TabTable {
  tab: string;
  headers: number;
  cells: number;
}

function tabTables(): TabTable[] {
  return [...SOURCE.matchAll(/<TabsContent value="(\w+)"[\s\S]*?<\/TabsContent>/g)].map((match) => {
    const [block, tab] = [match[0], match[1]];
    const body = /<TableBody>([\s\S]*?)<\/TableBody>/.exec(block);
    return {
      tab,
      // SortableHead is a TableHead wrapper the sortable tables use.
      headers: (block.match(/<(?:TableHead|SortableHead)[ >]/g) ?? []).length,
      cells: (body?.[1].match(/<TableCell[ >]/g) ?? []).length,
    };
  });
}

describe("inbox tables", () => {
  test("every tab renders one body cell per column header", () => {
    const tables = tabTables();

    // Guards the guard: if the tab markup is ever restructured so these regexes
    // stop matching, an empty list would pass silently and assert nothing.
    // The whatsapp tab renders a chat UI, not a table — it participates here
    // with zero headers and zero cells, which the alignment check accepts.
    expect(tables.map((table) => table.tab)).toEqual([
      "tenants",
      "visitors",
      "leads",
      "gmail",
      "whatsapp",
    ]);

    const misaligned = tables
      .filter((table) => table.headers !== table.cells)
      .map((table) => `${table.tab}: ${table.headers} headers vs ${table.cells} cells`);

    expect(misaligned).toEqual([]);
  });
});
