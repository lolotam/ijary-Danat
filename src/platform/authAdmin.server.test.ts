import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createUser: vi.fn(),
  updateUserById: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        createUser: mocks.createUser,
        updateUserById: mocks.updateUserById,
        deleteUser: vi.fn(),
      },
    },
  },
}));

import { createAuthUser, updateAuthUserById } from "./authAdmin.server";
import { syntheticAuthEmail } from "@/auth/loginIdentity";

describe("createAuthUser", () => {
  beforeEach(() => {
    mocks.createUser.mockReset().mockResolvedValue({ data: { user: null }, error: null });
  });

  it("keys the login on the synthetic address of the id it generates, never on the real email", async () => {
    await createAuthUser({
      email: "person@example.test",
      password: "password-123",
      email_confirm: true,
    });

    const sent = mocks.createUser.mock.calls[0][0] as { id: string; email: string };
    expect(sent.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.email).toBe(syntheticAuthEmail(sent.id));
    // The real address must never reach GoTrue: it is unique per company, and
    // GoTrue would refuse the second company's account holding it.
    expect(sent.email).not.toBe("person@example.test");
  });

  it("keeps the password and metadata and forces the address as confirmed", async () => {
    await createAuthUser({
      email: "person@example.test",
      password: "password-123",
      user_metadata: { company_id: "11111111-1111-4111-8111-111111111111", username: "person" },
    });

    expect(mocks.createUser.mock.calls[0][0]).toMatchObject({
      password: "password-123",
      email_confirm: true,
      user_metadata: {
        company_id: "11111111-1111-4111-8111-111111111111",
        username: "person",
      },
    });
  });

  it("returns GoTrue's own result to the caller", async () => {
    mocks.createUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } }, error: null });

    await expect(createAuthUser({ email: "a@b.test", password: "password-123" })).resolves.toEqual({
      data: { user: { id: "user-1" } },
      error: null,
    });
  });
});

describe("updateAuthUserById", () => {
  beforeEach(() => {
    mocks.updateUserById.mockReset().mockResolvedValue({ data: {}, error: null });
  });

  it.each([
    ["a real address", { email: "person@example.test" }],
    ["the legacy @users.local mapping", { email: "person@users.local" }],
  ])("replaces %s with the account's synthetic address", async (_label, attributes) => {
    await updateAuthUserById("a0000000-0000-4000-8000-000000000001", attributes);

    expect(mocks.updateUserById).toHaveBeenCalledWith(
      "a0000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        email: "a0000000-0000-4000-8000-000000000001@auth.ijary.invalid",
        email_confirm: true,
      }),
    );
  });

  it("normalises the address even on a write that only touches the ban flag", async () => {
    await updateAuthUserById("a0000000-0000-4000-8000-000000000001", { ban_duration: "none" });

    expect(mocks.updateUserById).toHaveBeenCalledWith(
      "a0000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        ban_duration: "none",
        email: syntheticAuthEmail("a0000000-0000-4000-8000-000000000001"),
      }),
    );
  });

  it("passes the requested update through unchanged apart from the address", async () => {
    await updateAuthUserById("a0000000-0000-4000-8000-000000000001", {
      password: "new-password-123",
      user_metadata: { username: "renamed" },
    });

    expect(mocks.updateUserById).toHaveBeenCalledWith(
      "a0000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        password: "new-password-123",
        user_metadata: { username: "renamed" },
      }),
    );
  });
});
