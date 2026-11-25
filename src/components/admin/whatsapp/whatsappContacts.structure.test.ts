import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * يثبت بنية جدول جهات الاتصال: ترويسة قابلة للفرز في كل عمود، وعمود
 * المستأجر المرتبط يفتح صفحته، وعدد الأعمدة متطابق مع صفوف الحالات الفارغة.
 *
 * A column count that drifts from its `colSpan` is invisible to the type
 * checker and to every render test that only looks at a populated table — the
 * loading and empty rows are the ones that break, and only on screen.
 */
const source = readFileSync(
  resolve(process.cwd(), "src/components/admin/whatsapp/WhatsAppContacts.tsx"),
  "utf8",
);

describe("whatsapp contacts table", () => {
  test("every data column carries a sort toggle", () => {
    const keys = [...source.matchAll(/<SortableHead\s+sortKey="([\w_]+)"/g)].map(
      (match) => match[1],
    );
    expect(keys).toEqual([
      "name",
      "commercial_name",
      "tenant",
      "contracts",
      "phone",
      "email",
      "notes",
    ]);
  });

  test("the linked tenant opens the tenant page", () => {
    expect(source).toMatch(/to="\/admin\/tenants\/\$id"/);
    expect(source).toMatch(/params=\{\{ id: contact\.tenant\.id \}\}/);
    // An unlinked contact renders a dash, not an empty link to nowhere.
    expect(source).toMatch(/contact\.tenant \? \(/);
  });

  test("the tenant name follows the page language", () => {
    expect(source).toMatch(/tenantDisplayName\(contact\.tenant, locale\)/);
  });

  test("loading and empty rows span every column", () => {
    // 7 sortable heads + the row-number head + the actions head.
    const headCount = [...source.matchAll(/<SortableHead\b|<TableHead\b/g)].length;
    const spans = [...source.matchAll(/colSpan=\{(\d+)\}/g)].map((match) => Number(match[1]));
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) expect(span).toBe(headCount);
  });
});
