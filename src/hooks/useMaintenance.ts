import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { notifyMaintenanceRequest } from "@/fns/notifyMaintenanceRequest";
import { usePermissions } from "@/hooks/usePermissions";
import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { supabase } from "@/integrations/supabase/client";
import type {
  MaintenancePriority,
  MaintenanceStatus,
  Tables,
  TablesInsert,
  TablesUpdate,
} from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { fetchExportRows } from "@/lib/pagedQuery";
import { PERMISSIONS } from "@/lib/permissions";

export type MaintenanceRequest = Tables<"maintenance_requests">;

export interface MaintenanceListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  propertyId?: string;
  buildingId?: string;
  unitId?: string;
  priority?: MaintenancePriority;
  status?: MaintenanceStatus;
}

/**
 * يجلب مدى صفوف طلبات الصيانة المطابقة للمرشّحات — اللب المشترك بين القائمة والتصدير.
 */
async function fetchMaintenanceRange(
  params: Omit<MaintenanceListParams, "page" | "pageSize">,
  from: number,
  to: number,
): Promise<{ rows: MaintenanceRequest[]; count: number }> {
  const { search, propertyId, buildingId, unitId, priority, status } = params;
  let query = supabase
    .from("maintenance_requests")
    .select("*", { count: "exact" })
    // `id` is the unique tiebreaker. `created_at` alone is not unique, and an
    // offset page boundary that falls between two rows sharing a timestamp can
    // return one of them twice and skip the other. A total order makes each
    // page boundary deterministic (Codex review, PR #218).
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to);
  if (propertyId) query = query.eq("property_id", propertyId);
  if (buildingId) query = query.eq("building_id", buildingId);
  if (unitId) query = query.eq("unit_id", unitId);
  if (priority) query = query.eq("priority", priority);
  if (status) query = query.eq("status", status);
  const term = normalizePostgrestSearch(search ?? "");
  if (term) {
    query = query.or(`code.ilike.%${term}%,title.ilike.%${term}%`);
  }
  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: data, count: count ?? 0 };
}

/** يجلب صفحة واحدة من طلبات الصيانة للقائمة — غلاف ترقيم فوق fetchMaintenanceRange. */
async function fetchMaintenanceRequests(
  params: Required<Pick<MaintenanceListParams, "page" | "pageSize" | "search">> &
    Omit<MaintenanceListParams, "page" | "pageSize" | "search">,
): Promise<{ items: MaintenanceRequest[]; count: number }> {
  const { page, pageSize, ...filters } = params;
  const from = (page - 1) * pageSize;
  const { rows, count } = await fetchMaintenanceRange(filters, from, from + pageSize - 1);
  return { items: rows, count };
}

export function useMaintenanceRequests(params: MaintenanceListParams = {}, enabled = true) {
  const {
    page = 1,
    pageSize = 10,
    search = "",
    propertyId,
    buildingId,
    unitId,
    priority,
    status,
  } = params;
  return useQuery({
    queryKey: [
      "maintenance",
      { page, pageSize, search, propertyId, buildingId, unitId, priority, status },
    ],
    enabled,
    queryFn: () =>
      fetchMaintenanceRequests({
        page,
        pageSize,
        search,
        propertyId,
        buildingId,
        unitId,
        priority,
        status,
      }),
  });
}

/**
 * بيانات تصدير طلبات الصيانة: كل الصفوف المطابقة صفحةً صفحة بدل أول 500 فقط.
 */
export async function fetchMaintenanceExport(
  params: Omit<MaintenanceListParams, "page" | "pageSize">,
): Promise<{ items: MaintenanceRequest[]; count: number; truncated: boolean }> {
  const { rows, count, truncated } = await fetchExportRows((from, to) =>
    fetchMaintenanceRange(params, from, to),
  );
  return { items: rows, count, truncated };
}

export function useMaintenanceExport(
  params: Omit<MaintenanceListParams, "page" | "pageSize"> = {},
  enabled = true,
) {
  const { search = "", propertyId, buildingId, unitId, priority, status } = params;
  return useQuery({
    queryKey: [
      "maintenance",
      "export",
      { search, propertyId, buildingId, unitId, priority, status },
    ],
    enabled,
    queryFn: () =>
      fetchMaintenanceExport({ search, propertyId, buildingId, unitId, priority, status }),
  });
}

export function useCreateMaintenanceRequest() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (values: TablesInsert<"maintenance_requests">) => {
      if (!permissions.can(PERMISSIONS.MAINTENANCE_CREATE)) throw new Error("Permission denied.");
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("maintenance_requests")
        .insert({ ...values, created_by: user?.id ?? null })
        .select("*")
        .single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "maintenance_request.create",
        entityType: "maintenance_request",
        entityId: data.id,
        after: { ...data },
      });
      try {
        await notifyMaintenanceRequest({ data: { requestId: data.id } });
      } catch (notificationError) {
        console.error("notifyMaintenanceRequest failed:", notificationError);
      }
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["maintenance"] }),
  });
}

export function useUpdateMaintenanceRequest() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: TablesUpdate<"maintenance_requests">;
    }) => {
      if (!permissions.can(PERMISSIONS.MAINTENANCE_UPDATE)) throw new Error("Permission denied.");
      const { data: before, error: beforeError } = await supabase
        .from("maintenance_requests")
        .select("*")
        .eq("id", id)
        .single();
      if (beforeError) throw beforeError;
      const { data: after, error } = await supabase
        .from("maintenance_requests")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "maintenance_request.update",
        entityType: "maintenance_request",
        entityId: id,
        before: { ...before },
        after: { ...after },
      });
      return after;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["maintenance"] }),
  });
}

export function useDeleteMaintenanceRequest() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!permissions.can(PERMISSIONS.MAINTENANCE_DELETE)) throw new Error("Permission denied.");
      const { data: before, error: beforeError } = await supabase
        .from("maintenance_requests")
        .select("*")
        .eq("id", id)
        .single();
      if (beforeError) throw beforeError;
      const { error } = await supabase.from("maintenance_requests").delete().eq("id", id);
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "maintenance_request.delete",
        entityType: "maintenance_request",
        entityId: id,
        before: { ...before },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["maintenance"] }),
  });
}
