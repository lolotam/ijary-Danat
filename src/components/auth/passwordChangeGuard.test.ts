import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * حالة العميل الوهمي: جلسة المستخدم وعلم «يجب تغيير كلمة المرور».
 */
const guardState = {
  session: null as { user: { id: string } } | null,
  profile: null as { must_change_password: boolean } | null,
  profileError: null as { message: string } | null,
};

vi.mock("@tanstack/react-router", () => ({
  redirect: (options: unknown) => ({ redirectTo: options }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: guardState.session } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: guardState.profile,
            error: guardState.profileError,
          }),
        }),
      }),
    }),
  },
}));

import { requirePasswordChange } from "@/components/auth/passwordChangeGuard";

/** معرّف المستخدم المسجّل دخوله في الاختبار. */
const USER_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  guardState.session = { user: { id: USER_ID } };
  guardState.profile = { must_change_password: false };
  guardState.profileError = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the forced password change guard", () => {
  it.each(["/admin", "/portal"] as const)(
    "sends an account that must change its password to the change screen (%s)",
    async (destination) => {
      guardState.profile = { must_change_password: true };

      const thrown = await requirePasswordChange(destination).catch((error: unknown) => error);

      expect(thrown).toEqual({
        redirectTo: { to: "/reset-password", search: { change: "1", next: destination } },
      });
    },
  );

  it("lets an account whose password is already changed through", async () => {
    await expect(requirePasswordChange("/admin")).resolves.toBeUndefined();
  });

  it("says nothing to a visitor who is not signed in", async () => {
    guardState.session = null;

    await expect(requirePasswordChange("/admin")).resolves.toBeUndefined();
  });

  it("does not lock the product when the profile cannot be read", async () => {
    // A database that cannot answer must not sign every staff member out of
    // the product; the change is enforced again the moment it can.
    guardState.profile = null;
    guardState.profileError = { message: "boom" };

    await expect(requirePasswordChange("/admin")).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});
