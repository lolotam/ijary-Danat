import { describe, expect, it } from "vitest";

import { portalLoginCandidates } from "./useContractedTenants";

const tenants = [{ id: "t1" }, { id: "t2" }, { id: "t3" }];

describe("portalLoginCandidates", () => {
  it("offers only contracted tenants that have no portal account yet", () => {
    const contracted = new Set(["t1", "t2"]);
    const linked = new Set(["t1"]);
    expect(portalLoginCandidates(tenants, contracted, linked)).toEqual([{ id: "t2" }]);
  });
});
