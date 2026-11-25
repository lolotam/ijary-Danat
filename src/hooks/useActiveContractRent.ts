import { useQuery } from "@tanstack/react-query";

import { FINANCE_QUERY_OPTIONS } from "@/hooks/financeQueryOptions";
import { supabase } from "@/integrations/supabase/client";
import { fetchInChunks } from "@/lib/idChunks";

/**
 * الإيجار الشهري لوحدة واحدة من عقدها النشط.
 *
 * Scoped to the one unit rather than filtered out of a page of contracts. The
 * first version asked `useContracts` for 500 rows and searched them, which put a
 * silent cap on correctness: a unit whose active contract fell outside that page
 * would have read as "no contract" and re-enabled a field that must stay locked.
 * A `contract_units` row keyed by `unit_id` has no such ceiling.
 *
 * Reads `contract_units.monthly_amount`, the per-unit line — never
 * `contracts.monthly_amount`, which a trigger maintains as the sum across every
 * unit the contract holds.
 */

/** صف `contract_units` مع معرّف عقده وتاريخ بدئه، بأقل شكل يلزم للاختيار. */
export interface ContractRentRow {
  contract_id: string;
  monthly_amount: number | null;
  /** Never null: the query joins `contracts!inner`, so an unmatched row cannot come back. */
  contracts: { start_date: string };
}

/**
 * يختار إيجار أحدث عقد نشط حين تتداخل عقود على نفس الوحدة.
 *
 * Overlapping active contracts on one unit have existed in this data, so the
 * later `start_date` wins deterministically — a rent that changed between two
 * renders of the same unit would be worse than one defensible answer.
 *
 * `contract_id` breaks a same-day tie for the same reason. Two contracts
 * starting on one date is unlikely but entirely possible, and without a second
 * key the comparator returns 0 there and the answer falls back to whatever order
 * Postgres returned — which is exactly the non-determinism this sort exists to
 * remove.
 */
export function pickLatestContractRent(rows: readonly ContractRentRow[]): number | null {
  if (rows.length === 0) return null;
  const latest = [...rows].sort((a, b) => {
    const byStart = b.contracts.start_date.localeCompare(a.contracts.start_date);
    return byStart !== 0 ? byStart : b.contract_id.localeCompare(a.contract_id);
  })[0];
  return latest.monthly_amount ?? null;
}

/**
 * يجلب إيجار الوحدة من عقدها النشط، ويعيد null إن لم يكن لها عقد نشط.
 *
 * `enabled` carries the caller's permission check, so a role that may not read
 * contracts never issues the request rather than issuing one that RLS empties.
 */
export function useActiveContractRent(unitId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["active-contract-rent", unitId],
    enabled: Boolean(unitId) && enabled,
    ...FINANCE_QUERY_OPTIONS,
    queryFn: async (): Promise<number | null> => {
      const { data, error } = await supabase
        .from("contract_units")
        .select("contract_id, monthly_amount, contracts!inner(state, start_date, archived_at)")
        .eq("unit_id", unitId!)
        .eq("contracts.state", "active")
        .is("contracts.archived_at", null);
      if (error) throw error;

      return pickLatestContractRent((data ?? []) as unknown as ContractRentRow[]);
    },
  });
}

/**
 * إيجارات مجموعة وحدات من عقودها النشطة، في استعلام واحد.
 *
 * The units table renders a page of rows and each needs its contracted rent.
 * One query per row would be a request per unit on every page change, so the
 * visible ids are asked for together and grouped client-side. Same source and
 * same tie-break as the single-unit hook — they share `pickLatestContractRent`
 * precisely so the table and the edit dialog can never disagree about what a
 * unit rents for.
 */
export function useActiveContractRents(unitIds: readonly string[], enabled = true) {
  // Sorted so two renders of the same page produce the same key rather than
  // refetching because the array arrived in a different order.
  const key = [...unitIds].sort().join(",");
  return useQuery({
    queryKey: ["active-contract-rents", key],
    enabled: unitIds.length > 0 && enabled,
    ...FINANCE_QUERY_OPTIONS,
    queryFn: async (): Promise<Map<string, number>> => {
      // Chunked because the ids travel in the URL — see `fetchInChunks` for why
      // a single 1000-id request would 414 and render every rent as an em dash.
      const rows = (await fetchInChunks(unitIds, (chunk) =>
        supabase
          .from("contract_units")
          .select(
            "unit_id, contract_id, monthly_amount, contracts!inner(state, start_date, archived_at)",
          )
          .in("unit_id", chunk)
          .eq("contracts.state", "active")
          .is("contracts.archived_at", null),
      )) as unknown as Array<ContractRentRow & { unit_id: string }>;

      const byUnit = new Map<string, ContractRentRow[]>();
      for (const row of rows) {
        const bucket = byUnit.get(row.unit_id);
        if (bucket) bucket.push(row);
        else byUnit.set(row.unit_id, [row]);
      }

      const rents = new Map<string, number>();
      for (const [unitId, rows] of byUnit) {
        const rent = pickLatestContractRent(rows);
        // A unit whose contract line carries no amount is left out rather than
        // stored as 0 — the table renders an em dash for both, but a 0 would be
        // a rent of zero to anything that later reads this map.
        if (rent != null) rents.set(unitId, rent);
      }
      return rents;
    },
  });
}
