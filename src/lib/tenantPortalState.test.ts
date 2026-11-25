import { describe, expect, it } from "vitest";

import { tenantPortalState } from "./tenantPortalState";

describe("tenantPortalState", () => {
  /**
   * The gap this exists for: 54 tenants in production carry the flag and 29
   * have an account, so 25 rows promised a login that was never created.
   */
  it("marks a tenant whose portal flag has no account behind it", () => {
    expect(
      tenantPortalState({ portalEnabled: true, hasAccount: false, accountsUnknown: false }),
    ).toBe("no-account");
  });

  it("reports an invited tenant as enabled", () => {
    expect(
      tenantPortalState({ portalEnabled: true, hasAccount: true, accountsUnknown: false }),
    ).toBe("enabled");
  });

  it("reports a tenant without the flag as disabled", () => {
    expect(
      tenantPortalState({ portalEnabled: false, hasAccount: false, accountsUnknown: false }),
    ).toBe("disabled");
  });

  /**
   * `profiles` is behind `users.read`. A collector who cannot read it would
   * otherwise see every tenant flagged as uninvited — a claim about their own
   * permissions dressed up as a fact about the tenant.
   */
  it("does not accuse a tenant of having no account when accounts could not be read", () => {
    expect(
      tenantPortalState({ portalEnabled: true, hasAccount: false, accountsUnknown: true }),
    ).toBe("enabled");
  });

  it("still reports the flag as off when accounts could not be read", () => {
    expect(
      tenantPortalState({ portalEnabled: false, hasAccount: false, accountsUnknown: true }),
    ).toBe("disabled");
  });
});
