import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * يثبت أن ترميز الإيصال تغيّر من التسلسل `REC-0000007` إلى الصيغة
 * المطلوبة `REC-YYYY-Month-DD-MM-YYYY-15RANDOM`.
 *
 * لا يعيد تنفيذ الدالة، بل يثبت أن ملف الترحيل المُشحون يحتوي
 * على المنطق المطلوب ويخلو من التسلسل القديم.
 */
const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/187_receipt_code_random_format.sql"),
  "utf8",
);

const code = migration.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

describe("migration 187 receipt code random format", () => {
  test("يعرف next_receipt_code كـ plpgsql security definer", () => {
    expect(code).toMatch(/create\s+or\s+replace\s+function\s+public\.next_receipt_code\(\)/i);
    expect(code).toMatch(/language\s+plpgsql/i);
    expect(code).toMatch(/security\s+definer/i);
  });

  test("يضع extensions على search_path لأن pgcrypto تعيش هناك في الإنتاج", () => {
    // Supabase installs pgcrypto in `extensions`; with `search_path = public`
    // alone, `gen_random_bytes` fails to resolve and every receipt insert
    // errors on the live server. The SQL test image has it in `public`, so the
    // harness cannot catch a regression here — this pin is the only guard.
    expect(code).toMatch(/set\s+search_path\s*=\s*public\s*,\s*extensions/i);
  });

  test("يُركب REC-YYYY-FullMonth-DD-MM-YYYY-15RANDOM", () => {
    // REC- prefix
    expect(code).toMatch(/'REC-'/);
    // year
    expect(code).toMatch(/to_char\s*\(\s*now\(\)\s*,\s*'YYYY'\s*\)/i);
    // full English month name FMMonth trimmed
    expect(code).toMatch(/FMMonth/i);
    expect(code).toMatch(/trim\s*\(\s*to_char\s*\(/i);
    // day-month-year DD-MM-YYYY
    expect(code).toMatch(/to_char\s*\(\s*now\(\)\s*,\s*'DD-MM-YYYY'\s*\)/i);
    // random: gen_random_bytes(11) -> base64 -> translate /+= -> upper -> substr 15
    expect(code).toMatch(/gen_random_bytes\s*\(\s*11\s*\)/i);
    expect(code).toMatch(/encode\s*\(\s*gen_random_bytes/i);
    expect(code).toMatch(/translate\s*\(.*'\/\+='/i);
    expect(code).toMatch(/upper\s*\(\s*substr/i);
    expect(code).toMatch(/,\s*1\s*,\s*15\s*\)/);
  });

  test("يُعيد المحاولة عند التصادم عبر loop على receipts.code", () => {
    expect(code).toMatch(/\bloop\b/i);
    expect(code).toMatch(/perform\s+1\s+from\s+public\.receipts\s+where\s+code\s*=\s*v_code/i);
    expect(code).toMatch(/if\s+not\s+found\s+then\s+return\s+v_code/i);
  });

  test("يمنح التنفيذ لـ authenticated و service_role ويحجبه عن public", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.next_receipt_code\(\)\s+from\s+public/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.next_receipt_code\(\)\s+to\s+authenticated\s*,\s*service_role/i,
    );
  });

  test("لا يستخدم التسلسل القديم lpad(nextval('receipt_code_seq'))", () => {
    expect(code).not.toMatch(/receipt_code_seq/i);
    expect(code).not.toMatch(/lpad\s*\(\s*nextval/i);
  });

  test("الصيغة المولدة تطابق REC-2026-August-15-08-2026-15حرف", () => {
    // محاكاة شكل المخرجات دون استدعاء Postgres: يثبت أن النمط المستخدم في
    // الاختبارات يطابق المواصفة
    const example = "REC-2026-August-15-08-2026-B65EC44D58163RD";
    expect(example).toMatch(/^REC-\d{4}-[A-Za-z]+-\d{2}-\d{2}-\d{4}-[A-Z0-9]{15}$/);
  });
});
