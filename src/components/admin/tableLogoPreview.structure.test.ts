import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * يثبت أن عمودي الشعار في جدولي المستأجرين والعقود يستخدمان المعاينة
 * نفسها (PreviewableImage) المستخدَمة في جدول محلات صفحة الهبوط:
 * طبقة عين تفتح الصورة أكبر بدل صورة ثابتة، والعنصر النائب يبقى
 * كما هو عند غياب الشعار.
 */
const tenantCells = readFileSync(
  resolve(process.cwd(), "src/components/admin/tenants/TenantsTableCells.tsx"),
  "utf8",
);
const contractsTable = readFileSync(
  resolve(process.cwd(), "src/components/admin/contracts/ContractsTable.tsx"),
  "utf8",
);

describe("table logo columns share the landing eye preview", () => {
  test("عمود شعار المستأجر يعاين عبر PreviewableImage", () => {
    expect(tenantCells).toMatch(/PreviewableImage/);
    expect(tenantCells).toMatch(/url=\{logoUrl\}/);
  });

  test("عمود شعار العقد يعاين عبر PreviewableImage", () => {
    expect(contractsTable).toMatch(/PreviewableImage/);
    expect(contractsTable).toMatch(/url=\{contract\.brandLogoUrl\}/);
  });

  test("لا صورة ثابتة بلا معاينة في عمودي الشعار", () => {
    expect(tenantCells).not.toMatch(/<img/);
    expect(contractsTable).not.toMatch(/<img/);
  });

  test("العنصر النائب يبقى عند غياب الشعار", () => {
    expect(tenantCells).toMatch(/logoPlaceholder/);
    expect(contractsTable).toMatch(/logoPlaceholder/);
  });
});
