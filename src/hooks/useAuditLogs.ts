import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { AuditResult, Tables } from "@/integrations/supabase/database.types";

/** قيمة فلتر "المنفّذ" التي تعني صفوف النظام (بلا مستخدم). */
export const SYSTEM_ACTOR = "__system";

export interface AuditLogFilters {
  /** `actor_id`، أو SYSTEM_ACTOR لصفوف النظام. */
  actor?: string;
  role?: string;
  action?: string;
  entityType?: string;
  result?: AuditResult | "all";
  from?: string;
  to?: string;
}

export interface AuditLogPage {
  rows: Tables<"audit_logs">[];
  count: number;
  totalPages: number;
}

/** يعتبر القيمة الفارغة و"all" غياباً للفلتر. */
function active(value: string | undefined): value is string {
  return Boolean(value) && value !== "all";
}

/** يجلب صفحة واحدة من سجل التدقيق بالفلاتر المعطاة. */
async function fetchAuditPage(
  page: number,
  pageSize: number,
  filters: AuditLogFilters,
): Promise<AuditLogPage> {
  const offset = (page - 1) * pageSize;
  let query = supabase
    .from("audit_logs")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (active(filters.actor)) {
    query =
      filters.actor === SYSTEM_ACTOR
        ? query.is("actor_id", null)
        : query.eq("actor_id", filters.actor);
  }
  if (active(filters.role)) query = query.eq("role", filters.role);
  if (active(filters.action)) query = query.eq("action", filters.action);
  if (active(filters.entityType)) query = query.eq("entity_type", filters.entityType);
  if (filters.result && filters.result !== "all") query = query.eq("result", filters.result);
  if (filters.from) query = query.gte("created_at", `${filters.from}T00:00:00.000Z`);
  if (filters.to) query = query.lte("created_at", `${filters.to}T23:59:59.999Z`);

  const { data, count, error } = await query;
  if (error) throw error;

  const exactCount = count ?? 0;
  return {
    rows: data,
    count: exactCount,
    totalPages: Math.max(1, Math.ceil(exactCount / pageSize)),
  };
}

/**
 * يجلب صفحة من سجل التدقيق، ويجلب الصفحة التالية مسبقاً في الخلفية.
 *
 * The prefetch is what makes "next" feel instant: the round trip to PostgREST
 * is the dominant cost (spec §3), and paying it while the user is still
 * reading the current page hides it entirely.
 */
export function useAuditLogs(
  page: number,
  pageSize: number,
  filters: AuditLogFilters = {},
  enabled = true,
) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["audit-logs", page, pageSize, filters],
    enabled,
    queryFn: () => fetchAuditPage(page, pageSize, filters),
    placeholderData: (previous) => previous,
  });

  const totalPages = query.data?.totalPages ?? 0;
  useEffect(() => {
    if (!enabled || page >= totalPages) return;
    void queryClient.prefetchQuery({
      queryKey: ["audit-logs", page + 1, pageSize, filters],
      queryFn: () => fetchAuditPage(page + 1, pageSize, filters),
    });
  }, [enabled, page, pageSize, filters, totalPages, queryClient]);

  return query;
}

export interface AuditFilterOptions {
  actors: Array<{ id: string; label: string | null }>;
  roles: string[];
  actions: string[];
  entity_types: string[];
}

/**
 * يجلب القيم الموجودة فعلاً في السجل لتعبئة قوائم الفلاتر.
 *
 * Five minutes stale: the lists change only when a new kind of action is
 * logged, and refetching them on every filter change would add a round trip
 * to exactly the interaction that should feel fastest.
 */
export function useAuditFilterOptions(enabled = true) {
  return useQuery({
    queryKey: ["audit-log-filter-options"],
    enabled,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<AuditFilterOptions> => {
      const { data, error } = await supabase.rpc("audit_log_filter_options");
      if (error) throw error;
      return data as unknown as AuditFilterOptions;
    },
  });
}
