import type { ContractState } from "@/integrations/supabase/database.types";

import { format } from "date-fns";

import { contractStates } from "@/lib/contractForm";

/** Calendar today as yyyy-MM-dd for comparing stored contract end dates. */
function todayIsoDate() {
  return format(new Date(), "yyyy-MM-dd");
}

/**
 * A contract whose end date is already in the past cannot be "active".
 * End date equal to today still counts as current (last day of the term).
 */
export function isContractEndInPast(endDate: string | null | undefined) {
  return Boolean(endDate && endDate < todayIsoDate());
}

/**
 * Saving past-end + active fires portal-deactivation and unit-vacant triggers.
 * Operators must accept that explicitly — never coerce silently.
 */
export function needsPastEndConfirmation(
  endDate: string | null | undefined,
  state: string | null | undefined,
) {
  return isContractEndInPast(endDate) && state === "active";
}

/** Resolve a unit code for confirm copy; null when unknown (generic phrasing). */
export function resolveUnitCode(
  unitId: string | null | undefined,
  units: ReadonlyArray<{ id: string; code: string | null }>,
): string | null {
  if (!unitId) return null;
  const code = units.find((unit) => unit.id === unitId)?.code?.trim();
  return code || null;
}

/**
 * الحالات التي تعني أن العقد انتهى: منتهي أو مفسوخ.
 *
 * Mirrors `public.contract_is_ended` (migration 211) and the `ended` KPI
 * `get_contracts_summary` has counted since migration 79. `expired` is here
 * even though nothing in this codebase transitions a contract to it — it is a
 * legal `contract_states` value a hand-run UPDATE or a future job can produce,
 * and the rule should not have to be revisited on the day one appears.
 *
 * `renewed` is deliberately absent: a renewed contract is superseded, not
 * ended, and the summary RPC has never counted it as ended either.
 */
export const ENDED_CONTRACT_STATES: readonly ContractState[] = ["expired", "terminated"];

/**
 * هل انتهى العقد فعليًا — بالأرشفة أو بحالته.
 *
 * `close_out_contract` stamps `archived_at` only for the `archive` outcome
 * (migration 114 says so in its own comment); the `keep_terminated` and
 * `freeze` outcomes change `state` and leave `archived_at` NULL. Splitting the
 * archive tabs on `archived_at` alone therefore left closed-out contracts in
 * "Current" — four of them in production — still offering a Close-out action
 * for a contract that was already closed. Both facts have to be read together.
 */
export function isContractEnded(contract: {
  archived_at?: string | null;
  state?: ContractState | string | null;
}): boolean {
  if (contract.archived_at) return true;
  return ENDED_CONTRACT_STATES.includes(contract.state as ContractState);
}

/**
 * قائمة الحالات المنتهية بصيغة مرشِّح PostgREST، مثل "(expired,terminated)".
 *
 * Built from the same constant, so a state added above reaches the queries
 * without a second edit in a file that could be missed.
 */
export function endedStatesFilter(): string {
  return `(${ENDED_CONTRACT_STATES.join(",")})`;
}

/**
 * الحالات التي يجوز إعادة العقد إليها عند الاستعادة — كل حالة غير منتهية.
 *
 * `restore_contract` (migration 142) accepts every `contract_states` value, and
 * the restore dialog used to pass the contract's own state straight back. That
 * was harmless while "archived" meant `archived_at is not null` and nothing
 * else: clearing the column moved the contract to Current whatever its state
 * said. Since migration 211 the state decides too, so restoring a contract that
 * was closed out as `terminated` *to* `terminated` cleared the column, left the
 * contract sitting in Archived, and reported success — a restore that restored
 * nothing. Codex round 8 on PR #209.
 *
 * Offering the operator a choice is the fix rather than picking one for them,
 * because the RPC has always taken this parameter; only the UI had decided it.
 */
export const RESTORE_TARGET_STATES: readonly ContractState[] = contractStates.filter(
  (state) => !ENDED_CONTRACT_STATES.includes(state),
);

/**
 * الحالة الافتراضية عند الاستعادة: معلّق.
 *
 * Every automatic invoice path tests `c.state = 'active'` (migrations 05, 07
 * and 112), so `suspended` returns the lease to the operational lists without
 * billing it — which is what `restore_contract`'s own step 7 says a restore is:
 * "DO NOT regenerate invoices. Restoring visibility is not reactivating the
 * lease." An admin explicitly running Generate for that one contract still
 * reaches it, through 112's `p_include_past and p_contract_id is not null`
 * branch; restore puts the lease back within reach, it does not invoice.
 *
 * `frozen` bills no differently but carries the `freeze` close-out outcome's
 * meaning, and `draft` would claim a signed lease was never signed. The
 * operator can still choose either — or `active`, which is the one offered
 * state that does resume automatic billing, and the dialog's copy says so
 * rather than leaving the operator to infer it from the default.
 */
export const DEFAULT_RESTORE_TARGET_STATE: ContractState = "suspended";

/**
 * الحالات المتاحة للاستعادة لعقد بعينه: تُحذف "نشط" إذا انقضى تاريخ نهايته.
 *
 * `needsPastEndConfirmation` above is the rule `ContractFormDialog` enforces
 * before saving — a contract whose term has already ended cannot quietly be
 * "active", because that reclaims its unit, moves the tenant's lifecycle, and
 * puts the lease back into the `state = 'active'` invoice runs. The restore
 * dialog reached `restore_contract` without passing through that form, so it
 * bypassed the rule entirely; an archived contract's end date is in the past
 * almost by definition. Codex round 5 on PR #210.
 *
 * Removed rather than confirmed: the edit form already implements the
 * confirmation properly, and it is where an operator who genuinely wants a
 * past-ended lease active should be doing it.
 */
export function restoreTargetStatesFor(
  endDate: string | null | undefined,
): readonly ContractState[] {
  if (!isContractEndInPast(endDate)) return RESTORE_TARGET_STATES;
  return RESTORE_TARGET_STATES.filter((state) => state !== "active");
}
