import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import type {
  ElectricityMeterOwnership,
  Tables,
  TablesInsert,
  TablesUpdate,
} from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";

export type ElectricityMeter = Tables<"electricity_meters">;
type MeterUnit = Pick<Tables<"units">, "code" | "electricity_meter_ownership" | "id" | "name">;
type MeterTariff = Pick<
  Tables<"electricity_tariffs">,
  "code" | "id" | "name_ar" | "name_en" | "type" | "unit_price"
>;

export interface ElectricityMeterWithRelations extends ElectricityMeter {
  tariff: MeterTariff | null;
  unit: MeterUnit | null;
}

export interface ElectricityMeterListParams {
  active?: boolean;
  ownership?: ElectricityMeterOwnership;
  page?: number;
  pageSize?: number;
  search?: string;
  unitId?: string;
}

async function matchingUnitIds(term: string) {
  const response = await supabase
    .from("units")
    .select("id")
    .or(`code.ilike.%${term}%,name.ilike.%${term}%`)
    .limit(100);
  if (response.error) throw response.error;
  return response.data.map((unit) => unit.id);
}

async function enrichElectricityMeters(
  meters: ElectricityMeter[],
): Promise<ElectricityMeterWithRelations[]> {
  if (!meters.length) return [];
  const unitIds = [...new Set(meters.map((meter) => meter.unit_id))];
  const tariffIds = [
    ...new Set(meters.flatMap((meter) => (meter.tariff_id ? [meter.tariff_id] : []))),
  ];
  const units = await supabase
    .from("units")
    .select("id,code,name,electricity_meter_ownership")
    .in("id", unitIds);
  const tariffs = tariffIds.length
    ? await supabase
        .from("electricity_tariffs")
        .select("id,code,name_ar,name_en,type,unit_price")
        .in("id", tariffIds)
    : { data: [] as MeterTariff[], error: null };
  if (units.error) throw units.error;
  if (tariffs.error) throw tariffs.error;
  const unitMap = new Map(units.data.map((unit) => [unit.id, unit]));
  const tariffMap = new Map(tariffs.data.map((tariff) => [tariff.id, tariff]));
  return meters.map((meter) => ({
    ...meter,
    unit: unitMap.get(meter.unit_id) ?? null,
    tariff: meter.tariff_id ? (tariffMap.get(meter.tariff_id) ?? null) : null,
  }));
}

async function fetchElectricityMeters(params: ElectricityMeterListParams) {
  const { page = 1, pageSize = 10 } = params;
  const from = (page - 1) * pageSize;
  const term = normalizePostgrestSearch(params.search ?? "");
  const unitIds = term ? await matchingUnitIds(term) : [];
  let query = supabase
    .from("electricity_meters")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1);
  if (params.active !== undefined) query = query.eq("is_active", params.active);
  if (params.ownership) query = query.eq("ownership", params.ownership);
  if (params.unitId) query = query.eq("unit_id", params.unitId);
  if (term) {
    const unitClause = unitIds.length ? `,unit_id.in.(${unitIds.join(",")})` : "";
    query = query.or(`meter_number.ilike.%${term}%${unitClause}`);
  }
  const response = await query;
  if (response.error) throw response.error;
  return {
    items: await enrichElectricityMeters(response.data),
    count: response.count ?? 0,
  };
}

export function useElectricityMeters(params: ElectricityMeterListParams = {}, enabled = true) {
  return useQuery({
    queryKey: ["electricity-meters", params],
    enabled,
    queryFn: () => fetchElectricityMeters(params),
  });
}

export function useCreateElectricityMeter() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (meter: TablesInsert<"electricity_meters">) => {
      if (!permissions.isAdmin || !permissions.can(PERMISSIONS.ELECTRICITY_CREATE)) {
        throw new Error("Permission denied.");
      }
      const response = await supabase.from("electricity_meters").insert(meter).select("*").single();
      if (response.error) throw response.error;
      await logAuditForCurrentSession({
        action: "electricity_meter.create",
        entityType: "electricity_meter",
        entityId: response.data.id,
        after: response.data,
      });
      return response.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["electricity-meters"] }),
  });
}

export function useUpdateElectricityMeter() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: TablesUpdate<"electricity_meters">;
    }) => {
      if (!permissions.isAdmin || !permissions.can(PERMISSIONS.ELECTRICITY_UPDATE)) {
        throw new Error("Permission denied.");
      }
      const before = await supabase.from("electricity_meters").select("*").eq("id", id).single();
      if (before.error) throw before.error;
      const after = await supabase
        .from("electricity_meters")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (after.error) throw after.error;
      await logAuditForCurrentSession({
        action: "electricity_meter.update",
        entityType: "electricity_meter",
        entityId: id,
        before: before.data,
        after: after.data,
      });
      return after.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["electricity-meters"] }),
  });
}

export function useDeleteElectricityMeter() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (meter: ElectricityMeter) => {
      if (!permissions.isAdmin || !permissions.can(PERMISSIONS.ELECTRICITY_DELETE)) {
        throw new Error("Permission denied.");
      }
      const response = await supabase.from("electricity_meters").delete().eq("id", meter.id);
      if (response.error) throw response.error;
      await logAuditForCurrentSession({
        action: "electricity_meter.delete",
        entityType: "electricity_meter",
        entityId: meter.id,
        before: meter,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["electricity-meters"] });
      queryClient.invalidateQueries({ queryKey: ["meter-readings"] });
      queryClient.invalidateQueries({ queryKey: ["electricity-charges"] });
    },
  });
}
