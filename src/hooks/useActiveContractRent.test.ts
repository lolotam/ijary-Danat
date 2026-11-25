import { describe, expect, test } from "vitest";

import { pickLatestContractRent, type ContractRentRow } from "./useActiveContractRent";

/** يبني صف عقد للاختبار بأقل الحقول التي يقرأها المُنتقي. */
function row(startDate: string, monthlyAmount: number | null, id = startDate): ContractRentRow {
  return { contract_id: id, monthly_amount: monthlyAmount, contracts: { start_date: startDate } };
}

describe("pickLatestContractRent", () => {
  test("no active contract means no rent to show", () => {
    expect(pickLatestContractRent([])).toBeNull();
  });

  test("a single active contract supplies its own line", () => {
    expect(pickLatestContractRent([row("2026-01-01", 500)])).toBe(500);
  });

  test("overlapping contracts resolve to the later start date", () => {
    // Overlaps exist in this data. Relying on row order would make the field's
    // value depend on what Postgres happened to return first.
    const rows = [row("2026-01-01", 500), row("2026-06-01", 750)];
    expect(pickLatestContractRent(rows)).toBe(750);
    expect(pickLatestContractRent([...rows].reverse())).toBe(750);
  });

  test("a contract line carrying no amount is not a rent", () => {
    expect(pickLatestContractRent([row("2026-01-01", null)])).toBeNull();
  });

  test("contracts starting on the same day resolve the same way in any order", () => {
    // Without a second sort key the comparator returns 0 here and the rent falls
    // back to whatever order the rows arrived in.
    const rows = [row("2026-03-01", 500, "c-a"), row("2026-03-01", 900, "c-b")];
    const forward = pickLatestContractRent(rows);
    const reversed = pickLatestContractRent([...rows].reverse());
    expect(forward).toBe(reversed);
    expect(forward).toBe(900);
  });
});
