import { describe, expect, it } from "vitest";

import { depositSaveMessage } from "@/lib/depositSaveMessage";

const t = (key: string) => key;

describe("depositSaveMessage", () => {
  // PostgREST surfaces `raise exception 'deposit_invoice_out_of_order'` as that
  // literal string inside a longer message, so matching has to be a substring
  // test rather than equality.
  it.each([
    ["deposit_invoice_contract_mismatch", "deposits.error.invoiceContractMismatch"],
    ["deposit_invoice_terminal_state", "deposits.error.invoiceTerminalState"],
    ["deposit_invoice_out_of_order", "deposits.error.invoiceOutOfOrder"],
    ["deposit_invoice_not_found", "deposits.error.invoiceNotFound"],
    ["payment_owned_by_deposit", "deposits.error.paymentOwnedByDeposit"],
    ["payment_provenance_locked", "deposits.error.provenanceLocked"],
    ["deposits_currency_kwd", "deposits.error.currencyLocked"],
    ["deposits_contract_invoice_paired", "deposits.error.linkPaired"],
  ])("maps %s to its explanation", (condition, key) => {
    const error = new Error(`new row violates ... ${condition} ... detail`);

    expect(depositSaveMessage(error, t)).toBe(key);
  });

  // An unexpected database error is worth reading verbatim — replacing it with
  // a generic "something went wrong" is how a real defect becomes invisible.
  it("passes an unrecognised message through untouched", () => {
    expect(depositSaveMessage(new Error("connection reset"), t)).toBe("connection reset");
  });

  it("reads the message off a plain PostgREST error object", () => {
    expect(depositSaveMessage({ message: "x deposit_invoice_not_found y" }, t)).toBe(
      "deposits.error.invoiceNotFound",
    );
  });

  it("falls back to the generic key when there is no message at all", () => {
    expect(depositSaveMessage(null, t)).toBe("common.error");
  });
});
