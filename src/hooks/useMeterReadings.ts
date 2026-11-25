import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";

export type MeterReading = Tables<"meter_readings">;
type ReadingMeter = Pick<
  Tables<"electricity_meters">,
  "id" | "meter_number" | "ownership" | "unit_id"
>;
type ReadingUnit = Pick<Tables<"units">, "code" | "id" | "name">;
type ReadingActor = Pick<Tables<"profiles">, "display_name" | "email" | "id" | "username">;

export interface MeterReadingWithRelations extends MeterReading {
  actor: ReadingActor | null;
  meter: ReadingMeter | null;
  unit: ReadingUnit | null;
}

export interface MeterReadingListParams {
  meterId?: string;
  page?: number;
  pageSize?: number;
  periodMonth?: number;
  periodYear?: number;
  search?: string;
}

export type CreateMeterReadingInput = Omit<
  TablesInsert<"meter_readings">,
  "consumption_kwh" | "created_at" | "id" | "previous_reading" | "read_by"
>;

export type UpdateMeterReadingInput = Omit<
  TablesUpdate<"meter_readings">,
  "consumption_kwh" | "created_at" | "id" | "previous_reading" | "read_by"
>;

async function matchingReadingMeterIds(term: string) {
  const units = await supabase
    .from("units")
    .select("id")
    .or(`code.ilike.%${term}%,name.ilike.%${term}%`)
    .limit(100);
  if (units.error) throw units.error;
  const unitIds = units.data.map((unit) => unit.id);
  let query = supabase.from("electricity_meters").select("id").limit(100);
  const unitClause = unitIds.length ? `,unit_id.in.(${unitIds.join(",")})` : "";
  query = query.or(`meter_number.ilike.%${term}%${unitClause}`);
  const meters = await query;
  if (meters.error) throw meters.error;
  return meters.data.map((meter) => meter.id);
}

async function enrichMeterReadings(readings: MeterReading[]): Promise<MeterReadingWithRelations[]> {
  if (!readings.length) return [];
  const meterIds = [...new Set(readings.map((reading) => reading.meter_id))];
  const actorIds = [
    ...new Set(readings.flatMap((reading) => (reading.read_by ? [reading.read_by] : []))),
  ];
  const meters = await supabase
    .from("electricity_meters")
    .select("id,meter_number,ownership,unit_id")
    .in("id", meterIds);
  if (meters.error) throw meters.error;
  const unitIds = [...new Set(meters.data.map((meter) => meter.unit_id))];
  const units = await supabase.from("units").select("id,code,name").in("id", unitIds);
  const actors = actorIds.length
    ? await supabase.from("profiles").select("id,display_name,username,email").in("id", actorIds)
    : { data: [] as ReadingActor[], error: null };
  if (units.error) throw units.error;
  if (actors.error) throw actors.error;
  const meterMap = new Map(meters.data.map((meter) => [meter.id, meter]));
  const unitMap = new Map(units.data.map((unit) => [unit.id, unit]));
  const actorMap = new Map(actors.data.map((actor) => [actor.id, actor]));
  return readings.map((reading) => {
    const meter = meterMap.get(reading.meter_id) ?? null;
    return {
      ...reading,
      meter,
      unit: meter ? (unitMap.get(meter.unit_id) ?? null) : null,
      actor: reading.read_by ? (actorMap.get(reading.read_by) ?? null) : null,
    };
  });
}

async function fetchMeterReadings(params: MeterReadingListParams) {
  const { page = 1, pageSize = 10 } = params;
  const from = (page - 1) * pageSize;
  const term = normalizePostgrestSearch(params.search ?? "");
  const meterIds = term ? await matchingReadingMeterIds(term) : [];
  let query = supabase
    .from("meter_readings")
    .select("*", { count: "exact" })
    .order("period_year", { ascending: false })
    .order("period_month", { ascending: false })
    .range(from, from + pageSize - 1);
  if (params.meterId) query = query.eq("meter_id", params.meterId);
  if (params.periodYear) query = query.eq("period_year", params.periodYear);
  if (params.periodMonth) query = query.eq("period_month", params.periodMonth);
  if (term) {
    const meterClause = meterIds.length ? `,meter_id.in.(${meterIds.join(",")})` : "";
    query = query.or(`note.ilike.%${term}%${meterClause}`);
  }
  const response = await query;
  if (response.error) throw response.error;
  return { items: await enrichMeterReadings(response.data), count: response.count ?? 0 };
}

export function useMeterReadings(params: MeterReadingListParams = {}, enabled = true) {
  return useQuery({
    queryKey: ["meter-readings", params],
    enabled,
    queryFn: () => fetchMeterReadings(params),
  });
}

export function usePreviousMeterReading({
  meterId,
  periodMonth,
  periodYear,
  excludeId,
}: {
  meterId: string;
  periodMonth: number;
  periodYear: number;
  excludeId?: string;
}) {
  return useQuery({
    queryKey: ["meter-readings", "previous", meterId, periodYear, periodMonth, excludeId],
    enabled: Boolean(meterId && periodMonth && periodYear),
    queryFn: async () => {
      let query = supabase
        .from("meter_readings")
        .select("*")
        .eq("meter_id", meterId)
        .or(
          `period_year.lt.${periodYear},and(period_year.eq.${periodYear},period_month.lt.${periodMonth})`,
        )
        .order("period_year", { ascending: false })
        .order("period_month", { ascending: false })
        .limit(1);
      if (excludeId) query = query.neq("id", excludeId);
      const response = await query.maybeSingle();
      if (response.error) throw response.error;
      return response.data;
    },
  });
}

export function useCreateMeterReading() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (reading: CreateMeterReadingInput) => {
      if (!permissions.can(PERMISSIONS.ELECTRICITY_CREATE)) {
        throw new Error("Permission denied.");
      }
      const currentUser = await supabase.auth.getUser();
      if (currentUser.error) throw currentUser.error;
      const response = await supabase
        .from("meter_readings")
        .insert({ ...reading, read_by: currentUser.data.user.id })
        .select("*")
        .single();
      if (response.error) throw response.error;
      await logAuditForCurrentSession({
        action: "meter_reading.create",
        entityType: "meter_reading",
        entityId: response.data.id,
        after: response.data,
      });
      return response.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["meter-readings"] }),
  });
}

export function useUpdateMeterReading() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: UpdateMeterReadingInput }) => {
      if (!permissions.can(PERMISSIONS.ELECTRICITY_UPDATE)) {
        throw new Error("Permission denied.");
      }
      const before = await supabase.from("meter_readings").select("*").eq("id", id).single();
      if (before.error) throw before.error;
      const after = await supabase
        .from("meter_readings")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (after.error) throw after.error;
      await logAuditForCurrentSession({
        action: "meter_reading.update",
        entityType: "meter_reading",
        entityId: id,
        before: before.data,
        after: after.data,
      });
      return after.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meter-readings"] });
      queryClient.invalidateQueries({ queryKey: ["electricity-charges"] });
    },
  });
}

export function useDeleteMeterReading() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (reading: MeterReading) => {
      if (!permissions.can(PERMISSIONS.ELECTRICITY_DELETE)) {
        throw new Error("Permission denied.");
      }
      const response = await supabase.from("meter_readings").delete().eq("id", reading.id);
      if (response.error) throw response.error;
      await logAuditForCurrentSession({
        action: "meter_reading.delete",
        entityType: "meter_reading",
        entityId: reading.id,
        before: reading,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meter-readings"] });
      queryClient.invalidateQueries({ queryKey: ["electricity-charges"] });
    },
  });
}
