import type { ContractState } from "@/integrations/supabase/database.types";

export interface ContractStatusLike {
  state: ContractState;
  hasOverdue: boolean;
}

export interface ContractStateCount {
  state: ContractState;
  count: number;
}

export interface TenantLifecycleSummary {
  /** One entry per state the tenant actually holds, in a fixed display order. */
  states: ContractStateCount[];
  /** How many contracts carry at least one overdue invoice with a balance. */
  overdueCount: number;
}

/**
 * A fixed order so the badges do not reshuffle between rows.
 *
 * Sorting by count would make two tenants with the same states render them in
 * different positions, which is exactly the kind of instability that makes a
 * table hard to scan. `active` leads because it is what an operator looks for.
 */
const STATE_ORDER: ContractState[] = [
  "active",
  "draft",
  "frozen",
  "suspended",
  "renewed",
  "expired",
  "terminated",
];

/**
 * Collapses a tenant's contracts into "2 active, 1 expired, 2 overdue".
 *
 * Counts rather than one badge per contract: a tenant with three contracts
 * would otherwise render three identical `Active` chips, which is the same
 * value repeated rather than three facts.
 *
 * Overdue is counted independently of state, not as a state of its own — a
 * contract is `active` *and* in arrears, and collapsing the two would hide one
 * of them. It counts contracts, not invoices: one contract three months behind
 * is one thing to chase, not three.
 */
export function summarizeContractLifecycles(
  contracts: ContractStatusLike[],
): TenantLifecycleSummary {
  const countByState = new Map<ContractState, number>();
  for (const contract of contracts) {
    countByState.set(contract.state, (countByState.get(contract.state) ?? 0) + 1);
  }

  return {
    states: STATE_ORDER.filter((state) => countByState.has(state)).map((state) => ({
      state,
      count: countByState.get(state) ?? 0,
    })),
    overdueCount: contracts.filter((contract) => contract.hasOverdue).length,
  };
}
