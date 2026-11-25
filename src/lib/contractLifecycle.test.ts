import { addDays, format } from "date-fns";
import { describe, expect, test } from "vitest";

import {
  DEFAULT_RESTORE_TARGET_STATE,
  ENDED_CONTRACT_STATES,
  endedStatesFilter,
  isContractEnded,
  isContractEndInPast,
  needsPastEndConfirmation,
  resolveUnitCode,
  RESTORE_TARGET_STATES,
  restoreTargetStatesFor,
} from "./contractLifecycle";

/** Calendar today as yyyy-MM-dd — same basis as the lifecycle helpers. */
function todayIso() {
  return format(new Date(), "yyyy-MM-dd");
}

describe("needsPastEndConfirmation", () => {
  test("past end date + state active → confirmation required", () => {
    expect(needsPastEndConfirmation("2000-01-01", "active")).toBe(true);
  });

  test("past end date + state expired → no confirmation", () => {
    expect(needsPastEndConfirmation("2000-01-01", "expired")).toBe(false);
  });

  test("end date === today + state active → no confirmation (still current)", () => {
    expect(needsPastEndConfirmation(todayIso(), "active")).toBe(false);
    expect(isContractEndInPast(todayIso())).toBe(false);
  });

  test("future end date + state active → no confirmation", () => {
    expect(needsPastEndConfirmation("2099-12-31", "active")).toBe(false);
  });

  test("null / empty end date → no confirmation", () => {
    expect(needsPastEndConfirmation(null, "active")).toBe(false);
    expect(needsPastEndConfirmation(undefined, "active")).toBe(false);
    expect(needsPastEndConfirmation("", "active")).toBe(false);
  });
});

describe("resolveUnitCode", () => {
  const units = [
    { id: "u-1", code: "A-101" },
    { id: "u-2", code: "  B-202  " },
    { id: "u-3", code: null },
    { id: "u-4", code: "" },
  ];

  test("returns the matched unit code", () => {
    expect(resolveUnitCode("u-1", units)).toBe("A-101");
  });

  test("trims whitespace on the code", () => {
    expect(resolveUnitCode("u-2", units)).toBe("B-202");
  });

  test("returns null when unit is missing or code is empty", () => {
    expect(resolveUnitCode("missing", units)).toBeNull();
    expect(resolveUnitCode("u-3", units)).toBeNull();
    expect(resolveUnitCode("u-4", units)).toBeNull();
    expect(resolveUnitCode("", units)).toBeNull();
    expect(resolveUnitCode(null, units)).toBeNull();
  });
});

/**
 * Review context: `close_out_contract` stamps `archived_at` only for the
 * `archive` outcome (migration 114), so `keep_terminated` and `freeze` leave it
 * NULL. The archive tabs split on `archived_at` alone and therefore kept four
 * closed-out contracts in "Current" in production, each still offering a
 * Close-out action the database then refuses.
 */
describe("isContractEnded", () => {
  test("treats an archived contract as ended whatever its state says", () => {
    expect(isContractEnded({ archived_at: "2026-01-01T00:00:00Z", state: "active" })).toBe(true);
  });

  test.each([
    ["terminated", "terminated"],
    ["expired", "expired"],
  ] as const)("treats a %s contract as ended even with no archived_at", (_scenario, state) => {
    expect(isContractEnded({ archived_at: null, state })).toBe(true);
  });

  test.each([
    ["active", "active"],
    ["draft", "draft"],
    ["frozen", "frozen"],
    ["suspended", "suspended"],
    // Superseded, not ended — and the summary RPC has never counted it as
    // ended either, so the two must keep agreeing.
    ["renewed", "renewed"],
  ] as const)("leaves a %s contract in the current set", (_scenario, state) => {
    expect(isContractEnded({ archived_at: null, state })).toBe(false);
  });

  test("does not call a contract ended when its state is missing", () => {
    expect(isContractEnded({ archived_at: null, state: null })).toBe(false);
  });
});

describe("endedStatesFilter", () => {
  /**
   * The exact PostgREST shape matters: `state.in.(expired,terminated)` is what
   * goes into the `or()` filter, and a stray space or quote silently matches
   * nothing rather than erroring.
   */
  test("renders the states as a PostgREST in-list", () => {
    expect(endedStatesFilter()).toBe("(expired,terminated)");
  });

  test("covers every state isContractEnded treats as ended", () => {
    for (const state of ENDED_CONTRACT_STATES) {
      expect(endedStatesFilter()).toContain(state);
      expect(isContractEnded({ archived_at: null, state })).toBe(true);
    }
  });
});

/**
 * Codex round 8 on PR #209. The restore dialog passed the contract's own state
 * back to `restore_contract`, which was harmless while "archived" meant
 * `archived_at is not null` and nothing else. Migration 211 made the state
 * decide too, so restoring a `terminated` contract to `terminated` cleared the
 * column and left it exactly where it was — under a success toast.
 */
describe("RESTORE_TARGET_STATES", () => {
  test("offers no state that would leave the contract in the Archived tab", () => {
    for (const state of RESTORE_TARGET_STATES) {
      expect(isContractEnded({ archived_at: null, state })).toBe(false);
    }
  });

  /**
   * Spelled out rather than re-derived with the same `filter` the constant
   * uses: an expectation built from the implementation moves with it and would
   * still pass if the list silently lost `frozen`. `draft` and `renewed` earn
   * their place — the first is where a lease restored before it ever ran
   * belongs, the second where one superseded by a renewal does.
   */
  test("offers exactly the five states a lease can come back to", () => {
    expect([...RESTORE_TARGET_STATES]).toEqual([
      "draft",
      "active",
      "frozen",
      "suspended",
      "renewed",
    ]);
  });

  /**
   * `restore_contract` (migration 142) rejects anything outside this list with
   * "Invalid p_target_state", so an option the dialog offers but the RPC
   * refuses would be a dead choice the operator only discovers on submit.
   */
  test("offers only states restore_contract accepts", () => {
    const accepted = ["draft", "active", "frozen", "suspended", "expired", "terminated", "renewed"];
    for (const state of RESTORE_TARGET_STATES) {
      expect(accepted).toContain(state);
    }
  });

  /**
   * Every automatic invoice path tests `c.state = 'active'` (migrations 05, 07
   * and 112). Defaulting to `active` would restart billing on a lease that was
   * closed out, which `restore_contract`'s own step 7 forbids in as many
   * words. Nothing here claims a restored contract can never be invoiced — an
   * admin explicitly generating for it still can.
   */
  test("defaults to a state that does not bill", () => {
    expect(RESTORE_TARGET_STATES).toContain(DEFAULT_RESTORE_TARGET_STATE);
    expect(DEFAULT_RESTORE_TARGET_STATE).not.toBe("active");
  });
});

/**
 * Codex round 5 on PR #210. `ContractFormDialog` refuses to save a past-ended
 * contract as `active` without an explicit confirmation; the restore dialog
 * reached `restore_contract` without passing through that form at all, and an
 * archived contract's end date is in the past almost by definition — so
 * "restore to active" quietly reclaimed the unit and re-entered the
 * `state = 'active'` invoice runs.
 */
describe("restoreTargetStatesFor", () => {
  const PAST = "2020-01-31";
  const FUTURE = format(addDays(new Date(), 30), "yyyy-MM-dd");

  test("withholds active once the term has already ended", () => {
    expect(restoreTargetStatesFor(PAST)).not.toContain("active");
  });

  test("keeps every other state available on a past-ended contract", () => {
    expect([...restoreTargetStatesFor(PAST)]).toEqual(["draft", "frozen", "suspended", "renewed"]);
  });

  test("offers active while the term still runs", () => {
    expect(restoreTargetStatesFor(FUTURE)).toContain("active");
  });

  // A contract with no end date on file has no past term to contradict.
  test("offers active when there is no end date at all", () => {
    expect(restoreTargetStatesFor(null)).toEqual(RESTORE_TARGET_STATES);
  });

  // The default must survive the filter, or the dialog opens on a state it
  // does not offer and confirmation is dead on arrival.
  test("keeps the default target available on a past-ended contract", () => {
    expect(restoreTargetStatesFor(PAST)).toContain(DEFAULT_RESTORE_TARGET_STATE);
  });
});
