import { describe, expect, test } from "vitest";

import {
  invoicesNeedingWaiverPrompt,
  type WaiverCandidate,
  type WaiverConcession,
} from "@/lib/extraChargeWaiver";

/** فاتورة 500 إيجار + 50 مصروف، ما لم يُقل غير ذلك. */
function invoice(overrides: Partial<WaiverCandidate> = {}): WaiverCandidate {
  return { id: "inv-1", subtotal: 550, extraCharges: 50, ...overrides };
}

const FULL_PERCENT: WaiverConcession = { type: "percentage_discount", percent: 100 };

/**
 * Which months the operator is asked about. Getting this wrong in either
 * direction is a real cost: a month wrongly offered invites waiving a charge
 * that was never fully discounted, and a month wrongly withheld silently bills
 * a charge on a month the operator believes they made free.
 */
describe("invoicesNeedingWaiverPrompt", () => {
  // 99 is deliberately close to 100: it leaves 5 of the rent standing, so the
  // month is not free by any reading and its charges are not up for discussion.
  test.each([
    [100, 1],
    [99, 0],
  ])("a %i%% discount qualifies %i month(s)", (percent, expected) => {
    expect(
      invoicesNeedingWaiverPrompt([invoice()], { type: "percentage_discount", percent }),
    ).toHaveLength(expected);
  });

  test("a month with no service charges is never offered", () => {
    // Nothing to waive. Offering it would put a checkbox on screen that cannot
    // change the invoice by a single fils.
    expect(invoicesNeedingWaiverPrompt([invoice({ extraCharges: 0 })], FULL_PERCENT)).toEqual([]);
  });

  test("an extras-only invoice is not offered either", () => {
    // subtotal === extraCharges, so there is no rent for the discount to
    // cover. `rent <= 0` rather than `rent === 0` because a corrupt row must
    // not slip through as trivially qualifying.
    expect(
      invoicesNeedingWaiverPrompt([invoice({ subtotal: 50, extraCharges: 50 })], FULL_PERCENT),
    ).toEqual([]);
  });

  test.each([
    ["exactly the rent", 500, 1],
    ["more than the rent", 800, 1],
    ["less than the rent", 499, 0],
  ])("a fixed discount of %s qualifies %i month(s)", (_label, amount, expected) => {
    // The cap at the rent (migration 171) is what makes 800 behave like 500
    // here: the extra 300 cannot reach the charges on its own, so the month is
    // fully covered and the operator is asked.
    expect(
      invoicesNeedingWaiverPrompt([invoice()], { type: "fixed_discount", amount }),
    ).toHaveLength(expected);
  });

  test("only the qualifying months of a mixed batch come back", () => {
    const rows = [
      invoice({ id: "with-charges" }),
      invoice({ id: "no-charges", subtotal: 500, extraCharges: 0 }),
      invoice({ id: "also-with-charges", subtotal: 300, extraCharges: 100 }),
    ];
    expect(invoicesNeedingWaiverPrompt(rows, FULL_PERCENT).map((row) => row.id)).toEqual([
      "with-charges",
      "also-with-charges",
    ]);
  });

  test("a rent computed with float dust still counts as fully covered", () => {
    // These exact numbers matter. 975.35 - 125.05 is 850.3000000000001 in
    // float64, and 100% of that is 850.3 — so the subtraction leaves 1.1e-13 of
    // "rent" standing and a strict `=== 0` withholds the month from the prompt.
    // Postgres, working in numeric(14,3), considers the same rent fully covered
    // and would accept the waiver, so without rounding to its three places the
    // screen and the RPC disagree about which months are free.
    //
    // Most pairs do NOT reproduce this — 1250.3 - 50.1 and 640.7 - 40.3 both
    // come out exact. Change these figures and the test silently stops testing
    // anything, which is what happened to the first version of it.
    const rows = [invoice({ subtotal: 975.35, extraCharges: 125.05 })];
    expect(
      invoicesNeedingWaiverPrompt(rows, { type: "percentage_discount", percent: 100 }),
    ).toHaveLength(1);
  });
});
