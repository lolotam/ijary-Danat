import { describe, expect, it } from "vitest";

import { contractsWithoutRecord } from "./contractsWithoutRecord";

const contracts = [{ value: "c1" }, { value: "c2" }, { value: "c3" }];

describe("contractsWithoutRecord", () => {
  it("drops contracts that already have a record", () => {
    const taken = new Set(["c1", "c3"]);
    expect(contractsWithoutRecord(contracts, taken)).toEqual([{ value: "c2" }]);
  });

  it("keeps the edited row's own contract selectable", () => {
    const taken = new Set(["c1", "c3"]);
    expect(contractsWithoutRecord(contracts, taken, "c3")).toEqual([
      { value: "c2" },
      { value: "c3" },
    ]);
  });
});
