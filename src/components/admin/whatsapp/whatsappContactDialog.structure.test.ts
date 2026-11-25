import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * يثبت إصلاح عرض نموذج إضافة/تعديل جهة الاتصال:
 * - الحوار أصبح max-w-lg بدل max-w-md ليتسع لاسم المستأجر الطويل
 * - قائمة المستأجرين قابلة للبحث ومحتواها مقلّم (truncate)
 * - SelectItem يطبّق truncate عاماً
 */
const dialog = readFileSync(
  resolve(process.cwd(), "src/components/admin/whatsapp/WhatsAppContactDialog.tsx"),
  "utf8",
);
const tenantPicker = readFileSync(
  resolve(process.cwd(), "src/components/admin/TenantPicker.tsx"),
  "utf8",
);
const tenantOptionLabel = readFileSync(
  resolve(process.cwd(), "src/components/admin/TenantOptionLabel.tsx"),
  "utf8",
);
const selectPrimitive = readFileSync(
  resolve(process.cwd(), "src/components/ui/select.tsx"),
  "utf8",
);

describe("WhatsAppContactDialog width and truncation", () => {
  test("DialogContent هو max-w-lg لا max-w-md", () => {
    expect(dialog).toMatch(/DialogContent\s+className="max-w-lg"/);
    expect(dialog).not.toMatch(/DialogContent\s+className="max-w-md"/);
  });

  test("SelectContent مقيد بـ max-w-[min(92vw,32rem)]", () => {
    expect(dialog).toMatch(/SelectContent\s+className="max-w-\[min\(92vw,32rem\)\]"/);
    expect(tenantPicker).toMatch(/SelectContent\s+className="max-w-\[min\(92vw,32rem\)\]"/);
  });

  test("عناصر المستأجر مقلّمة truncate", () => {
    expect(dialog).toMatch(/SelectItem[^>]*className="truncate"/);
    expect(dialog).toMatch(/<TenantOptionLabel/);
    expect(tenantPicker).toMatch(/SelectItem[^>]*className="truncate"/);
    expect(tenantPicker).toMatch(/<TenantOptionLabel/);
    // The truncate span moved into the shared label so every tenant list
    // keeps it; pin it there rather than in each dialog.
    expect(tenantOptionLabel).toMatch(/<span\s+className="truncate">/);
  });

  test("Select primitive يطبّق truncate على ItemText", () => {
    // يمنع أي Select في المشروع من التمدد أفقياً عند نص طويل
    expect(selectPrimitive).toMatch(/\[&>span:last-child\]:truncate/);
    expect(selectPrimitive).toMatch(/\[&>span:last-child\]:min-w-0/);
  });

  test("القائمة قابلة للبحث وتستخدم tenantDisplayName", () => {
    expect(dialog).toMatch(/tenantSearch/);
    expect(dialog).toMatch(/filteredTenants/);
    expect(dialog).toMatch(/tenantDisplayName\(tenant as never, locale\)/);
    expect(tenantPicker).toMatch(/filteredTenants/);
  });
});
