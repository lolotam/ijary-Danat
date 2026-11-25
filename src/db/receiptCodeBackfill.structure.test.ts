import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * يثبت أن ترحيل 188 يعيد ترقيم الإيصالات القديمة فقط، بتاريخ إصدار كل إيصال
 * وبتوقيت الكويت، دون المساس بالرموز التي تحمل الصيغة الجديدة أصلاً.
 *
 * لا ينفّذ SQL: يقرأ ملف الترحيل المُشحون ويثبت وجود القيود التي لا يستطيع
 * اختبار الوحدة كشفها بعد تطبيق الترحيل.
 */
const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/188_receipt_code_backfill.sql"),
  "utf8",
);

const code = migration.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

describe("migration 188 receipt code backfill", () => {
  test("يقتصر على الرموز التسلسلية القديمة فقط", () => {
    // Without the guard, re-applying the migration would renumber receipts that
    // already carry the requested format — new codes every time it runs.
    expect(code).toMatch(/where\s+code\s+~\s+'\^REC-\[0-9\]\+\$'/i);
  });

  test("يشتق التاريخ من issue_date لا من now()", () => {
    // A receipt issued in August must not be renamed as though it were issued
    // on the day the migration ran.
    expect(code).toMatch(/v_row\.issue_date\s+at\s+time\s+zone\s+'Asia\/Kuwait'/i);
  });

  test("يعيد إصدار next_receipt_code بتوقيت الكويت", () => {
    // The database runs in UTC. Between 21:00 and 23:59 UTC it is already the
    // next day in Kuwait, and a UTC rendering dates the receipt a day early.
    expect(code).toMatch(/create\s+or\s+replace\s+function\s+public\.next_receipt_code\(\)/i);
    expect(code).toMatch(/now\(\)\s+at\s+time\s+zone\s+'Asia\/Kuwait'/i);
  });

  test("يعيد منح صلاحية التنفيذ بعد إعادة إصدار الدالة", () => {
    // Re-issuing a function resets its grants; migration 142 shipped without
    // this and broke every caller that was not a superuser.
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.next_receipt_code\(\)\s+to\s+authenticated\s*,\s*service_role/i,
    );
  });

  test("يحدّ من إعادة المحاولة عند التصادم بدل الدوران بلا نهاية", () => {
    expect(code).toMatch(/v_attempts\s*>=\s*10/);
    expect(code).toMatch(/raise\s+exception/i);
  });
});
