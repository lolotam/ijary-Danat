import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * يثبت أن صفحة تفاصيل المستأجر تعرض زر تعديل يفتح نفس
 * TenantFormDialog المستخدم في عمود الإجراءات (أيقونة القلم).
 */
const detail = readFileSync(
  resolve(process.cwd(), "src/routes/admin.tenants.$id.index.tsx"),
  "utf8",
);

describe("tenant detail page edit button", () => {
  test("يستورد TenantFormDialog وأيقونة Pencil", () => {
    expect(detail).toMatch(
      /import\s*\{\s*TenantFormDialog\s*\}\s*from\s*"@\/components\/admin\/tenants\/TenantFormDialog"/,
    );
    expect(detail).toMatch(/Pencil/);
    expect(detail).toMatch(/from\s*"lucide-react"/);
  });

  test("يملك حالة editOpen ويحرسها بـ TENANTS_UPDATE", () => {
    expect(detail).toMatch(/const\s*\[editOpen,\s*setEditOpen\]\s*=\s*useState\(false\)/);
    expect(detail).toMatch(/canEdit\s*=\s*permissions\.can\(PERMISSIONS\.TENANTS_UPDATE\)/);
  });

  test('زر التعديل بجانب الطباعة ويستخدم t("tenants.edit")', () => {
    expect(detail).toMatch(
      /variant="outline"\s+size="sm"\s+onClick=\{\(\)\s*=>\s*setEditOpen\(true\)\}/,
    );
    expect(detail).toMatch(/t\("tenants\.edit"\)/);
    expect(detail).toMatch(/\{canEdit\s*&&\s*\(/);
  });

  test("يرسم TenantFormDialog مع editing={tenant.data}", () => {
    expect(detail).toMatch(
      /<TenantFormDialog\s+open=\{editOpen\}\s+onOpenChange=\{setEditOpen\}\s+editing=\{tenant\.data/,
    );
  });
});
