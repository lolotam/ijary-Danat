import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { supabase } from "@/integrations/supabase/client";
import type { TablesInsert, TablesUpdate } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { runReportScheduleForCurrentSession } from "@/lib/runReportSchedule";

export function useReportSchedules(
  params: { page?: number; pageSize?: number; search?: string } = {},
  enabled = true,
) {
  const { page = 1, pageSize = 10, search = "" } = params;
  return useQuery({
    queryKey: ["report-schedules", params],
    enabled,
    queryFn: async () => {
      const from = (page - 1) * pageSize;
      let query = supabase
        .from("report_schedules")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, from + pageSize - 1);
      const term = normalizePostgrestSearch(search);
      if (term)
        query = query.or(`code.ilike.%${term}%,name_ar.ilike.%${term}%,name_en.ilike.%${term}%`);
      const result = await query;
      if (result.error) throw result.error;
      return { items: result.data, count: result.count ?? 0 };
    },
  });
}

export function useCreateReportSchedule() {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (values: TablesInsert<"report_schedules">) => {
      if (!permissions.can(PERMISSIONS.REPORTS_CREATE)) throw new Error("Permission denied.");
      const result = await supabase.from("report_schedules").insert(values).select("*").single();
      if (result.error) throw result.error;
      await logAuditForCurrentSession({
        action: "report_schedule.create",
        entityType: "report_schedule",
        entityId: result.data.id,
        after: result.data,
      });
      return result.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["report-schedules"] }),
  });
}

export function useUpdateReportSchedule() {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: TablesUpdate<"report_schedules">;
    }) => {
      if (!permissions.can(PERMISSIONS.REPORTS_UPDATE)) throw new Error("Permission denied.");
      const before = await supabase.from("report_schedules").select("*").eq("id", id).single();
      if (before.error) throw before.error;
      const result = await supabase
        .from("report_schedules")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (result.error) throw result.error;
      await logAuditForCurrentSession({
        action: "report_schedule.update",
        entityType: "report_schedule",
        entityId: id,
        before: before.data,
        after: result.data,
      });
      return result.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["report-schedules"] }),
  });
}

export function useDeleteReportSchedule() {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!permissions.can(PERMISSIONS.REPORTS_DELETE)) throw new Error("Permission denied.");
      const before = await supabase.from("report_schedules").select("*").eq("id", id).single();
      if (before.error) throw before.error;
      const result = await supabase.from("report_schedules").delete().eq("id", id);
      if (result.error) throw result.error;
      await logAuditForCurrentSession({
        action: "report_schedule.delete",
        entityType: "report_schedule",
        entityId: id,
        before: before.data,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["report-schedules"] }),
  });
}

export function useRunReportSchedule() {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scheduleId: string) => {
      if (!permissions.can(PERMISSIONS.REPORTS_READ)) throw new Error("Permission denied.");
      return runReportScheduleForCurrentSession({ scheduleId, asOf: null });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["report-schedules"] });
      queryClient.invalidateQueries({ queryKey: ["generated-reports"] });
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}
