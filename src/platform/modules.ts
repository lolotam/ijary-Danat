import { z } from "zod";

import { DEFAULT_MODULE_ENABLED, MODULE_KEYS, type ModuleKey } from "@/company/modules";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { writePlatformAudit } from "./audit";
import { requirePlatformAdmin } from "./requirePlatformAdmin.server";

/** خريطة حالة الأقسام كما يقرأها مشرف المنصة. */
export type PlatformModuleMap = Record<ModuleKey, boolean>;

/** مفاتيح الأقسام المعروفة، سريعة للتحقق من صفوف قاعدة البيانات. */
const MODULE_KEY_SET: ReadonlySet<string> = new Set<string>(MODULE_KEYS);

/**
 * مخطط تعديل أقسام شركة: الأقسام المعروفة في الهجرة 320 هي المقبولة فقط.
 *
 * The map in `src/company/modules.ts` mirrors the check constraint in migration
 * 320, so using its keys here keeps the browser form and the database in step.
 */
export const setModulesSchema = z.object({
  companyId: z.string().uuid(),
  modules: z
    .array(
      z.object({
        key: z.enum(MODULE_KEYS),
        enabled: z.boolean(),
      }),
    )
    .refine((toggles) => new Set(toggles.map((toggle) => toggle.key)).size === toggles.length, {
      message: "duplicate module key",
    }),
});

/** مدخل تعديل أقسام شركة كما تقبله العملية والمتصفح. */
export type SetModulesInput = z.infer<typeof setModulesSchema>;

/**
 * يتحقق من أن المفتاح النصي ينتمي إلى أقسام الشركة المعروفة.
 */
function isModuleKey(value: string): value is ModuleKey {
  return MODULE_KEY_SET.has(value);
}

/**
 * يحوّل صفوف `company_modules` إلى خريطة كاملة باستخدام القيم الافتراضية للغائب.
 */
function toModuleMap(
  rows: ReadonlyArray<{ module_key: string; enabled: boolean }>,
): PlatformModuleMap {
  const map: PlatformModuleMap = { ...DEFAULT_MODULE_ENABLED };
  for (const row of rows) {
    if (isModuleKey(row.module_key)) {
      map[row.module_key] = Boolean(row.enabled);
    }
  }
  return map;
}

/**
 * يقرأ حالة كل أقسام الشركة من صفوفها، مع القيم الافتراضية للصفوف غير الموجودة.
 */
async function readModuleMap(companyId: string): Promise<PlatformModuleMap> {
  const { data, error } = await supabaseAdmin
    .from("company_modules")
    .select("module_key, enabled")
    .eq("company_id", companyId);
  if (error) throw new Error(`company_modules lookup failed: ${error.message}`);
  return toModuleMap(data ?? []);
}

/**
 * يقرأ حالة أقسام شركة واحدة لعرضها على مشرف المنصة.
 */
export async function platformGetModules(companyId: string): Promise<PlatformModuleMap> {
  await requirePlatformAdmin();
  return readModuleMap(companyId);
}

/**
 * يفعّل أو يوقف أقسام شركة، ويكتب سطر تدقيق واحداً بالحالة قبل وبعد.
 *
 * The guard runs before any read: a refused caller must leave no trace (SC-015).
 * A request that changes nothing writes no row and no audit entry, because no
 * decision was taken that another admin would need to explain later.
 */
export async function platformSetModules(input: SetModulesInput): Promise<PlatformModuleMap> {
  const { userId: actorId } = await requirePlatformAdmin();
  const { companyId, modules } = setModulesSchema.parse(input);

  const before = await readModuleMap(companyId);
  const changes = modules.filter((toggle) => before[toggle.key] !== toggle.enabled);
  if (changes.length === 0) return before;

  const { error } = await supabaseAdmin.from("company_modules").upsert(
    changes.map((toggle) => ({
      company_id: companyId,
      module_key: toggle.key,
      enabled: toggle.enabled,
      updated_by: actorId,
    })),
    { onConflict: "company_id,module_key" },
  );
  if (error) throw new Error(`company_modules upsert failed: ${error.message}`);

  const after: PlatformModuleMap = { ...before };
  for (const toggle of changes) {
    after[toggle.key] = toggle.enabled;
  }

  await writePlatformAudit({
    action: "company.modules.update",
    entity: "company",
    entityId: companyId,
    companyId,
    actorId,
    before,
    after,
  });
  return after;
}
