import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import { normalisePhoneForSave } from "./phoneConflicts.server";

describe("normalisePhoneForSave", () => {
  beforeEach(() => {
    mocks.rpc.mockReset().mockResolvedValue({ data: [], error: null });
  });

  it("treats a blank number as no number and does not query", async () => {
    await expect(normalisePhoneForSave("   ", null, null)).resolves.toBeNull();
    await expect(normalisePhoneForSave(undefined, null, null)).resolves.toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects a number too short for sign-in to resolve", async () => {
    // Login compares the last 8 digits. Anything shorter can never match, so
    // storing it would look saved and never work.
    await expect(normalisePhoneForSave("5123", null, null)).rejects.toThrow(/8 digits/);
  });

  it("searches on the last 8 digits regardless of the format typed, passing both exclusions", async () => {
    await normalisePhoneForSave("+965 5123 4567", "user-1", "tenant-1");
    expect(mocks.rpc).toHaveBeenCalledWith("find_phone_conflicts", {
      _digits: "51234567",
      _exclude_profile: "user-1",
      _exclude_tenant: "tenant-1",
    });
  });

  it("stores the number as typed once it clears", async () => {
    await expect(normalisePhoneForSave("  +965 5123 4567 ", null, null)).resolves.toBe(
      "+965 5123 4567",
    );
  });

  it("names the conflicting account when another profile already has the number", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ kind: "profile", id: "other", label: "Waleed" }],
      error: null,
    });
    await expect(normalisePhoneForSave("51234567", null, null)).rejects.toThrow(/Waleed/);
  });

  it("names the tenant when the number belongs to one with no portal account yet", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ kind: "tenant", id: "t1", label: "شركة الخليج" }],
      error: null,
    });
    await expect(normalisePhoneForSave("51234567", null, null)).rejects.toThrow(/شركة الخليج/);
  });

  it("allows a tenant's own mobile number when that tenant is the one being excluded", async () => {
    // The create-path case: creating tenant t1's own portal account and typing
    // t1's own mobile number. A tenant-only conflict row for t1 exists (it has
    // no profile yet), but the mock mirrors what find_phone_conflicts' SQL does
    // with _exclude_tenant — filters that row out when t1 is the tenant passed
    // — so this proves the guard is unblocked by the exclusion, not merely that
    // no conflict happens to be configured.
    mocks.rpc.mockImplementation(async (_fn: string, args: { _exclude_tenant: string | null }) => ({
      data:
        args._exclude_tenant === "t1" ? [] : [{ kind: "tenant", id: "t1", label: "Tenant One" }],
      error: null,
    }));
    await expect(normalisePhoneForSave("51234567", null, "t1")).resolves.toBe("51234567");
    expect(mocks.rpc).toHaveBeenCalledWith("find_phone_conflicts", {
      _digits: "51234567",
      _exclude_profile: null,
      _exclude_tenant: "t1",
    });
  });

  it("surfaces a lookup failure instead of saving unchecked", async () => {
    // Failing open here would let the collision through, which is the outcome
    // the check exists to prevent.
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "nope" } });
    await expect(normalisePhoneForSave("51234567", null, null)).rejects.toThrow(/nope/);
  });
});
