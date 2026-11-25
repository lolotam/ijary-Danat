/**
 * أنواع العقود ودوالّها المساعدة الخالصة المشتركة بين القوائم والحفظ والاستعلامات.
 *
 * Split out of `useContracts.ts`, which re-exports everything here — import
 * from `@/hooks/useContracts`, not this file, so test mocks of that path keep
 * intercepting.
 */
import type { ArchiveMode } from "@/hooks/archiveMode";
import type { ContractUnitDetail } from "@/hooks/useContractRelations";
import type { ContractState, Tables } from "@/integrations/supabase/database.types";
import type { FixedDiscountColumn, PercentDiscountColumn } from "@/lib/concessionColumns";

export type Contract = Tables<"contracts">;

export interface ContractWithRelations extends Contract {
  tenant: Tables<"tenants"> | null;
  /** Every unit the contract holds, in `line_order`. Empty is a loading/error
   *  state, not a valid contract — `contract_units` always has at least one row. */
  units: ContractUnitDetail[];
  brandLogoUrl: string | null;
  concessionMonths: number;
  freeMonths: number;
  percentDiscount: PercentDiscountColumn | null;
  fixedDiscount: FixedDiscountColumn | null;
  /** هل للعقد فاتورة متأخرة لم تُسدَّد بعد. */
  hasOverdue: boolean;
}

/**
 * The contract's first unit by `line_order`.
 *
 * Every display that has room for only one unit reads this rather than
 * `units[0]` directly, so "which unit is primary" has one definition. Most of
 * today's contracts still hold exactly one, so this keeps their displays a
 * one-line change; a later task decides how multi-unit contracts render where
 * this isn't enough.
 */
export function primaryUnit(
  contract: Pick<ContractWithRelations, "units">,
): Tables<"units"> | null {
  return contract.units[0]?.unit ?? null;
}

/** The property of `primaryUnit` — see its docs for why "primary" means [0]. */
export function primaryProperty(
  contract: Pick<ContractWithRelations, "units">,
): Tables<"properties"> | null {
  return contract.units[0]?.property ?? null;
}

/**
 * Number of distinct calendar months covered by a contract's active
 * concessions, keyed by contract id. Overlapping free-month and discount
 * periods are unioned (not summed) so a month counts once even when several
 * concessions touch it — matching what a tenant actually experiences.
 */
export function concessionMonthsByContract(
  rows: Array<{ contract_id: string; start_date: string; end_date: string }>,
): Map<string, number> {
  const monthsByContract = new Map<string, Set<string>>();
  for (const row of rows) {
    const start = new Date(`${row.start_date}T00:00:00`);
    const end = new Date(`${row.end_date}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    const months = monthsByContract.get(row.contract_id) ?? new Set<string>();
    const startIndex = start.getFullYear() * 12 + start.getMonth();
    const endIndex = end.getFullYear() * 12 + end.getMonth();
    for (let index = startIndex; index <= endIndex; index += 1) {
      months.add(`${Math.floor(index / 12)}-${index % 12}`);
    }
    monthsByContract.set(row.contract_id, months);
  }
  return new Map([...monthsByContract].map(([id, months]) => [id, months.size]));
}
export interface ContractListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  state?: ContractState;
  /**
   * Restrict to one tenant, server-side.
   *
   * The tenant detail page used to ask for the newest 50 contracts in the whole
   * system and filter by `tenant_id` in the browser. That was invisible while
   * only the single newest active contract was read; now that every contract
   * becomes a tab, a tenant whose contracts fall outside that global window
   * would lose tabs with no error and no empty state. Raising `pageSize` moves
   * the cliff rather than removing it.
   */
  tenantId?: string;
  /**
   * Archive slice. Default `current` so every existing call site is unchanged.
   * Part of the query key — switching tabs must not serve a wrong-mode cache.
   */
  archiveMode?: ArchiveMode;
}
export const nonTerminalStates: ContractState[] = ["draft", "active", "frozen", "suspended"];

export function shouldNotifyContractEnded(
  previousState: ContractState,
  nextState: ContractState,
): boolean {
  return nonTerminalStates.includes(previousState) && !nonTerminalStates.includes(nextState);
}
