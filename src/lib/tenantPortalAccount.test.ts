import { describe, expect, it } from "vitest";

import { isTenantAccountConflict } from "./tenantPortalAccount";

describe("isTenantAccountConflict", () => {
  /**
   * Regression (migration 255): the one-account-per-renter index became
   * `profiles_company_tenant_id_unique`; matching its pre-rename name left the
   * raw constraint error instead of the friendly message.
   */
  it("recognises the one-account-per-renter refusal under its migration 255 name", () => {
    const error = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "profiles_company_tenant_id_unique"',
    };
    expect(isTenantAccountConflict(error)).toBe(true);
  });

  it("leaves other unique violations on profiles alone", () => {
    const error = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "profiles_username_key"',
    };
    expect(isTenantAccountConflict(error)).toBe(false);
  });
});
