import { describe, expect, it } from "vitest";

import { isTenantAccountConflict } from "./tenantPortalAccount";

describe("isTenantAccountConflict", () => {
  it("recognises migration 224's one-account-per-tenant refusal", () => {
    const error = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "profiles_tenant_id_unique"',
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
