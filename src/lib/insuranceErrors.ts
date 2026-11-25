/**
 * يحوّل رفض قاعدة البيانات لتأمين ثانٍ على نفس العقد إلى مفتاح ترجمة مفهوم.
 *
 * The picker hides insured contracts, but a pick made before that list loads,
 * or two admins saving at once, still reaches `unique (contract_id)` (migration
 * 56) and would show a raw Postgres string. Matched on the constraint name as
 * well as 23505 so another unique violation is never explained as this one.
 * Returns null otherwise, so the caller keeps its own fallback.
 */
export function insuranceErrorKey(
  error: { message?: string; code?: string } | null | undefined,
): string | null {
  const duplicateContract =
    error?.code === "23505" &&
    Boolean(error.message?.includes("insurance_payments_contract_id_key"));
  return duplicateContract ? "insurance.contractAlreadyInsured" : null;
}
