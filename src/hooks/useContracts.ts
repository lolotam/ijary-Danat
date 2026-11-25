import { useQuery } from "@tanstack/react-query";

import { type Contract, nonTerminalStates } from "@/hooks/contractHelpers";
import { supabase } from "@/integrations/supabase/client";

// The public entry point for contract hooks. Every importer and every
// `vi.mock("@/hooks/useContracts")` goes through this path, so the split
// modules are re-exported here rather than imported directly by callers.
export type { ArchiveMode } from "@/hooks/archiveMode";
export type { Contract, ContractListParams, ContractWithRelations } from "@/hooks/contractHelpers";
export {
  concessionMonthsByContract,
  primaryProperty,
  primaryUnit,
  shouldNotifyContractEnded,
} from "@/hooks/contractHelpers";
export { fetchContractExport, useContractExport, useContracts } from "@/hooks/contractListing";
export type {
  ContractExtraChargeInput,
  ContractSaveInput,
  ContractUnitInput,
} from "@/hooks/useContractMutations";
export {
  useDeleteContract,
  useRefreshContractInvoices,
  useSaveContractWithUnits,
} from "@/hooks/useContractMutations";
export { useSyncContractInsurance } from "@/hooks/useContractInsurance";
export {
  useConcessions,
  useContractExtraCharges,
  useContractUnits,
  useCreateConcession,
  useDeleteConcession,
  useUpdateConcession,
} from "@/hooks/useContractRelations";
export type { Concession, ContractUnitDetail } from "@/hooks/useContractRelations";

export function useContract(id: string | null) {
  return useQuery({
    queryKey: ["contract", id],
    enabled: Boolean(id),
    queryFn: async (): Promise<Contract> => {
      const { data, error } = await supabase.from("contracts").select("*").eq("id", id!).single();
      if (error) throw error;
      return data;
    },
  });
}

/**
 * أبعد سنة ينتهي فيها أي عقد نشط غير مؤرشف — الحدّ الأعلى المعقول لتوليد
 * الفواتير مسبقًا.
 *
 * The invoice Generate action needs a target year, and the only defensible
 * default is "far enough to finish every active contract's schedule". Reading
 * it from `contracts.end_date` rather than from the invoice-year registry is
 * deliberate: the registry lists years an admin once typed in, which says
 * nothing about how long the portfolio actually runs. Archived contracts are
 * excluded to match migration 82 — they are billable by no path, so they must
 * not stretch the default either.
 *
 * Falls back to the current year when there is no active contract, which keeps
 * the selector non-empty rather than rendering a dropdown with no options.
 */
export function useMaxContractEndYear(enabled = true) {
  return useQuery({
    queryKey: ["max-contract-end-year"],
    enabled,
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase
        .from("contracts")
        .select("end_date")
        .eq("state", "active")
        .is("archived_at", null)
        .order("end_date", { ascending: false })
        .limit(1);
      if (error) throw error;
      const currentYear = new Date().getFullYear();
      const furthest = data[0]?.end_date;
      if (!furthest) return currentYear;
      // Slice the year out of the ISO date rather than going through `Date`.
      // PostgREST returns a `date` column as a bare "YYYY-MM-DD", which `Date`
      // parses as UTC midnight while `getFullYear()` reads it back in local
      // time — so an end date of 1 January reports the PREVIOUS year for any
      // viewer west of UTC, and the default target quietly comes up a year
      // short. The first four characters are the year, with no clock involved.
      return Math.max(currentYear, Number(furthest.slice(0, 4)));
    },
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * The unit's currently non-terminal contract (if any), joined through
 * `contract_units` rather than the deprecated `contracts.unit_id` — a unit can
 * only occupy one non-terminal contract even though a contract may hold
 * several units (the uniqueness constraint is per unit, not per contract).
 */
export function useUnitActiveContract(unitId: string | null, excludeContractId?: string) {
  return useQuery({
    queryKey: ["unit-active-contract", unitId, excludeContractId],
    enabled: Boolean(unitId),
    queryFn: async (): Promise<Contract | null> => {
      const contractId = await nonTerminalContractIdForUnit(unitId!, excludeContractId);
      if (!contractId) return null;
      const { data, error } = await supabase
        .from("contracts")
        .select("*")
        .eq("id", contractId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

/** Shared by `useUnitActiveContract` above. */
async function nonTerminalContractIdForUnit(
  unitId: string,
  excludeContractId?: string,
): Promise<string | null> {
  let linkQuery = supabase.from("contract_units").select("contract_id").eq("unit_id", unitId);
  if (excludeContractId) linkQuery = linkQuery.neq("contract_id", excludeContractId);
  const { data: links, error: linkError } = await linkQuery;
  if (linkError) throw linkError;
  const contractIds = [...new Set(links.map((link) => link.contract_id))];
  if (!contractIds.length) return null;
  const { data, error } = await supabase
    .from("contracts")
    .select("id")
    .in("id", contractIds)
    .in("state", nonTerminalStates)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/**
 * Non-terminal contract per unit, batched for the multi-unit contract form:
 * selecting N units costs one query pair, not N calls to
 * `useUnitActiveContract`.
 */
export function useUnitsActiveContracts(unitIds: string[], excludeContractId?: string) {
  return useQuery({
    queryKey: ["units-active-contracts", [...unitIds].sort(), excludeContractId],
    enabled: unitIds.length > 0,
    queryFn: async (): Promise<Map<string, Contract>> => {
      let linkQuery = supabase
        .from("contract_units")
        .select("unit_id, contract_id")
        .in("unit_id", unitIds);
      if (excludeContractId) linkQuery = linkQuery.neq("contract_id", excludeContractId);
      const { data: links, error: linkError } = await linkQuery;
      if (linkError) throw linkError;
      const contractIds = [...new Set(links.map((link) => link.contract_id))];
      if (!contractIds.length) return new Map();
      const { data: contracts, error } = await supabase
        .from("contracts")
        .select("*")
        .in("id", contractIds)
        .in("state", nonTerminalStates);
      if (error) throw error;
      const contractById = new Map(contracts.map((contract) => [contract.id, contract]));
      const byUnit = new Map<string, Contract>();
      for (const link of links) {
        const contract = contractById.get(link.contract_id);
        // First conflicting contract per unit is enough to name in the UI.
        if (contract && !byUnit.has(link.unit_id)) byUnit.set(link.unit_id, contract);
      }
      return byUnit;
    },
  });
}
