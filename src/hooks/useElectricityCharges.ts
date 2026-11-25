import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import type {
  ElectricityChargeStatus,
  ElectricityMeterOwnership,
  Tables,
} from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";

export type ElectricityCharge = Tables<"electricity_charges">;
type ChargeMeter = Pick<Tables<"electricity_meters">, "id" | "meter_number" | "ownership">;
type ChargeTenant = Pick<Tables<"tenants">, "code" | "id" | "name">;
type ChargeUnit = Pick<Tables<"units">, "code" | "id" | "name">;

export interface ElectricityChargeWithRelations extends ElectricityCharge {
  meter: ChargeMeter | null;
  tenant: ChargeTenant | null;
  unit: ChargeUnit | null;
}

export interface ElectricityChargeListParams {
  ownership?: ElectricityMeterOwnership;
  page?: number;
  pageSize?: number;
  periodMonth?: number;
  periodYear?: number;
  search?: string;
  status?: ElectricityChargeStatus;
  unitId?: string;
}

async function searchChargeRelations(term: string) {
  const [units, tenants, meters] = await Promise.all([
    supabase.from("units").select("id").or(`code.ilike.%${term}%,name.ilike.%${term}%`).limit(100),
    supabase
      .from("tenants")
      .select("id")
      .or(`code.ilike.%${term}%,name.ilike.%${term}%`)
      .limit(100),
    supabase.from("electricity_meters").select("id").ilike("meter_number", `%${term}%`).limit(100),
  ]);
  const firstError = [units.error, tenants.error, meters.error].find(Boolean);
  if (firstError) throw firstError;
  return {
    unitIds: (units.data ?? []).map((unit) => unit.id),
    tenantIds: (tenants.data ?? []).map((tenant) => tenant.id),
    meterIds: (meters.data ?? []).map((meter) => meter.id),
  };
}

async function meterIdsForOwnership(ownership: ElectricityMeterOwnership) {
  const response = await supabase
    .from("electricity_meters")
    .select("id")
    .eq("ownership", ownership)
    .limit(5000);
  if (response.error) throw response.error;
  return response.data.map((meter) => meter.id);
}

async function enrichElectricityCharges(
  charges: ElectricityCharge[],
): Promise<ElectricityChargeWithRelations[]> {
  if (!charges.length) return [];
  const unitIds = [...new Set(charges.map((charge) => charge.unit_id))];
  const tenantIds = [
    ...new Set(charges.flatMap((charge) => (charge.tenant_id ? [charge.tenant_id] : []))),
  ];
  const meterIds = [...new Set(charges.map((charge) => charge.meter_id))];
  const [units, tenants, meters] = await Promise.all([
    supabase.from("units").select("id,code,name").in("id", unitIds),
    tenantIds.length
      ? supabase.from("tenants").select("id,code,name").in("id", tenantIds)
      : Promise.resolve({ data: [] as ChargeTenant[], error: null }),
    supabase.from("electricity_meters").select("id,meter_number,ownership").in("id", meterIds),
  ]);
  const firstError = [units.error, tenants.error, meters.error].find(Boolean);
  if (firstError) throw firstError;
  const unitMap = new Map((units.data ?? []).map((unit) => [unit.id, unit]));
  const tenantMap = new Map((tenants.data ?? []).map((tenant) => [tenant.id, tenant]));
  const meterMap = new Map((meters.data ?? []).map((meter) => [meter.id, meter]));
  return charges.map((charge) => ({
    ...charge,
    unit: unitMap.get(charge.unit_id) ?? null,
    tenant: charge.tenant_id ? (tenantMap.get(charge.tenant_id) ?? null) : null,
    meter: meterMap.get(charge.meter_id) ?? null,
  }));
}

async function fetchElectricityCharges(params: ElectricityChargeListParams) {
  const { page = 1, pageSize = 10 } = params;
  const from = (page - 1) * pageSize;
  const term = normalizePostgrestSearch(params.search ?? "");
  const relationIds = term
    ? await searchChargeRelations(term)
    : { unitIds: [], tenantIds: [], meterIds: [] };
  const ownershipMeterIds = params.ownership ? await meterIdsForOwnership(params.ownership) : null;
  if (ownershipMeterIds && !ownershipMeterIds.length) {
    return { items: [] as ElectricityChargeWithRelations[], count: 0 };
  }

  let query = supabase
    .from("electricity_charges")
    .select("*", { count: "exact" })
    .order("period_year", { ascending: false })
    .order("period_month", { ascending: false })
    .range(from, from + pageSize - 1);
  if (params.periodYear) query = query.eq("period_year", params.periodYear);
  if (params.periodMonth) query = query.eq("period_month", params.periodMonth);
  if (params.unitId) query = query.eq("unit_id", params.unitId);
  if (params.status) query = query.eq("status", params.status);
  if (ownershipMeterIds) query = query.in("meter_id", ownershipMeterIds);
  if (term) {
    const clauses = [`code.ilike.%${term}%`, `notes.ilike.%${term}%`];
    if (relationIds.unitIds.length) clauses.push(`unit_id.in.(${relationIds.unitIds.join(",")})`);
    if (relationIds.tenantIds.length) {
      clauses.push(`tenant_id.in.(${relationIds.tenantIds.join(",")})`);
    }
    if (relationIds.meterIds.length) {
      clauses.push(`meter_id.in.(${relationIds.meterIds.join(",")})`);
    }
    query = query.or(clauses.join(","));
  }
  const response = await query;
  if (response.error) throw response.error;
  return { items: await enrichElectricityCharges(response.data), count: response.count ?? 0 };
}

export function useElectricityCharges(params: ElectricityChargeListParams = {}, enabled = true) {
  return useQuery({
    queryKey: ["electricity-charges", params],
    enabled,
    queryFn: () => fetchElectricityCharges(params),
  });
}

function statusTransitionAllowed(
  currentStatus: ElectricityChargeStatus,
  nextStatus: ElectricityChargeStatus,
) {
  if (currentStatus === "draft") return nextStatus === "issued" || nextStatus === "cancelled";
  if (currentStatus === "issued") return nextStatus === "paid" || nextStatus === "cancelled";
  return false;
}

export function useUpdateElectricityChargeStatus() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({
      charge,
      status,
    }: {
      charge: ElectricityCharge;
      status: ElectricityChargeStatus;
    }) => {
      if (!permissions.can(PERMISSIONS.ELECTRICITY_UPDATE)) {
        throw new Error("Permission denied.");
      }
      if (!statusTransitionAllowed(charge.status, status)) {
        throw new Error("Invalid electricity charge status transition.");
      }
      const response = await supabase
        .from("electricity_charges")
        .update({ status })
        .eq("id", charge.id)
        .eq("status", charge.status)
        .select("*")
        .single();
      if (response.error) throw response.error;
      await logAuditForCurrentSession({
        action: "electricity_charge.status.update",
        entityType: "electricity_charge",
        entityId: charge.id,
        before: charge,
        after: response.data,
      });
      return response.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["electricity-charges"] }),
  });
}
