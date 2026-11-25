import { describe, expect, it } from "vitest";

import { shouldSendTenantIds } from "./tenantAssignments";

describe("shouldSendTenantIds", () => {
  it("never sends when the loaded assignments are unknown", () => {
    // The regression fix round 2 exists for: `undefined` must mean "we don't
    // know yet", not "empty" — sending anything here risks overwriting real
    // links with a guess.
    expect(shouldSendTenantIds(["t1"], undefined)).toBe(false);
    expect(shouldSendTenantIds([], undefined)).toBe(false);
  });

  it("sends a user's first-ever assignment (the exact regression)", () => {
    // A managerial user with zero existing user_tenants rows is never a key
    // in useUserTenants' Map, so `assigned` legitimately resolves to `[]`
    // once the query has loaded. Picking a tenant for them must still be
    // recognized as a real change, not silently dropped.
    expect(shouldSendTenantIds(["t1"], [])).toBe(true);
  });

  it("sends when every assignment is being cleared", () => {
    expect(shouldSendTenantIds([], ["t1"])).toBe(true);
  });

  it("does not send on a reorder with no membership change", () => {
    expect(shouldSendTenantIds(["t2", "t1"], ["t1", "t2"])).toBe(false);
  });

  it("sends when membership differs even at the same length", () => {
    expect(shouldSendTenantIds(["t1", "t3"], ["t1", "t2"])).toBe(true);
  });
});
