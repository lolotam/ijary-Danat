import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { fetchInChunks } from "@/lib/idChunks";
import { fetchExportRows } from "@/lib/pagedQuery";
import { PERMISSIONS } from "@/lib/permissions";

export type Property = Tables<"properties">;
export type PropertyInsert = TablesInsert<"properties">;
export type PropertyUpdate = TablesUpdate<"properties">;

export interface PropertyListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: Property["status"];
  type?: Property["type"];
}

export interface PropertyListItem extends Property {
  occupiedUnits: number;
  vacantUnits: number;
}

export interface PropertyListResult {
  items: PropertyListItem[];
  count: number;
}

interface OccupancyUnit {
  id: string;
  property_id: string;
}

interface OccupancyLink {
  unit_id: string;
  contract_id: string;
}

interface OccupancyContract {
  id: string;
  state: string;
}

/**
 * يحسب الوحدات المؤجّرة والشاغرة لكل عقار من العقود النشطة فقط.
 *
 * Occupancy is "named by a contract in state `active`", never `units.status`.
 * This codebase writes status columns that nothing reads; a card that
 * disagrees with the contracts table is worse than no card. A unit named by
 * two contracts counts once because the occupied set is keyed by unit id.
 */
export function aggregatePropertyOccupancy(
  units: OccupancyUnit[],
  links: OccupancyLink[],
  contracts: OccupancyContract[],
): Map<string, { occupiedUnits: number; vacantUnits: number }> {
  const occupying = new Set(
    contracts.filter((contract) => contract.state === "active").map((contract) => contract.id),
  );
  const occupiedUnitIds = new Set(
    links.filter((link) => occupying.has(link.contract_id)).map((link) => link.unit_id),
  );

  const byProperty = new Map<string, { occupiedUnits: number; vacantUnits: number }>();
  for (const unit of units) {
    const current = byProperty.get(unit.property_id) ?? { occupiedUnits: 0, vacantUnits: 0 };
    if (occupiedUnitIds.has(unit.id)) current.occupiedUnits += 1;
    else current.vacantUnits += 1;
    byProperty.set(unit.property_id, current);
  }
  return byProperty;
}

/**
 * يلحق بكل عقار عدد وحداته المؤجّرة والشاغرة من العقود النشطة.
 *
 * Three follow-up queries instead of a join: PostgREST cannot express
 * "distinct units named by an active contract" in one select, and the
 * properties page already paid for a units fetch — this replaces it. The units
 * lookup goes through `fetchInChunks` because the paged export can now feed
 * more property ids than one `in()` filter carries in a URL (PR #160's 8 KB
 * gateway limit); below one chunk the request is exactly what it always was.
 */
async function attachOccupancy(properties: Property[]): Promise<PropertyListItem[]> {
  if (!properties.length) return [];

  const unitRows = await fetchInChunks(
    properties.map((property) => property.id),
    (chunk) => supabase.from("units").select("id, property_id").in("property_id", chunk),
  );

  const unitIds = unitRows.map((unit) => unit.id);
  const linkRows = unitIds.length
    ? await fetchInChunks(unitIds, (chunk) =>
        supabase.from("contract_units").select("unit_id, contract_id").in("unit_id", chunk),
      )
    : [];

  const contractIds = [...new Set(linkRows.map((link) => link.contract_id))];
  const contracts = contractIds.length
    ? await fetchInChunks(contractIds, (chunk) =>
        supabase.from("contracts").select("id, state").in("id", chunk),
      )
    : [];

  const occupancy = aggregatePropertyOccupancy(unitRows, linkRows, contracts);
  return properties.map((property) => ({
    ...property,
    occupiedUnits: occupancy.get(property.id)?.occupiedUnits ?? 0,
    vacantUnits: occupancy.get(property.id)?.vacantUnits ?? 0,
  }));
}

/**
 * يجلب مدى صفوف العقارات المطابقة للمرشّحات — اللب المشترك بين القائمة والتصدير.
 *
 * Codes are PROP-001… (migration 189), so `order by code` is numeric order.
 * Sorting the paginated page client-side would only reorder ten rows.
 */
async function fetchPropertyRange(
  params: Omit<PropertyListParams, "page" | "pageSize">,
  from: number,
  to: number,
): Promise<{ rows: Property[]; count: number }> {
  const { search, status, type } = params;
  let query = supabase
    .from("properties")
    .select("*", { count: "exact" })
    // `id` is the unique tiebreaker. `code` alone is not unique, and an
    // offset page boundary that falls between two rows sharing a timestamp can
    // return one of them twice and skip the other. A total order makes each
    // page boundary deterministic (Codex review, PR #218).
    .order("code", { ascending: true })
    .order("id", { ascending: true })
    .range(from, to);
  if (status) query = query.eq("status", status);
  if (type) query = query.eq("type", type);
  const term = normalizePostgrestSearch(search ?? "");
  if (term) {
    query = query.or(`code.ilike.%${term}%,name_ar.ilike.%${term}%,name_en.ilike.%${term}%`);
  }
  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: data, count: count ?? 0 };
}

/** يجلب صفحة واحدة من العقارات للقائمة — غلاف ترقيم فوق fetchPropertyRange. */
export async function fetchProperties(
  params: Required<Pick<PropertyListParams, "page" | "pageSize" | "search">> &
    Pick<PropertyListParams, "status" | "type">,
): Promise<PropertyListResult> {
  const { page, pageSize, ...filters } = params;
  const from = (page - 1) * pageSize;
  const { rows, count } = await fetchPropertyRange(filters, from, from + pageSize - 1);
  return { items: await attachOccupancy(rows), count };
}

/**
 * يحوّل صفوف المستحق الشهري إلى خريطة: مبنى بلا صف بعد نجاح القراءة يُعامل كصفر.
 *
 * Number() accepts both numeric JSON values and numeric strings ("750.000")
 * at the RPC boundary. A missing
 * building is 0 only after a successful read — while loading the pill stays
 * off, and on error the card shows the error line instead.
 */
export function propertyMonthlyTotalsQuery(periodStart: string) {
  return async (): Promise<Map<string, number>> => {
    const { data, error } = await supabase.rpc("get_property_monthly_rent_totals", {
      p_period_start: periodStart,
    });
    if (error) throw error;
    const totals = new Map<string, number>();
    for (const row of data ?? []) {
      totals.set(row.property_id, Number(row.monthly_total));
    }
    return totals;
  };
}

/**
 * يقرأ المستحق تحصيله هذا الشهر لكل مبنى عبر RPC الفترة، لا عبر الإيجار الأساسي.
 *
 * Never calls `contract_unit_period_amounts` from the client; that RPC is
 * service_role-only. The period is in the query key so a month boundary does
 * not keep serving last month's map.
 */
export function usePropertyMonthlyTotals(periodStart: string, enabled = true) {
  return useQuery({
    queryKey: ["property-monthly-totals", periodStart],
    enabled,
    queryFn: propertyMonthlyTotalsQuery(periodStart),
  });
}

/**
 * بعد نجاح قراءة الإجماليات، مبنى غائب عن النتيجة يُعرض كصفر لا كغياب للحبة.
 *
 * Loading and error are a different UI (no pill / error line). Folding those
 * into 0 would make a broken read look like a vacant building.
 */
export function monthlyTotalForCard(
  totals: Map<string, number> | undefined,
  isSuccess: boolean,
  propertyId: string,
): number | undefined {
  if (!isSuccess || !totals) return undefined;
  return totals.get(propertyId) ?? 0;
}

export function useProperties(params: PropertyListParams = {}, enabled = true) {
  const { page = 1, pageSize = 10, search = "", status, type } = params;
  return useQuery({
    queryKey: ["properties", { page, pageSize, search, status, type }],
    enabled,
    queryFn: () => fetchProperties({ page, pageSize, search, status, type }),
  });
}

/**
 * بيانات تصدير العقارات: كل الصفوف المطابقة صفحةً صفحة، والإشغال يُحسب مرة بعد الجمع.
 */
export async function fetchPropertyExport(
  params: Omit<PropertyListParams, "page" | "pageSize">,
): Promise<{ items: PropertyListItem[]; count: number; truncated: boolean }> {
  const { rows, count, truncated } = await fetchExportRows((from, to) =>
    fetchPropertyRange(params, from, to),
  );
  return { items: await attachOccupancy(rows), count, truncated };
}

export function usePropertyExport(
  params: Omit<PropertyListParams, "page" | "pageSize"> = {},
  enabled = true,
) {
  const { search = "", status, type } = params;
  return useQuery({
    queryKey: ["properties", "export", { search, status, type }],
    enabled,
    queryFn: () => fetchPropertyExport({ search, status, type }),
  });
}

export function useProperty(id: string | null) {
  return useQuery({
    queryKey: ["property", id],
    enabled: Boolean(id),
    queryFn: async (): Promise<Property> => {
      const { data, error } = await supabase.from("properties").select("*").eq("id", id!).single();
      if (error) throw error;
      return data;
    },
  });
}

export function useCreateProperty() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (values: PropertyInsert) => {
      if (!permissions.can(PERMISSIONS.PROPERTIES_CREATE)) throw new Error("Permission denied.");
      const { data, error } = await supabase.from("properties").insert(values).select("*").single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "property.create",
        entityType: "property",
        entityId: data.id,
        after: { ...data },
      });
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["properties"] }),
  });
}

export function useUpdateProperty() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: PropertyUpdate }) => {
      if (!permissions.can(PERMISSIONS.PROPERTIES_UPDATE)) throw new Error("Permission denied.");
      const { data: before, error: beforeError } = await supabase
        .from("properties")
        .select("*")
        .eq("id", id)
        .single();
      if (beforeError) throw beforeError;
      const { data: after, error } = await supabase
        .from("properties")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "property.update",
        entityType: "property",
        entityId: id,
        before: { ...before },
        after: { ...after },
      });
      return after;
    },
    onSuccess: (property) => {
      queryClient.invalidateQueries({ queryKey: ["properties"] });
      queryClient.setQueryData(["property", property.id], property);
    },
  });
}

export function useDeleteProperty() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!permissions.can(PERMISSIONS.PROPERTIES_DELETE)) throw new Error("Permission denied.");
      const { data: before, error: beforeError } = await supabase
        .from("properties")
        .select("*")
        .eq("id", id)
        .single();
      if (beforeError) throw beforeError;
      const { error } = await supabase.from("properties").delete().eq("id", id);
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "property.delete",
        entityType: "property",
        entityId: id,
        before: { ...before },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["properties"] }),
  });
}
