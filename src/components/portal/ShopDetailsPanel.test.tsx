import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * يتحقق أن لوحة المستأجر لا تتيح تعديل أي حقل إداري.
 *
 * الحقول الإدارية يجب ألا تكون في الشيفرة أصلاً، لا مخفية بـ CSS — إخفاء عنصر
 * بالتنسيق يترك الحقل قابلاً للإرسال.
 *
 * The assertion is on how a field is BOUND (`register`, `setValue`, `watch`, a
 * `name=`), not on the bare word appearing anywhere in the file. An earlier
 * version searched for the substring "contract" and broke the moment the panel
 * legitimately scoped its query to the selected contract — a test that fails on
 * a correct change while proving nothing about the field it was named after.
 */
describe("ShopDetailsPanel — tenant vs admin fields", () => {
  // Every file that renders an editable control inside the tenant panel. The
  // image fields were split out of the panel; without listing the new file an
  // admin-only field added there would pass this suite unseen.
  const panel = [
    "src/components/portal/ShopDetailsPanel.tsx",
    "src/components/portal/ShopImageField.tsx",
  ]
    .map((file) => readFileSync(resolve(file), "utf-8"))
    .join("\n");
  const sharedFields = readFileSync(resolve("src/components/shop/ShopDetailsFields.tsx"), "utf-8");

  /** الحقول التي تبقى للإدارة وحدها — قرار المالك، لا تفصيل تنفيذي. */
  const ADMIN_ONLY_FIELDS = [
    "slug",
    "is_active",
    "display_order",
    "is_featured",
    "show_in_brands_marquee",
    "show_in_shop_explorer",
    "property_id",
    "unit_id",
  ];

  /** أشكال ربط الحقل بالنموذج التي تجعله قابلاً للإرسال. */
  function bindsField(source: string, field: string): boolean {
    return [
      `register("${field}"`,
      `setValue("${field}"`,
      `watch("${field}"`,
      `name="${field}"`,
      `field("${field}")`,
    ].some((binding) => source.includes(binding));
  }

  it.each(ADMIN_ONLY_FIELDS)("لا يربط لوحة المستأجر الحقل الإداري %s", (field) => {
    expect(bindsField(panel, field)).toBe(false);
    expect(bindsField(sharedFields, field)).toBe(false);
  });

  // The tenant must not be able to change which contracts the shop belongs to.
  it("لا يعرض حقل ربط العقود", () => {
    expect(panel).not.toContain("BrandContractsField");
    expect(sharedFields).not.toContain("BrandContractsField");
    expect(panel).not.toContain("save_brand_contracts");
  });

  it.each([
    "name_original",
    "name_ar",
    "name_en",
    "phone",
    "opening_hours",
    "website_url",
    "instagram_url",
    "description_ar",
    "description_en",
  ])("يربط الحقل المشترك %s", (field) => {
    expect(bindsField(sharedFields, field)).toBe(true);
  });
});
