import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { supabase } from "@/integrations/supabase/client";
import type {
  Tables,
  TablesInsert,
  TablesUpdate,
  UnitStatus,
  ElectricityMeterOwnership,
} from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { fetchExportRows } from "@/lib/pagedQuery";
import { PERMISSIONS } from "@/lib/permissions";

export type Unit = Tables<"units">;
export interface UnitWithOccupant extends Unit {
  occupant: Tables<"tenants"> | null;
}
export interface UnitListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  propertyId?: string;
  buildingId?: string;
  status?: UnitStatus;
  /** Free-text after migration 103. */
  type?: string;
  electricityMeterOwnership?: ElectricityMeterOwnership;
}

/**
 * يجلب مدى صفوف الوحدات المطابقة للمرشّحات — اللب المشترك بين القائمة والتصدير.
 */
async function fetchUnitRange(
  params: Omit<UnitListParams, "page" | "pageSize">,
  from: number,
  to: number,
): Promise<{ rows: Unit[]; count: number }> {
  const { search, propertyId, buildingId, status, type, electricityMeterOwnership } = params;
  let query = supabase
    .from("units")
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
  if (status) query = query.eq("status", status);
  if (type) query = query.eq("type", type);
  if (electricityMeterOwnership)
    query = query.eq("electricity_meter_ownership", electricityMeterOwnership);
  const term = normalizePostgrestSearch(search ?? "");
  if (term) {
    query = query.or(`code.ilike.%${term}%,name.ilike.%${term}%`);
  }
  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: data, count: count ?? 0 };
}

/** يجلب صفحة واحدة من الوحدات للقائمة — غلاف ترقيم فوق fetchUnitRange. */
async function fetchUnits(
  params: Required<Pick<UnitListParams, "page" | "pageSize" | "search">> &
    Omit<UnitListParams, "page" | "pageSize" | "search">,
): Promise<{ items: Unit[]; count: number }> {
  const { page, pageSize, ...filters } = params;
  const from = (page - 1) * pageSize;
  const { rows, count } = await fetchUnitRange(filters, from, from + pageSize - 1);
  return { items: rows, count };
}

export function useUnits(params: UnitListParams = {}, enabled = true) {
  const {
    page = 1,
    pageSize = 10,
    search = "",
    propertyId,
    buildingId,
    status,
    type,
    electricityMeterOwnership,
  } = params;
  return useQuery({
    queryKey: [
      "units",
      { page, pageSize, search, propertyId, buildingId, status, type, electricityMeterOwnership },
    ],
    enabled,
    queryFn: async () => {
      const { items: units, count } = await fetchUnits({
        page,
        pageSize,
        search,
        propertyId,
        buildingId,
        status,
        type,
        electricityMeterOwnership,
      });
      if (!units.length) return { items: [] as UnitWithOccupant[], count };
      // Units live on contract_units now (migration 110), not
      // contracts.unit_id (dropped in migration 118) — a unit's occupant is
      // whichever active, unarchived contract has a contract_units row naming
      // it.
      const { data: unitLinks, error: linkError } = await supabase
        .from("contract_units")
        .select("unit_id,contract_id")
        .in(
          "unit_id",
          units.map((unit) => unit.id),
        );
      if (linkError) throw linkError;
      const contractIds = [...new Set(unitLinks.map((link) => link.contract_id))];
      const { data: activeContracts, error: contractError } = contractIds.length
        ? await supabase
            .from("contracts")
            .select("id,tenant_id")
            .eq("state", "active")
            // Matches migration 76's occupancy predicate. Without it the occupant
            // column and the status column disagree the moment a contract is
            // archived — the unit would read `vacant` while still naming a tenant.
            .is("archived_at", null)
            .in("id", contractIds)
        : { data: [] as { id: string; tenant_id: string }[], error: null };
      if (contractError) throw contractError;
      const tenantIds = [...new Set(activeContracts.map((contract) => contract.tenant_id))];
      const tenantResult = tenantIds.length
        ? await supabase.from("tenants").select("*").in("id", tenantIds)
        : { data: [], error: null };
      if (tenantResult.error) throw tenantResult.error;
      const tenantById = new Map(tenantResult.data.map((tenant) => [tenant.id, tenant]));
      const tenantIdByContract = new Map(
        activeContracts.map((contract) => [contract.id, contract.tenant_id]),
      );
      const tenantIdByUnit = new Map(
        unitLinks.flatMap((link) => {
          const tenantId = tenantIdByContract.get(link.contract_id);
          return tenantId ? [[link.unit_id, tenantId] as const] : [];
        }),
      );
      return {
        items: units.map((unit) => ({
          ...unit,
          occupant: tenantById.get(tenantIdByUnit.get(unit.id) ?? "") ?? null,
        })),
        count,
      };
    },
  });
}

/**
 * بيانات تصدير الوحدات: كل الصفوف المطابقة صفحةً صفحة بدل أول 500 فقط.
 */
export async function fetchUnitExport(
  params: Omit<UnitListParams, "page" | "pageSize">,
): Promise<{ items: Unit[]; count: number; truncated: boolean }> {
  const { rows, count, truncated } = await fetchExportRows((from, to) =>
    fetchUnitRange(params, from, to),
  );
  return { items: rows, count, truncated };
}

export function useUnitExport(
  params: Omit<UnitListParams, "page" | "pageSize"> = {},
  enabled = true,
) {
  const { search = "", propertyId, buildingId, status, type, electricityMeterOwnership } = params;
  return useQuery({
    queryKey: [
      "units",
      "export",
      { search, propertyId, buildingId, status, type, electricityMeterOwnership },
    ],
    enabled,
    queryFn: () =>
      fetchUnitExport({ search, propertyId, buildingId, status, type, electricityMeterOwnership }),
  });
}

/**
 * يجلب وحدات القسائم المختارة فقط، بالأعمدة التي يحتاجها منشئ العقد.
 *
 * Not `useUnits`: that one pages (10 rows by default) and a capped fetch
 * silently drops the tail of the list. Ten plots hold ~160 units, so one
 * unpaged `in (...)` read is both complete and small. Roof rows are removed
 * by the caller through `selectableUnits`, so the rule lives in one place.
 * `status` feeds the occupancy badge in the picker only; it is not copied
 * onto the contract lines.
 */
export function useUnitsForProperties(propertyIds: string[]) {
  const ids = [...propertyIds].sort();
  return useQuery({
    queryKey: ["units", "for-properties", ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("units")
        .select("id,code,name,name_en,paci_no,floor,type,property_id,status")
        .in("property_id", ids)
        .order("code", { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

export function useUnit(id: string | null) {
  return useQuery({
    queryKey: ["unit", id],
    enabled: Boolean(id),
    queryFn: async (): Promise<Unit> => {
      const { data, error } = await supabase.from("units").select("*").eq("id", id!).single();
      if (error) throw error;
      return data;
    },
  });
}

export function useCreateUnit() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (values: TablesInsert<"units">) => {
      if (!permissions.can(PERMISSIONS.UNITS_CREATE)) throw new Error("Permission denied.");
      const { data, error } = await supabase.from("units").insert(values).select("*").single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "unit.create",
        entityType: "unit",
        entityId: data.id,
        after: { ...data },
      });
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["units"] }),
  });
}

/**
 * Strips `status` from a unit update when the unit is currently occupied.
 *
 * An occupied unit's status belongs to its active contract (migration 76), and
 * the database raises rather than silently accepting a contradicting write. Both
 * edit forms disable the field but still submit their whole shape, so the status
 * rides along on an unrelated rename and would turn it into a save failure —
 * and the value is only correct for as long as the contract it was loaded
 * against is still active.
 *
 * Applied here rather than in each form: `before` is already loaded for the
 * audit log, and a third caller would otherwise have to remember this on its
 * own. Same reasoning as putting the rule in a trigger rather than in each
 * contract write path.
 */
export function omitDerivedStatus(
  updates: TablesUpdate<"units">,
  currentStatus: UnitStatus,
): TablesUpdate<"units"> {
  if (currentStatus !== "occupied") return updates;
  const { status: _ignored, ...rest } = updates;
  return rest;
}

export function useUpdateUnit() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: TablesUpdate<"units"> }) => {
      if (!permissions.can(PERMISSIONS.UNITS_UPDATE)) throw new Error("Permission denied.");
      const { data: before, error: beforeError } = await supabase
        .from("units")
        .select("*")
        .eq("id", id)
        .single();
      if (beforeError) throw beforeError;
      const { data: after, error } = await supabase
        .from("units")
        .update(omitDerivedStatus(updates, before.status))
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "unit.update",
        entityType: "unit",
        entityId: id,
        before: { ...before },
        after: { ...after },
      });
      return after;
    },
    // Moving a unit between buildings moves its rent too, so the per-building
    // monthly totals on /admin/properties are stale the moment this succeeds.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["units"] });
      queryClient.invalidateQueries({ queryKey: ["property-monthly-totals"] });
    },
  });
}

export function useDeleteUnit() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!permissions.can(PERMISSIONS.UNITS_DELETE)) throw new Error("Permission denied.");
      // Units live on contract_units now (migration 110), not
      // contracts.unit_id (dropped in migration 118).
      const { count, error: referenceError } = await supabase
        .from("contract_units")
        .select("contract_id", { count: "exact", head: true })
        .eq("unit_id", id);
      if (referenceError) throw referenceError;
      if (count) throw new Error("This unit is referenced by a contract and cannot be deleted.");
      const { data: before, error: beforeError } = await supabase
        .from("units")
        .select("*")
        .eq("id", id)
        .single();
      if (beforeError) throw beforeError;
      const { error } = await supabase.from("units").delete().eq("id", id);
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "unit.delete",
        entityType: "unit",
        entityId: id,
        before: { ...before },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["units"] }),
  });
}
