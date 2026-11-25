/**
 * كل خطاف يُبطل كاش الفواتير أو الدفعات يُبطل كاش البوابة معه.
 *
 * Audit M22: staff preview the tenant portal in the same React Query cache as
 * the admin app, and the portal fix had been written four ways while the most
 * frequent mutations — recording, allocating and reversing a payment,
 * generating invoices, closing out a contract — invalidated no portal key at
 * all. An admin who recorded a payment and switched to the preview saw the old
 * balance. This scan fails the build when a hook invalidates `invoices` or
 * `payments` without `invalidatePortalViews`, so the next such hook cannot
 * quietly reintroduce the gap.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const HOOKS_DIR = join(__dirname);
/**
 * Directories scanned. The invoice tables' shared row-action hooks live beside
 * the tables in components/admin/{invoices,tenant-detail}, not in src/hooks, and invalidate
 * `invoices` too — a src/hooks-only scan could not see them.
 */
const SCANNED_DIRS = [
  HOOKS_DIR,
  join(__dirname, "../components/admin/invoices"),
  join(__dirname, "../components/admin/tenant-detail"),
];

/** يرجع مسارات ملفات الخطافات (لا الاختبارات) التي تُبطل مفتاح الفواتير أو الدفعات. */
function hooksInvalidatingMoney(): string[] {
  return SCANNED_DIRS.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name) && !name.includes(".test."))
      .map((name) => join(dir, name)),
  )
    .filter((path) => {
      const source = readFileSync(path, "utf8");
      return (
        /invalidateQueries\(\{\s*queryKey:\s*\["(invoices|payments)"/.test(source) ||
        /for \(const key of \[[^\]]*"(invoices|payments)"/s.test(source)
      );
    })
    .map((path) => path.slice(path.lastIndexOf("src")).replaceAll("\\", "/"));
}

describe("portal invalidation coverage", () => {
  it("finds the money hooks it is meant to police", () => {
    // Guards the scan itself: an empty list would make the real test vacuous.
    expect(hooksInvalidatingMoney()).toEqual(
      expect.arrayContaining([
        "src/hooks/useReversePayment.ts",
        "src/hooks/usePayments.ts",
        "src/hooks/useGenerateInvoices.ts",
        "src/components/admin/invoices/useInvoicePaidToggle.ts",
      ]),
    );
  });

  it.each(hooksInvalidatingMoney())("%s also invalidates the portal views", (path) => {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    expect(source).toContain("invalidatePortalViews(");
  });
});
