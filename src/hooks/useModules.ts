import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/auth/AuthProvider";
import { DEFAULT_MODULE_ENABLED, type ModuleKey } from "@/company/modules";
import { myModules, type ModuleStatusMap } from "@/fns/myModules";

/** مفتاح الاستعلام لحالة أقسام الشركة الحالية. */
export const MODULES_QUERY_KEY = ["my-modules"] as const;

/** مدة صلاحية الكاش القصوى لحالة الأقسام (60 ثانية حسب FR-040). */
export const MODULES_STALE_TIME_MS = 60_000;

/**
 * يرجع حالة تفعيل قسم واحد مع الفشل مغلقاً عند تعذر التحميل.
 *
 * While the query is loading for the first time, `DEFAULT_MODULE_ENABLED`
 * prevents nav flicker for standard sections while keeping `landing_page` and
 * `maintenance` hidden by default.
 */
export function resolveModuleEnabled(
  modules: ModuleStatusMap | undefined,
  isError: boolean,
): (key: ModuleKey) => boolean {
  return (key: ModuleKey) => {
    if (modules) return Boolean(modules[key]);
    if (isError) return false;
    return DEFAULT_MODULE_ENABLED[key];
  };
}

/**
 * يجلب حالة أقسام الشركة الحالية عبر TanStack Query بكاش لا يتجاوز 60 ثانية.
 */
export function useModules() {
  const { user } = useAuth();

  const query = useQuery({
    queryKey: MODULES_QUERY_KEY,
    enabled: Boolean(user?.id),
    queryFn: (): Promise<ModuleStatusMap> => myModules(),
    staleTime: MODULES_STALE_TIME_MS,
  });

  return {
    ...query,
    modules: query.data,
    isModuleEnabled: resolveModuleEnabled(query.data, query.isError),
  };
}
