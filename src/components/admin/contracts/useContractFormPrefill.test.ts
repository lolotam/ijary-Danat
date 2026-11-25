import { describe, expect, test } from "vitest";

import { prefillDecision } from "@/components/admin/contracts/useContractFormPrefill";

/** حالة أساس: تعديل عقد بمصروفات محمّلة، لم يُملأ النموذج بعد. */
function state(overrides: Partial<Parameters<typeof prefillDecision>[0]> = {}) {
  return {
    open: true,
    isEditing: true,
    chargesLoaded: true,
    chargesFailed: false,
    prefilledFor: null,
    key: "contract-1",
    ...overrides,
  };
}

/**
 * `save_contract_with_units` reads an ABSENT `extra_charges` key as "leave them
 * alone" and an EMPTY array as "delete them all" (migration 166). Every case
 * below is about which of those two the form ends up sending, and each wrong
 * answer deletes a contract's recurring charges with nothing on screen to show
 * for it.
 */
describe("prefillDecision", () => {
  test("fills an edit once its charges have loaded", () => {
    expect(prefillDecision(state())).toEqual({ prefill: true, chargesAreKnown: true });
  });

  test("waits while the charges are still in flight", () => {
    // Filling now shows an empty list, and a save from there submits `[]`.
    expect(prefillDecision(state({ chargesLoaded: false }))).toEqual({
      prefill: false,
      chargesAreKnown: false,
    });
  });

  test("fills anyway once the charges query has failed, but says they are unknown", () => {
    // The dialog must still open — the operator may be here to change the end
    // date. It just must not claim to know what the contract charges.
    expect(prefillDecision(state({ chargesLoaded: false, chargesFailed: true }))).toEqual({
      prefill: true,
      chargesAreKnown: false,
    });
  });

  test("a retry that succeeds later does not re-fill, so the answer stays 'unknown'", () => {
    // The second bug, and the subtler one. After a failed read filled the form
    // with `[]`, the query retries and succeeds. Re-reading the query at SAVE
    // time would now say "known" and submit that empty array. Refusing to
    // re-fill is what keeps the captured answer authoritative.
    expect(prefillDecision(state({ prefilledFor: "contract-1" }))).toEqual({
      prefill: false,
      chargesAreKnown: true,
    });
  });

  test("re-fills when the dialog switches to a different contract", () => {
    expect(prefillDecision(state({ prefilledFor: "contract-other" })).prefill).toBe(true);
  });

  test("a new contract fills immediately and owns its charges", () => {
    // Nothing to load and nothing to lose: a contract that does not exist yet
    // has no charges the form could destroy.
    expect(
      prefillDecision(state({ isEditing: false, chargesLoaded: false, key: "__new__" })),
    ).toEqual({ prefill: true, chargesAreKnown: true });
  });

  test("decides nothing while the dialog is closed", () => {
    expect(prefillDecision(state({ open: false })).prefill).toBe(false);
  });
});
