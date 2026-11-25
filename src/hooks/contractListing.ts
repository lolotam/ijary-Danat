/**
 * قائمة العقود وتصديرها: جلب مدى الصفوف ثم تعليق العلاقات عليها.
 *
 * Split out of `useContracts.ts`, which re-exports everything here — import
 * from `@/hooks/useContracts`, not this file, so test mocks of that path keep
 * intercepting.
 */
import { useQuery } from "@tanstack/react-query";

import { DEFAULT_ARCHIVE_MODE } from "@/hooks/archiveMode";
import {
  type Contract,
  type ContractListParams,
  type ContractWithRelations,
  concessionMonthsByContract,
} from "@/hooks/contractHelpers";
import { fetchContractListRelations } from "@/hooks/listRelations";
import { pageRange } from "@/hooks/pagination";
import type { ContractUnitDetail } from "@/hooks/useContractRelations";
import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { supabase } from "@/integrations/supabase/client";
import { fetchExportRows } from "@/lib/pagedQuery";
import { endedStatesFilter } from "@/lib/contractLifecycle";
import { concessionColumnsByContract } from "@/lib/concessionColumns";

/**
 * يجلب مدى صفوف العقود المطابقة للمرشّحات — اللب المشترك بين القائمة والتصدير.
 *
 * Relations are attached by the caller, not here: the export attaches them once
 * across every page rather than once per page, so the chunked fan-out below
 * runs a single time no matter how many pages the export needed.
 */
async function fetchContractRange(
  params: Omit<ContractListParams, "page" | "pageSize">,
  from: number,
  to: number,
): Promise<{ rows: Contract[]; count: number }> {
  const { search = "", state, tenantId, archiveMode = DEFAULT_ARCHIVE_MODE } = params;
  let query = supabase
    .from("contracts")
    .select("*", { count: "exact" })
    // See the matching filter in useTenants: archiving stamps `archived_at`
    // on the tenant *and* their contract, and both must leave the normal
    // lists. Invoices, payments, allocations and receipts are untouched —
    // archived never means deleted.
    // `id` is the unique tiebreaker. `created_at` alone is not unique, and an
    // offset page boundary that falls between two rows sharing a timestamp can
    // return one of them twice and skip the other. A total order makes each
    // page boundary deterministic (Codex review, PR #218).
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to);
  // A contract is archived when it was archived OR when its state says it
  // ended. `close_out_contract` stamps `archived_at` only for the `archive`
  // outcome (migration 114), so splitting on that column alone left every
  // contract closed out as terminated sitting in Current — still offering
  // a Close-out action for a contract that was already closed. Mirrors
  // `public.contract_is_ended`, which the tab badge counts through.
  if (archiveMode === "current") {
    query = query.is("archived_at", null).not("state", "in", endedStatesFilter());
  } else if (archiveMode === "archived") {
    query = query.or(`archived_at.not.is.null,state.in.${endedStatesFilter()}`);
  }
  if (state) query = query.eq("state", state);
  if (tenantId) query = query.eq("tenant_id", tenantId);
  const term = normalizePostgrestSearch(search);
  if (term) query = query.ilike("code", `%${term}%`);

  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: data ?? [], count: count ?? 0 };
}

/**
 * يعلّق المستأجر والوحدات والعلامة والتنازلات والتأخّر على صفوف العقود.
 *
 * One request for every relation (`contract_list_relations`, migration 244)
 * instead of the six that used to run one after another. The ids travel in the
 * POST body, so the 414 that forced chunking a long `in()` filter cannot occur.
 */
async function attachContractRelations(contracts: Contract[]): Promise<ContractWithRelations[]> {
  if (!contracts.length) return [];

  const relations = await fetchContractListRelations(contracts.map((contract) => contract.id));
  const tenantById = new Map(relations.tenants.map((tenant) => [tenant.id, tenant]));
  const unitById = new Map(relations.units.map((unit) => [unit.id, unit]));
  const propertyById = new Map(relations.properties.map((property) => [property.id, property]));
  // Grouped in line_order (the RPC orders them), so `units[0]` is always the
  // contract's primary unit.
  const unitsByContract = new Map<string, ContractUnitDetail[]>();
  for (const row of relations.contractUnits) {
    const unit = unitById.get(row.unit_id);
    if (!unit) continue;
    const detail: ContractUnitDetail = {
      unit,
      property: propertyById.get(unit.property_id) ?? null,
      monthlyAmount: row.monthly_amount,
    };
    const forContract = unitsByContract.get(row.contract_id);
    if (forContract) forContract.push(detail);
    else unitsByContract.set(row.contract_id, [detail]);
  }
  // Active concessions only, mirroring the invoicing logic (migration 37).
  const monthsByContract = concessionMonthsByContract(relations.concessions);
  const columnsByContract = concessionColumnsByContract(relations.concessions);
  return contracts.map((contract) => {
    const columns = columnsByContract.get(contract.id);
    return {
      ...contract,
      tenant: tenantById.get(contract.tenant_id) ?? null,
      units: unitsByContract.get(contract.id) ?? [],
      brandLogoUrl: relations.brandByContract.get(contract.id)?.logoUrl ?? null,
      concessionMonths: monthsByContract.get(contract.id) ?? 0,
      freeMonths: columns?.freeMonths ?? 0,
      percentDiscount: columns?.percentDiscount ?? null,
      fixedDiscount: columns?.fixedDiscount ?? null,
      hasOverdue: relations.overdueContractIds.has(contract.id),
    };
  });
}

export function useContracts(params: ContractListParams = {}, enabled = true) {
  const {
    page = 1,
    pageSize = 10,
    search = "",
    state,
    tenantId,
    archiveMode = DEFAULT_ARCHIVE_MODE,
  } = params;
  return useQuery({
    // archiveMode is in the key so switching Current/Archived/All never serves
    // a cached list from the wrong mode.
    queryKey: ["contracts", { page, pageSize, search, state, tenantId, archiveMode }],
    enabled,
    queryFn: async () => {
      const { from, to } = pageRange(page, pageSize);
      const { rows, count } = await fetchContractRange(
        { search, state, tenantId, archiveMode },
        from,
        to,
      );
      return { items: await attachContractRelations(rows), count };
    },
  });
}

/**
 * بيانات تصدير العقود: كل الصفوف المطابقة صفحةً صفحة بدل أول 500 فقط.
 */
export async function fetchContractExport(
  params: Omit<ContractListParams, "page" | "pageSize">,
): Promise<{ items: ContractWithRelations[]; count: number; truncated: boolean }> {
  const { rows, count, truncated } = await fetchExportRows((from, to) =>
    fetchContractRange(params, from, to),
  );
  return { items: await attachContractRelations(rows), count, truncated };
}

/** استعلام تصدير العقود: كل الصفوف المطابقة، لا أول صفحة. */
export function useContractExport(
  params: Omit<ContractListParams, "page" | "pageSize"> = {},
  enabled = true,
) {
  const { search = "", state, tenantId, archiveMode = DEFAULT_ARCHIVE_MODE } = params;
  return useQuery({
    queryKey: ["contracts", "export", { search, state, tenantId, archiveMode }],
    enabled,
    queryFn: () => fetchContractExport({ search, state, tenantId, archiveMode }),
  });
}
