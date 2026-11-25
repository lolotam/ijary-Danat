import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * يثبت أن قائمتي اختيار المستأجر (WhatsApp و TenantPicker) مرتبتان
 * حسب رقم المستأجر `DANA-00001 → DANA-00066` لا حسب الاسم.
 *
 * Mirrors the requirement that both dropdowns share the same source/
 * order, which is verified by reading the shipped source rather than
 * by mocking Supabase at runtime.
 */
// The WhatsApp tenant/contract option hooks live in the contacts module since
// `useWhatsAppInbox` was split at the size ceiling; `useWhatsAppInbox`
// re-exports them, so call sites — and this requirement — are unchanged.
const inboxHook = readFileSync(
  resolve(process.cwd(), "src/hooks/useWhatsAppContactsData.ts"),
  "utf8",
);
const contractedHook = readFileSync(
  resolve(process.cwd(), "src/hooks/useContractedTenants.ts"),
  "utf8",
);

describe("tenant dropdowns ordered by code DANA-00001", () => {
  test("useWhatsAppTenantOptions يرتب حسب code", () => {
    // يأخذ مقطع الدالة فقط حتى لا يتأثر بترتيب العقود created_at في نفس الملف
    const fn = inboxHook.slice(
      inboxHook.indexOf("export function useWhatsAppTenantOptions"),
      inboxHook.indexOf("export function useTenantContractOptions"),
    );
    expect(fn).toMatch(/\.order\s*\(\s*"code"\s*,\s*\{\s*ascending\s*:\s*true\s*\}\s*\)/);
    expect(fn).not.toMatch(/\.order\s*\(\s*"name"\s*,/);
  });

  test("useContractedTenants يرتب حسب code", () => {
    expect(contractedHook).toMatch(
      /\.order\s*\(\s*"code"\s*,\s*\{\s*ascending\s*:\s*true\s*\}\s*\)/,
    );
    expect(contractedHook).not.toMatch(/\.order\s*\(\s*"name"\s*,/);
  });

  test("كلاهما يفلتر archived_at is null ويحدّد limit 1000", () => {
    expect(inboxHook).toMatch(/\.is\s*\(\s*"archived_at"\s*,\s*null\s*\)/);
    expect(contractedHook).toMatch(/\.is\s*\(\s*"archived_at"\s*,\s*null\s*\)/);
    expect(inboxHook).toMatch(/\.limit\s*\(\s*1000\s*\)/);
    expect(contractedHook).toMatch(/\.limit\s*\(\s*1000\s*\)/);
  });

  test("كلاهما يفلتر المستأجرين المتعاقدين فقط (has contract)", () => {
    expect(inboxHook).toMatch(/from\s*\(\s*"contracts"\s*\)/);
    expect(contractedHook).toMatch(/from\s*\(\s*"contracts"\s*\)/);
    expect(inboxHook).toMatch(/contracted\.has\(tenant\.id\)/);
    expect(contractedHook).toMatch(/contracted\.has\(tenant\.id\)/);
  });

  test("يعرضان الاسم ثنائي اللغة + code", () => {
    expect(inboxHook).toMatch(/select\s*\(\s*"id,\s*name,\s*name_en,\s*code,\s*email,/);
    expect(inboxHook).toMatch(/commercial_name_ar,\s*commercial_name_en/);
    expect(contractedHook).toMatch(/select\s*\(\s*"id,\s*name,\s*name_en,\s*code/);
  });

  test("خيارات جهة الاتصال تجلب البريد والاسم التجاري للتعبئة التلقائية", () => {
    // حوار إضافة جهة الاتصال يعبئ البريد والاسم التجاري من بيانات المستأجر
    // عند اختياره، فيحتاج الحقلان في نفس الاستعلام لا استعلامًا إضافيًا.
    const fn = inboxHook.slice(
      inboxHook.indexOf("export function useWhatsAppTenantOptions"),
      inboxHook.indexOf("export function useTenantContractOptions"),
    );
    expect(fn).toMatch(/email/);
    expect(fn).toMatch(/commercial_name/);
  });
});
