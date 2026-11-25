import { describe, expect, test } from "vitest";

import { fillPlaceholders, regenerationToast } from "@/lib/regenerationToast";
import type { RegenerationSummary } from "@/fns/regenerateContractInvoices";

/** حصيلة مصالحة بكل العدادات صفراً، تُعدَّل حسب الحالة تحت الاختبار. */
function summary(overrides: Partial<RegenerationSummary> = {}): RegenerationSummary {
  return {
    updated: 0,
    inserted: 0,
    cancelled: 0,
    deleted: 0,
    skipped: 0,
    blocked: 0,
    ...overrides,
  };
}

describe("regenerationToast", () => {
  test("says nothing when nothing moved", () => {
    // A save that only changed the notes field reconciles zero invoices. A
    // toast reading "0 updated" there is noise, and noise is how the warning
    // below stops being read.
    expect(regenerationToast(summary({ skipped: 12 }))).toBeNull();
  });

  test("reports a plain reconciliation as a success", () => {
    expect(regenerationToast(summary({ updated: 12, inserted: 3 }))).toEqual({
      kind: "success",
      key: "contracts.regenerated",
      values: { updated: "12", inserted: "3" },
    });
  });

  test("a deletion alone still earns a toast", () => {
    // Invoices disappearing is the outcome an operator most needs told, and it
    // is the one that moves no other counter.
    expect(regenerationToast(summary({ deleted: 2 }))?.kind).toBe("success");
  });

  test("cancellations outrank the count and warn", () => {
    // "12 updated" on a save that also cancelled three invoices is the
    // reassuring half of what happened.
    const outcome = regenerationToast(summary({ updated: 12, cancelled: 3 }));
    expect(outcome).toEqual({
      kind: "warning",
      key: "contracts.regeneratedWithCancellations",
      values: { updated: "12", inserted: "0", cancelled: "3" },
    });
  });

  test("blocked invoices warn too", () => {
    expect(regenerationToast(summary({ updated: 1, blocked: 4 }))).toMatchObject({
      kind: "warning",
      key: "contracts.regeneratedWithBlocked",
    });
  });

  test("cancellations win when both cancelled and blocked are present", () => {
    // Only one toast is shown, so the ordering decides what the operator is
    // told. Cancelled invoices are gone; blocked ones are merely untouched.
    expect(regenerationToast(summary({ cancelled: 1, blocked: 1 }))?.key).toBe(
      "contracts.regeneratedWithCancellations",
    );
  });
});

describe("fillPlaceholders", () => {
  test("substitutes every named placeholder", () => {
    expect(
      fillPlaceholders("{updated} updated, {inserted} inserted", {
        updated: "12",
        inserted: "3",
      }),
    ).toBe("12 updated, 3 inserted");
  });

  test("substitutes a placeholder that appears twice", () => {
    // `.replace` without a global flag replaces only the first occurrence —
    // the exact bug this function exists to make impossible.
    expect(fillPlaceholders("{n} of {n}", { n: "4" })).toBe("4 of 4");
  });

  test("leaves a placeholder with no value in place rather than blanking it", () => {
    // A visible `{missing}` is a bug report; a silently empty string is a
    // sentence that reads fine and says the wrong thing.
    expect(fillPlaceholders("{updated} and {missing}", { updated: "1" })).toBe("1 and {missing}");
  });
});
