/**
 * كل قراءة "الشركة الأولى" مرتّبة — لا `limit(1)` بلا ORDER BY على جدول الشركات.
 *
 * Audit H7 (the cheap half): an unordered `LIMIT 1` in Postgres returns an
 * undefined row — the planner may answer with any company. With one company
 * nothing is wrong yet, but a second company would start printing the wrong
 * header on receipts (`paymentReceiptPdf` reads `*` for exactly that) at
 * random. The rule is "order by created_at, then limit"; this scan fails the
 * build when a new read forgets it. A read that filters by `id` is exempt —
 * it already names its row.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

/** يجمع مسارات ملفات المصدر (لا الاختبارات) تحت مجلد. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !name.includes(".test.") ? [path] : [];
  });
}

/** يرجع كل استعلام شركات يحدّ بصف واحد دون ترتيب ولا تصفية بالمعرّف. */
function unorderedCompanyReads(): string[] {
  const found: string[] = [];
  for (const path of sourceFiles(SRC)) {
    const source = readFileSync(path, "utf8");
    let index = source.indexOf('.from("companies")');
    while (index !== -1) {
      const statement = source.slice(index, source.indexOf(";", index));
      if (
        statement.includes(".limit(1)") &&
        !statement.includes(".order(") &&
        !statement.includes('.eq("id"')
      ) {
        found.push(relative(SRC, path).replace(/\\/g, "/"));
      }
      index = source.indexOf('.from("companies")', index + 1);
    }
  }
  return found;
}

describe("company reads", () => {
  it("never take an arbitrary first row", () => {
    expect(unorderedCompanyReads()).toEqual([]);
  });
});
