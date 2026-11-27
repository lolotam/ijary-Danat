import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "@tanstack/react-router";

import { CompanyContextError } from "@/company/errors";
import type { ModuleKey } from "@/company/modules";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/database.types";

/**
 * خريطة مسارات أقسام لوحة الإدارة إلى مفاتيح الأقسام التي تحرسها.
 *
 * Settings, dashboard root (`/admin/`), and profile stay reachable and are
 * intentionally absent from this map.
 */
export const ADMIN_ROUTE_MODULE_MAP = {
  "/admin/invoices": "invoices",
  "/admin/tenants/": "tenants",
  "/admin/tenants/$id": "tenants",
  "/admin/properties/": "properties",
  "/admin/properties/$id": "properties",
  "/admin/units/": "units",
  "/admin/units/$id": "units",
  "/admin/contracts": "contracts",
  "/admin/contracts_/builder": "contracts",
  "/admin/contracts_/$id/closeout": "contracts",
  "/admin/payments": "payments",
  "/admin/deposits": "deposits",
  "/admin/expenses": "expenses",
  "/admin/electricity": "electricity",
  "/admin/maintenance/": "maintenance",
  "/admin/employees": "employees",
  "/admin/inbox": "inbox",
  "/admin/reports": "reports",
  "/admin/audit": "audit",
} as const satisfies Record<string, ModuleKey>;

/**
 * يتحقق على الخادم من تفعيل القسم للشركة الحالية ويرمي `MODULE_DISABLED` عند تعطيله.
 *
 * Calls `public.module_enabled(_key)` via the provided RLS-scoped or
 * `companyClient` instance so the database remains authoritative.
 */
export async function requireModule(
  db: Pick<SupabaseClient<Database>, "rpc">,
  key: ModuleKey,
): Promise<void> {
  const { data: enabled, error } = await db.rpc("module_enabled", { _key: key });
  if (error) {
    throw new Error(`module_enabled(${key}) failed: ${error.message}`);
  }
  if (!enabled) {
    throw new CompanyContextError("MODULE_DISABLED", undefined, { moduleKey: key });
  }
}

/**
 * حارس `beforeLoad` لمسارات الأقسام في لوحة الإدارة: يعيد التوجيه إلى `/admin` عند تعطيل القسم.
 *
 * Unauthenticated sessions return early so `AdminLayout` can handle the `/auth`
 * redirect, matching `requirePasswordChange`. Database errors fail closed by
 * redirecting away from the gated section.
 */
export async function guardModuleRoute(key: ModuleKey): Promise<void> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session?.user.id) return;

  const { data: enabled, error } = await supabase.rpc("module_enabled", { _key: key });
  if (error) {
    console.error(`[modules] checking module_enabled(${key}) failed:`, error.message);
    throw redirect({ to: "/admin" });
  }
  if (!enabled) {
    throw redirect({ to: "/admin" });
  }
}
