/** Errors migrations 152-153 raise by name, mapped to the key that explains them. */
const DEPOSIT_ERROR_KEYS: ReadonlyArray<[string, string]> = [
  ["deposit_invoice_contract_mismatch", "deposits.error.invoiceContractMismatch"],
  ["deposit_invoice_terminal_state", "deposits.error.invoiceTerminalState"],
  ["deposit_invoice_out_of_order", "deposits.error.invoiceOutOfOrder"],
  ["deposit_invoice_not_found", "deposits.error.invoiceNotFound"],
  ["payment_owned_by_deposit", "deposits.error.paymentOwnedByDeposit"],
  ["payment_provenance_locked", "deposits.error.provenanceLocked"],
  ["deposits_currency_kwd", "deposits.error.currencyLocked"],
  ["deposits_contract_invoice_paired", "deposits.error.linkPaired"],
];

/**
 * يحوّل خطأ قاعدة البيانات عند حفظ إيداع إلى رسالة مفهومة.
 *
 * The settlement lives in a trigger, so a refusal arrives as a raw PostgREST
 * error carrying the condition name the migration raised — `raise exception
 * 'deposit_invoice_out_of_order'` reaches the browser as that literal string.
 * Shown unmapped it reads as a crash rather than as the rule it is.
 *
 * Anything unrecognised falls through to the original message rather than a
 * generic one: an unexpected database error is worth reading verbatim.
 */
export function depositSaveMessage(error: unknown, t: (key: string) => string): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : "";

  const match = DEPOSIT_ERROR_KEYS.find(([condition]) => message.includes(condition));
  if (match) return t(match[1]);
  return message || t("common.error");
}
