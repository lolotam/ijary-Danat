import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { resendGeneratedReportForCurrentSession } from "@/lib/resendGeneratedReport";

export interface GeneratedReportWithSchedule extends Tables<"generated_reports"> {
  schedule: Pick<Tables<"report_schedules">, "id" | "code" | "name_ar" | "name_en"> | null;
}

export function useGeneratedReports(
  params: { page?: number; pageSize?: number; search?: string } = {},
  enabled = true,
) {
  const { page = 1, pageSize = 10, search = "" } = params;
  return useQuery({
    queryKey: ["generated-reports", params],
    enabled,
    queryFn: async () => {
      let scheduleIds: string[] | null = null;
      if (search.trim()) {
        const schedules = await supabase
          .from("report_schedules")
          .select("id")
          .or(
            `code.ilike.%${search.trim()}%,name_ar.ilike.%${search.trim()}%,name_en.ilike.%${search.trim()}%`,
          );
        if (schedules.error) throw schedules.error;
        scheduleIds = schedules.data.map((item) => item.id);
        if (!scheduleIds.length) return { items: [] as GeneratedReportWithSchedule[], count: 0 };
      }
      const from = (page - 1) * pageSize;
      let query = supabase
        .from("generated_reports")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, from + pageSize - 1);
      if (scheduleIds) query = query.in("schedule_id", scheduleIds);
      const result = await query;
      if (result.error) throw result.error;
      const ids = [
        ...new Set(result.data.flatMap((item) => (item.schedule_id ? [item.schedule_id] : []))),
      ];
      const schedules = ids.length
        ? await supabase.from("report_schedules").select("id,code,name_ar,name_en").in("id", ids)
        : { data: [], error: null };
      if (schedules.error) throw schedules.error;
      const map = new Map(schedules.data.map((item) => [item.id, item]));
      return {
        items: result.data.map((item) => ({
          ...item,
          schedule: item.schedule_id ? (map.get(item.schedule_id) ?? null) : null,
        })),
        count: result.count ?? 0,
      };
    },
  });
}

export function useResendGeneratedReport() {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reportId: string) => {
      if (!permissions.can(PERMISSIONS.REPORTS_READ)) throw new Error("Permission denied.");
      return resendGeneratedReportForCurrentSession({ reportId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["generated-reports"] });
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

export function useDeleteGeneratedReport() {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!permissions.can(PERMISSIONS.REPORTS_DELETE)) throw new Error("Permission denied.");
      const before = await supabase.from("generated_reports").select("*").eq("id", id).single();
      if (before.error) throw before.error;
      const result = await supabase.from("generated_reports").delete().eq("id", id);
      if (result.error) throw result.error;
      await logAuditForCurrentSession({
        action: "generated_report.delete",
        entityType: "generated_report",
        entityId: id,
        before: before.data,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["generated-reports"] }),
  });
}
