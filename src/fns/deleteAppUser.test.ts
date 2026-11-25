import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const serverFunction = Object.assign(
    (data: unknown) => serverFunction.handler({ data, context: serverFunction.context }),
    {
      context: null as unknown,
      handler: null as unknown as (input: { data: unknown; context: unknown }) => Promise<unknown>,
    },
  );
  return {
    serverFunction,
    from: vi.fn(),
    deleteUser: vi.fn(),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
});

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder = {
      handler: (handler: typeof mocks.serverFunction.handler) => {
        mocks.serverFunction.handler = handler;
        return mocks.serverFunction;
      },
    };
    return {
      middleware: () => ({ inputValidator: () => builder, validator: () => builder }),
    };
  },
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
    rpc: mocks.rpc,
    auth: { admin: { deleteUser: mocks.deleteUser } },
  },
}));

import { deleteAppUser } from "./deleteAppUser";

const TARGET = "11111111-1111-1111-1111-111111111111";
const ADMIN = "22222222-2222-2222-2222-222222222222";

/** `profiles` reads: the pre-delete snapshot, then the post-delete survivor check. */
function profilesReturning(rows: Array<Record<string, unknown> | null>) {
  let call = 0;
  const del = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
  mocks.from.mockReturnValue({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: rows[Math.min(call++, rows.length - 1)] }) }),
    }),
    delete: del,
  });
  return del;
}

function callDelete(userId: string, isAdmin = true) {
  const fn = deleteAppUser as unknown as typeof mocks.serverFunction;
  fn.context = {
    supabase: { rpc: vi.fn().mockResolvedValue({ data: isAdmin, error: null }) },
    userId: ADMIN,
  };
  return fn({ userId });
}

describe("deleteAppUser", () => {
  beforeEach(() => {
    mocks.from.mockReset();
    mocks.rpc.mockReset().mockResolvedValue({ data: null, error: null });
    mocks.deleteUser.mockReset().mockResolvedValue({ error: null });
  });

  it("returns an explicit deleted flag so the caller cannot mistake a guard for success", async () => {
    profilesReturning([{ username: "bob" }, null]);
    await expect(callDelete(TARGET)).resolves.toEqual({ deleted: true, userId: TARGET });
  });

  it("rejects a non-admin with an Error, not a Response", async () => {
    // A thrown Response is returned to the client rather than thrown, so the
    // caller's success toast fires on a rejected request. This is the bug.
    profilesReturning([null, null]);
    const error = await callDelete(TARGET, false).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(Response);
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });

  it("refuses self-deletion", async () => {
    profilesReturning([null, null]);
    await expect(callDelete(ADMIN)).rejects.toThrow(/your own account/i);
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });

  it("deletes a profile row that survived the auth cascade", async () => {
    // profiles.id cascades from auth.users, but a cascade that silently did not
    // fire leaves the row on screen — exactly the reported symptom.
    const del = profilesReturning([{ username: "bob" }, { id: TARGET }]);
    await expect(callDelete(TARGET)).resolves.toEqual({ deleted: true, userId: TARGET });
    expect(del).toHaveBeenCalled();
  });

  it("propagates a GoTrue failure instead of reporting success", async () => {
    profilesReturning([{ username: "bob" }, null]);
    mocks.deleteUser.mockResolvedValue({ error: { message: "boom" } });
    await expect(callDelete(TARGET)).rejects.toThrow("boom");
  });
});
