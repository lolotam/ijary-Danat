/**
 * يُبقي العقود التي لا يرتبط بها أي سجل بعد، مع الإبقاء على عقد السجل قيد التعديل.
 *
 * Feeds the insurance picker so a contract that already holds insurance cannot
 * be picked twice. It is a convenience only: `unique (contract_id)` on
 * `insurance_payments` (migration 56) is the guard. The edited row's own
 * contract stays in the list, or the edit dialog would open on a blank value.
 */
export function contractsWithoutRecord<T extends { value: string }>(
  contracts: T[],
  takenContractIds: ReadonlySet<string>,
  keepContractId?: string | null,
): T[] {
  return contracts.filter(
    (entry) => !takenContractIds.has(entry.value) || entry.value === keepContractId,
  );
}
