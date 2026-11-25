import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";

export type Concession = Tables<"concessions">;

/** صف `contract_units` مع الوحدة وعقارها. */
export interface ContractUnitDetail {
  unit: Tables<"units">;
  property: Tables<"properties"> | null;
  monthlyAmount: number;
}

/**
 * وحدات عقد واحد، بترتيب `line_order`، مع عقار كل وحدة.
 */
/**
 * المصروفات الشهرية الإضافية المسجّلة على العقد، بترتيب العرض.
 *
 * Read on edit so the form opens showing what the contract already bills.
 * Without it, saving an edited contract would submit an empty `extra_charges`
 * array — which `save_contract_with_units` reads as "the caller says there are
 * none" and deletes them all, quietly cutting every future invoice.
 */
export function useContractExtraCharges(contractId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["contract-extra-charges", contractId],
    enabled: Boolean(contractId) && enabled,
    queryFn: async (): Promise<Array<{ category_id: string; amount: number }>> => {
      const { data, error } = await supabase
        .from("contract_extra_charges")
        .select("category_id, amount")
        .eq("contract_id", contractId!)
        .order("line_order");
      if (error) throw error;
      return data.map((row) => ({ category_id: row.category_id, amount: Number(row.amount) }));
    },
  });
}

export function useContractUnits(contractId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["contract-units", contractId],
    enabled: Boolean(contractId) && enabled,
    queryFn: async (): Promise<ContractUnitDetail[]> => {
      const contractUnitResult = await supabase
        .from("contract_units")
        .select("unit_id, monthly_amount, line_order")
        .eq("contract_id", contractId!)
        .order("line_order");
      if (contractUnitResult.error) throw contractUnitResult.error;
      const unitIds = [...new Set(contractUnitResult.data.map((row) => row.unit_id))];
      const unitResult = unitIds.length
        ? await supabase.from("units").select("*").in("id", unitIds)
        : { data: [] as Tables<"units">[], error: null };
      if (unitResult.error) throw unitResult.error;
      const propertyIds = [...new Set(unitResult.data.map((unit) => unit.property_id))];
      const propertyResult = propertyIds.length
        ? await supabase.from("properties").select("*").in("id", propertyIds)
        : { data: [] as Tables<"properties">[], error: null };
      if (propertyResult.error) throw propertyResult.error;
      const unitById = new Map(unitResult.data.map((unit) => [unit.id, unit]));
      const propertyById = new Map(propertyResult.data.map((property) => [property.id, property]));
      return contractUnitResult.data.flatMap((row): ContractUnitDetail[] => {
        const unit = unitById.get(row.unit_id);
        if (!unit) return [];
        return [
          {
            unit,
            property: propertyById.get(unit.property_id) ?? null,
            monthlyAmount: row.monthly_amount,
          },
        ];
      });
    },
  });
}

/**
 * إعفاءات عقد واحد مرتّبة بتاريخ البداية.
 */
export function useConcessions(contractId: string | null) {
  return useQuery({
    queryKey: ["concessions", contractId],
    enabled: Boolean(contractId),
    queryFn: async (): Promise<Concession[]> => {
      const { data, error } = await supabase
        .from("concessions")
        .select("*")
        .eq("contract_id", contractId!)
        .order("start_date");
      if (error) throw error;
      return data;
    },
  });
}

/**
 * يضيف إعفاءً على العقد ويُبطل كاش الفواتير والخصومات.
 */
export function useCreateConcession() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (values: TablesInsert<"concessions">) => {
      if (!permissions.can(PERMISSIONS.CONTRACTS_UPDATE)) throw new Error("Permission denied.");
      const { data, error } = await supabase
        .from("concessions")
        .insert(values)
        .select("*")
        .single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "concession.create",
        entityType: "concession",
        entityId: data.id,
        after: { ...data },
      });
      return data;
    },
    onSuccess: (concession) => {
      queryClient.invalidateQueries({ queryKey: ["concessions", concession.contract_id] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["discountable-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["concession-invoice-coverage"] });
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["property-monthly-totals"] });
      void invalidatePortalViews(queryClient);
    },
  });
}

/**
 * يعدّل إعفاءً قائماً ويُبطل كاش الفواتير لذلك العقد.
 */
export function useUpdateConcession() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: TablesUpdate<"concessions"> }) => {
      if (!permissions.can(PERMISSIONS.CONTRACTS_UPDATE)) throw new Error("Permission denied.");
      const { data: before, error: beforeError } = await supabase
        .from("concessions")
        .select("*")
        .eq("id", id)
        .single();
      if (beforeError) throw beforeError;
      const { data: after, error } = await supabase
        .from("concessions")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "concession.update",
        entityType: "concession",
        entityId: id,
        before: { ...before },
        after: { ...after },
      });
      return after;
    },
    // The same five keys create and delete invalidate. `useContracts` derives
    // freeMonths / percentDiscount / fixedDiscount from the concession rows, and
    // ContractsTable renders all three — editing an amount or a date range while
    // invalidating only two keys left those columns showing the previous values.
    onSuccess: (concession) => {
      queryClient.invalidateQueries({ queryKey: ["concessions", concession.contract_id] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["discountable-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["concession-invoice-coverage"] });
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["property-monthly-totals"] });
      void invalidatePortalViews(queryClient);
    },
  });
}

/**
 * يحذف إعفاءً ويُبطل كاش الفواتير والخصومات المرتبطة به.
 */
export function useDeleteConcession() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (concession: Concession) => {
      if (!permissions.can(PERMISSIONS.CONTRACTS_UPDATE)) throw new Error("Permission denied.");
      const { error } = await supabase.from("concessions").delete().eq("id", concession.id);
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "concession.delete",
        entityType: "concession",
        entityId: concession.id,
        before: { ...concession },
      });
      return concession.contract_id;
    },
    onSuccess: (contractId) => {
      queryClient.invalidateQueries({ queryKey: ["concessions", contractId] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["discountable-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["concession-invoice-coverage"] });
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["property-monthly-totals"] });
      void invalidatePortalViews(queryClient);
    },
  });
}
