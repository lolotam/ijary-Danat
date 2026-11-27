import { createServerFn } from "@tanstack/react-start";

import { DEFAULT_MODULE_ENABLED, MODULE_KEYS, type ModuleKey } from "@/company/modules";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** خريطة حالة تفعيل جميع أقسام الشركة الحالية. */
export type ModuleStatusMap = Record<ModuleKey, boolean>;

const MODULE_KEY_SET: ReadonlySet<string> = new Set(MODULE_KEYS);

/**
 * يتحقق من أن المفتاح النصي ينتمي إلى قائمة أقسام الشركة المعروفة.
 */
function isModuleKey(value: string): value is ModuleKey {
  return MODULE_KEY_SET.has(value);
}

/**
 * يحوّل صفوف `get_my_modules()` إلى خريطة كاملة لجميع الأقسام مع تطبيق الافتراضيات.
 *
 * Unknown keys from a newer migration are ignored so a rolling deploy never
 * crashes the navigation query.
 */
export function toModuleStatusMap(
  rows: ReadonlyArray<{ module_key: string; enabled: boolean }> | null | undefined,
): ModuleStatusMap {
  const map: ModuleStatusMap = { ...DEFAULT_MODULE_ENABLED };
  for (const row of rows ?? []) {
    if (isModuleKey(row.module_key)) {
      map[row.module_key] = Boolean(row.enabled);
    }
  }
  return map;
}

/**
 * يجلب حالة أقسام الشركة الحالية من قاعدة البيانات عبر عميل المستخدم المقيّد بـ RLS.
 *
 * `get_my_modules()` resolves overrides against `current_company_id()` and
 * applies `DEFAULT_MODULE_ENABLED` for any unconfigured section.
 */
export const myModules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ModuleStatusMap> => {
    const { data, error } = await context.supabase.rpc("get_my_modules");
    if (error) {
      throw new Error(`get_my_modules failed: ${error.message}`);
    }
    return toModuleStatusMap(data);
  });
