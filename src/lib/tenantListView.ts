import type { ArchiveMode } from "@/hooks/archiveMode";
import type { TenantLifecycle } from "@/integrations/supabase/database.types";

/**
 * تبويب قائمة المستأجرين في شاشة الإدارة: نشط / انتهى العقد / مؤرشف / الكل.
 *
 * Distinct from ArchiveMode because Active and Contract Ended both sit on the
 * non-archived slice; the extra discriminator is lifecycle, not a fourth
 * archive mode.
 */
export type TenantListView = "active" | "ended" | "archived" | "all";

export const TENANT_LIST_VIEWS = ["active", "ended", "archived", "all"] as const;

export const DEFAULT_TENANT_LIST_VIEW: TenantListView = "active";

/**
 * يحوّل تبويب القائمة إلى شريحة الأرشيف ودورة الحالة اللتين تفهمهما الاستعلامات.
 *
 * `archived` and `all` omit `lifecycle` so those tabs keep every lifecycle.
 * `{ lifecycle: undefined }` still enumerates the key; the query must not
 * receive a lifecycle filter at all.
 */
export function resolveTenantListView(view: TenantListView): {
  archiveMode: ArchiveMode;
  lifecycle?: TenantLifecycle;
} {
  switch (view) {
    case "active":
      return { archiveMode: "current", lifecycle: "active" };
    case "ended":
      return { archiveMode: "current", lifecycle: "contract_ended" };
    case "archived":
      return { archiveMode: "archived" };
    case "all":
      return { archiveMode: "all" };
  }
}

/**
 * يحدّد دورة الحياة الفعلية للاستعلام: اختيار المرشّح يغلب تثبيت التبويب.
 *
 * The `?view=active` tab pins `lifecycle=active` on the server and the Life
 * Cycle select filters client-side on the same column; ANDed, "Contract
 * Ended" on the Active tab could never return a row. The select is the more
 * specific intent, so it replaces the pin rather than narrowing it.
 */
export function effectiveTenantLifecycle(
  view: TenantListView,
  selected: string,
): TenantLifecycle | undefined {
  if (selected) return selected as TenantLifecycle;
  return resolveTenantListView(view).lifecycle;
}
