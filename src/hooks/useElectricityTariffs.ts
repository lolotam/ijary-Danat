import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";

export type ElectricityTariff = Tables<"electricity_tariffs">;

export interface ElectricityTariffListParams {
  active?: boolean;
  page?: number;
  pageSize?: number;
  search?: string;
}

async function fetchElectricityTariffs(params: ElectricityTariffListParams) {
  const { page = 1, pageSize = 10 } = params;
  const from = (page - 1) * pageSize;
  let query = supabase
    .from("electricity_tariffs")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1);
  if (params.active !== undefined) query = query.eq("is_active", params.active);
  const term = normalizePostgrestSearch(params.search ?? "");
  if (term) {
    query = query.or(`code.ilike.%${term}%,name_ar.ilike.%${term}%,name_en.ilike.%${term}%`);
  }
  const response = await query;
  if (response.error) throw response.error;
  return { items: response.data, count: response.count ?? 0 };
}

export function useElectricityTariffs(params: ElectricityTariffListParams = {}, enabled = true) {
  return useQuery({
    queryKey: ["electricity-tariffs", params],
    enabled,
    queryFn: () => fetchElectricityTariffs(params),
  });
}

export function useCreateElectricityTariff() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (tariff: TablesInsert<"electricity_tariffs">) => {
      if (!permissions.can(PERMISSIONS.ELECTRICITY_TARIFFS)) {
        throw new Error("Permission denied.");
      }
      const response = await supabase
        .from("electricity_tariffs")
        .insert(tariff)
        .select("*")
        .single();
      if (response.error) throw response.error;
      await logAuditForCurrentSession({
        action: "electricity_tariff.create",
        entityType: "electricity_tariff",
        entityId: response.data.id,
        after: response.data,
      });
      return response.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["electricity-tariffs"] }),
  });
}

export function useUpdateElectricityTariff() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: TablesUpdate<"electricity_tariffs">;
    }) => {
      if (!permissions.can(PERMISSIONS.ELECTRICITY_TARIFFS)) {
        throw new Error("Permission denied.");
      }
      const before = await supabase.from("electricity_tariffs").select("*").eq("id", id).single();
      if (before.error) throw before.error;
      const after = await supabase
        .from("electricity_tariffs")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (after.error) throw after.error;
      await logAuditForCurrentSession({
        action: "electricity_tariff.update",
        entityType: "electricity_tariff",
        entityId: id,
        before: before.data,
        after: after.data,
      });
      return after.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["electricity-tariffs"] }),
  });
}

export function useDeleteElectricityTariff() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (tariff: ElectricityTariff) => {
      if (!permissions.can(PERMISSIONS.ELECTRICITY_TARIFFS)) {
        throw new Error("Permission denied.");
      }
      const response = await supabase.from("electricity_tariffs").delete().eq("id", tariff.id);
      if (response.error) throw response.error;
      await logAuditForCurrentSession({
        action: "electricity_tariff.delete",
        entityType: "electricity_tariff",
        entityId: tariff.id,
        before: tariff,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["electricity-tariffs"] });
      queryClient.invalidateQueries({ queryKey: ["electricity-meters"] });
    },
  });
}
