import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const serverFunction = Object.assign(
    (input: { data: unknown }) =>
      serverFunction.handler({ data: input.data, context: serverFunction.context }),
    {
      context: null as unknown,
      handler: null as unknown as (input: { data: unknown; context: unknown }) => Promise<unknown>,
    },
  );
  return { serverFunction, updateUserById: vi.fn() };
});

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder = {
      handler: (handler: typeof mocks.serverFunction.handler) => {
        mocks.serverFunction.handler = handler;
        return mocks.serverFunction;
      },
    };
    return { middleware: () => ({ inputValidator: () => builder }) };
  },
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
}));

vi.mock("@/platform/authAdmin.server", () => ({
  updateAuthUserById: mocks.updateUserById,
}));

import { changeOwnPassword } from "./changeOwnPassword";

const USER = "11111111-1111-1111-1111-111111111111";

/**
 * يضبط سياق الطلب الذي يمرّره وسيط المصادقة إلى الدالة.
 */
function signedInAs(claims: Record<string, unknown>) {
  mocks.serverFunction.context = { userId: USER, claims };
}

describe("changeOwnPassword (T201 F1)", () => {
  beforeEach(() => {
    mocks.updateUserById.mockReset().mockResolvedValue({ data: {}, error: null });
  });

  it("changes the signed-in user's own password through the admin path", async () => {
    signedInAs({ sub: USER });

    await expect(changeOwnPassword({ data: { password: "new-password-1" } })).resolves.toEqual({
      ok: true,
    });
    expect(mocks.updateUserById).toHaveBeenCalledWith(USER, { password: "new-password-1" });
  });

  it("refuses a support session and changes nothing", async () => {
    signedInAs({ sub: USER, impersonator: "22222222-2222-2222-2222-222222222222" });

    await expect(changeOwnPassword({ data: { password: "new-password-1" } })).rejects.toThrow(
      "SUPPORT_SESSION_FORBIDDEN",
    );
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });

  it("surfaces a GoTrue refusal instead of reporting success", async () => {
    signedInAs({ sub: USER });
    mocks.updateUserById.mockResolvedValue({ data: null, error: { message: "weak password" } });

    await expect(changeOwnPassword({ data: { password: "new-password-1" } })).rejects.toThrow(
      "weak password",
    );
  });
});
