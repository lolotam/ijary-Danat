import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { fetchExportRows } from "@/lib/pagedQuery";
import { PERMISSIONS } from "@/lib/permissions";

export type Building = Tables<"buildings">;
export type BuildingCategory = Tables<"building_categories">;
export interface BuildingListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  propertyId?: string;
  categoryId?: string;
  status?: Building["status"];
}

/**
 * يجلب مدى صفوف المباني المطابقة للمرشّحات — اللب المشترك بين القائمة والتصدير.
 */
async function fetchBuildingRange(
  params: Omit<BuildingListParams, "page" | "pageSize">,
  from: number,
  to: number,
): Promise<{ rows: Building[]; count: number }> {
  const { search, propertyId, categoryId, status } = params;
  let query = supabase
    .from("buildings")
    .select("*", { count: "exact" })
    // `id` is the unique tiebreaker. `created_at` alone is not unique, and an
    // offset page boundary that falls between two rows sharing a timestamp can
    // return one of them twice and skip the other. A total order makes each
    // page boundary deterministic (Codex review, PR #218).
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to);
  if (propertyId) query = query.eq("property_id", propertyId);
  if (categoryId) query = query.eq("category_id", categoryId);
  if (status) query = query.eq("status", status);
  const term = normalizePostgrestSearch(search ?? "");
  if (term) {
    query = query.or(`code.ilike.%${term}%,name_ar.ilike.%${term}%,name_en.ilike.%${term}%`);
  }
  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: data, count: count ?? 0 };
}

/** يجلب صفحة واحدة من المباني للقائمة — غلاف ترقيم فوق fetchBuildingRange. */
async function fetchBuildings(
  params: Required<Pick<BuildingListParams, "page" | "pageSize" | "search">> &
    Pick<BuildingListParams, "propertyId" | "categoryId" | "status">,
): Promise<{ items: Building[]; count: number }> {
  const { page, pageSize, search, propertyId, categoryId, status } = params;
  const from = (page - 1) * pageSize;
  const { rows, count } = await fetchBuildingRange(
    { search, propertyId, categoryId, status },
    from,
    from + pageSize - 1,
  );
  return { items: rows, count };
}

export function useBuildings(params: BuildingListParams = {}, enabled = true) {
  const { page = 1, pageSize = 10, search = "", propertyId, categoryId, status } = params;
  return useQuery({
    queryKey: ["buildings", { page, pageSize, search, propertyId, categoryId, status }],
    enabled,
    queryFn: () => fetchBuildings({ page, pageSize, search, propertyId, categoryId, status }),
  });
}

/**
 * بيانات تصدير المباني: كل الصفوف المطابقة صفحةً صفحة بدل أول 500 فقط.
 */
export async function fetchBuildingExport(
  params: Omit<BuildingListParams, "page" | "pageSize">,
): Promise<{ items: Building[]; count: number; truncated: boolean }> {
  const { rows, count, truncated } = await fetchExportRows((from, to) =>
    fetchBuildingRange(params, from, to),
  );
  return { items: rows, count, truncated };
}

export function useBuildingExport(
  params: Omit<BuildingListParams, "page" | "pageSize"> = {},
  enabled = true,
) {
  const { search = "", propertyId, categoryId, status } = params;
  return useQuery({
    queryKey: ["buildings", "export", { search, propertyId, categoryId, status }],
    enabled,
    queryFn: () => fetchBuildingExport({ search, propertyId, categoryId, status }),
  });
}

export function useBuilding(id: string | null) {
  return useQuery({
    queryKey: ["building", id],
    enabled: Boolean(id),
    queryFn: async (): Promise<Building> => {
      const { data, error } = await supabase.from("buildings").select("*").eq("id", id!).single();
      if (error) throw error;
      return data;
    },
  });
}

export function useBuildingCategories(enabled = true) {
  return useQuery({
    queryKey: ["building-categories"],
    enabled,
    queryFn: async (): Promise<BuildingCategory[]> => {
      const { data, error } = await supabase
        .from("building_categories")
        .select("*")
        .order("sort_order");
      if (error) throw error;
      return data;
    },
  });
}

export function useCreateBuilding() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (values: TablesInsert<"buildings">) => {
      if (!permissions.can(PERMISSIONS.BUILDINGS_CREATE)) throw new Error("Permission denied.");
      const { data, error } = await supabase.from("buildings").insert(values).select("*").single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "building.create",
        entityType: "building",
        entityId: data.id,
        after: { ...data },
      });
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["buildings"] }),
  });
}

export function useUpdateBuilding() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: TablesUpdate<"buildings"> }) => {
      if (!permissions.can(PERMISSIONS.BUILDINGS_UPDATE)) throw new Error("Permission denied.");
      const { data: before, error: beforeError } = await supabase
        .from("buildings")
        .select("*")
        .eq("id", id)
        .single();
      if (beforeError) throw beforeError;
      const { data: after, error } = await supabase
        .from("buildings")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "building.update",
        entityType: "building",
        entityId: id,
        before: { ...before },
        after: { ...after },
      });
      return after;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["buildings"] }),
  });
}

export function useDeleteBuilding() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!permissions.can(PERMISSIONS.BUILDINGS_DELETE)) throw new Error("Permission denied.");
      const { data: before, error: beforeError } = await supabase
        .from("buildings")
        .select("*")
        .eq("id", id)
        .single();
      if (beforeError) throw beforeError;
      const { error } = await supabase.from("buildings").delete().eq("id", id);
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "building.delete",
        entityType: "building",
        entityId: id,
        before: { ...before },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["buildings"] }),
  });
}

export function useCreateBuildingCategory() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (values: TablesInsert<"building_categories">) => {
      if (!permissions.can(PERMISSIONS.BUILDINGS_UPDATE)) throw new Error("Permission denied.");
      const { data, error } = await supabase
        .from("building_categories")
        .insert(values)
        .select("*")
        .single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "building_category.create",
        entityType: "building_category",
        entityId: data.id,
        after: { ...data },
      });
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["building-categories"] }),
  });
}

export function useUpdateBuildingCategory() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: TablesUpdate<"building_categories">;
    }) => {
      if (!permissions.can(PERMISSIONS.BUILDINGS_UPDATE)) throw new Error("Permission denied.");
      const { data: before, error: beforeError } = await supabase
        .from("building_categories")
        .select("*")
        .eq("id", id)
        .single();
      if (beforeError) throw beforeError;
      const { data: after, error } = await supabase
        .from("building_categories")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "building_category.update",
        entityType: "building_category",
        entityId: id,
        before: { ...before },
        after: { ...after },
      });
      return after;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["building-categories"] }),
  });
}

export function useDeleteBuildingCategory() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (category: BuildingCategory) => {
      if (!permissions.can(PERMISSIONS.BUILDINGS_UPDATE)) throw new Error("Permission denied.");
      const { error } = await supabase.from("building_categories").delete().eq("id", category.id);
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "building_category.delete",
        entityType: "building_category",
        entityId: category.id,
        before: { ...category },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["building-categories"] }),
  });
}
