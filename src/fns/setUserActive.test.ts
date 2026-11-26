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
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    updateUserById: vi.fn(),
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

vi.mock("@/platform/authAdmin.server", () => ({
  updateAuthUserById: mocks.updateUserById,
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: "11111111-1111-4111-8111-111111111111",
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
}));

import { setUserActive } from "./setUserActive";

const USER = "11111111-1111-1111-1111-111111111111";
const ADMIN = "22222222-2222-2222-2222-222222222222";

/**
 * يستبدل جدول profiles ومكتبة GoTrue الإدارية ببدائل رصدها مرتبة زمنيًا،
 * لأن ترتيب الكتابتين هو جوهر المهمة: الحظر قبل تعطيل الملف عند الإيقاف،
 * والملف قبل رفع الحظر عند إعادة التفعيل.
 *
 * `events` records the execution order ("ban" / "unban" / "profile") so the
 * ordering assertions fail on any reordering, not just on a missing call.
 */
function stubProfile(storedIsActive: boolean, opts: { failProfileUpdate?: boolean } = {}) {
  const events: string[] = [];
  const profileUpdates: Array<{ is_active: boolean }> = [];
  const banCalls: Array<{ ban_duration?: string | null }> = [];

  mocks.from.mockImplementation((table: string) => {
    if (table !== "profiles") return {};
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { is_active: storedIsActive }, error: null }),
        }),
      }),
      update: (payload: { is_active: boolean }) => {
        profileUpdates.push(payload);
        events.push("profile");
        return {
          eq: async () => ({
            error: opts.failProfileUpdate ? { message: "profile write failed" } : null,
          }),
        };
      },
    };
  });

  mocks.updateUserById.mockImplementation(
    async (_userId: string, attrs: { ban_duration?: string | null }) => {
      banCalls.push(attrs);
      events.push(attrs.ban_duration === "none" ? "unban" : "ban");
      return { data: {}, error: null };
    },
  );

  return { events, profileUpdates, banCalls };
}

/**
 * يستدعي دالة الخادم كمتصل يملك — أو لا يملك — صلاحية `users.update`.
 *
 * The permission RPC rides on `context.supabase` (the per-request client the
 * middleware injects), which is distinct from the mocked `supabaseAdmin.rpc`
 * that only `write_audit` goes through.
 */
function callSetActive(isActive: boolean, allowed = true) {
  const fn = setUserActive as unknown as typeof mocks.serverFunction;
  fn.context = {
    supabase: { rpc: vi.fn().mockResolvedValue({ data: allowed, error: null }) },
    userId: ADMIN,
  };
  return fn({ userId: USER, isActive }) as Promise<{ ok: boolean; error?: string }>;
}

/**
 * يُرجع وسيطة استدعاء `write_audit` الوحيد، أو null إن لم يُكتب سجل أصلًا.
 */
function auditArgs(): Record<string, unknown> | null {
  const call = mocks.rpc.mock.calls.find(([fn]) => fn === "write_audit");
  return call ? (call[1] as Record<string, unknown>) : null;
}

beforeEach(() => {
  mocks.from.mockReset();
  mocks.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  mocks.updateUserById.mockReset().mockResolvedValue({ data: {}, error: null });
});

describe("setUserActive authorisation", () => {
  it("refuses a caller without users.update and performs no write at all", async () => {
    // The browser update this function replaced was gated by the RLS policy
    // `profiles_update_own_or_admin` via has_permission(auth.uid(),
    // 'users.update'). The service role bypasses RLS, so this check is the
    // only thing standing between this function and "any signed-in user can
    // deactivate anyone".
    const { profileUpdates } = stubProfile(true);

    const result = await callSetActive(false, false);

    expect(result.ok).toBe(false);
    expect(profileUpdates).toHaveLength(0);
    expect(mocks.updateUserById).not.toHaveBeenCalled();
    expect(auditArgs()).toBeNull();
  });
});

describe("setUserActive refusal is recorded", () => {
  it("writes a permission.denied row through the caller's client and keeps the flag contract", async () => {
    // Before the shared gate this refusal left no trace in the audit trail.
    stubProfile(true);
    const userRpc = vi.fn().mockResolvedValueOnce({ data: false, error: null });
    userRpc.mockResolvedValue({ data: null, error: null });
    const fn = setUserActive as unknown as typeof mocks.serverFunction;
    fn.context = { supabase: { rpc: userRpc }, userId: ADMIN };

    const result = (await fn({ userId: USER, isActive: false })) as { ok: boolean; error?: string };

    expect(result).toEqual({
      ok: false,
      error: "You do not have permission to update user status.",
    });
    const denial = userRpc.mock.calls.find(([name]) => name === "write_audit");
    expect(denial?.[1]).toMatchObject({
      p_action: "permission.denied",
      p_error_code: "FORBIDDEN",
      p_entity_id: USER,
    });
  });
});

describe("setUserActive deactivation", () => {
  it("bans at the issuer before writing the profile", async () => {
    const { events, profileUpdates, banCalls } = stubProfile(true);

    const result = await callSetActive(false);

    expect(result).toEqual({ ok: true });
    expect(banCalls).toEqual([{ ban_duration: "876000h" }]);
    expect(profileUpdates).toEqual([{ is_active: false }]);
    // Ban first, profile second: a failure in between must land on "still
    // locked out", never "flag says deactivated but GoTrue still issues
    // tokens".
    expect(events).toEqual(["ban", "profile"]);
  });

  it("lifts the ban again when the profile write fails", async () => {
    const { events, banCalls } = stubProfile(true, { failProfileUpdate: true });

    const result = await callSetActive(false);

    expect(result.ok).toBe(false);
    expect(events).toEqual(["ban", "profile", "unban"]);
    expect(banCalls).toHaveLength(2);
    expect(banCalls[1]).toEqual({ ban_duration: "none" });
    expect(auditArgs()).toBeNull();
  });

  it("writes the audit row with the actual prior value, not the negation of the new one", async () => {
    // Stored false + deactivate again: the old browser code recorded
    // `before: { is_active: !isActive }`, which would claim the account was
    // active before this call. Server-side we can read the row, so the audit
    // must carry what was actually there.
    stubProfile(false);

    const result = await callSetActive(false);

    expect(result).toEqual({ ok: true });
    expect(mocks.rpc.mock.calls.filter(([fn]) => fn === "write_audit")).toHaveLength(1);
    expect(auditArgs()).toMatchObject({
      p_action: "user.status.update",
      p_entity_type: "user",
      p_entity_id: USER,
      p_before: { is_active: false },
      p_after: { is_active: false },
    });
  });

  it("reports a failed audit write without disowning the status change", async () => {
    // The profile and the ban are already written by the time the audit runs.
    // Returning ok:false here would be a lie the caller acts on — it would
    // refetch and see the change it was just told did not happen. The change
    // stands; what the operator needs to know is that the trail has a hole.
    const { profileUpdates } = stubProfile(true);
    mocks.rpc.mockImplementation((fn: string) =>
      fn === "write_audit"
        ? Promise.resolve({ data: null, error: { message: "audit table is full" } })
        : Promise.resolve({ data: null, error: null }),
    );

    const result = await callSetActive(false);

    expect(result).toEqual({ ok: true, auditError: "audit table is full" });
    expect(profileUpdates).toEqual([{ is_active: false }]);
  });
});

describe("setUserActive reactivation", () => {
  it("writes the profile before lifting the ban", async () => {
    const { events, profileUpdates, banCalls } = stubProfile(false);

    const result = await callSetActive(true);

    expect(result).toEqual({ ok: true });
    expect(profileUpdates).toEqual([{ is_active: true }]);
    expect(banCalls).toEqual([{ ban_duration: "none" }]);
    // Mirror image of the deactivation order, for the same reason: if the
    // second write fails, the account stays locked rather than quietly open.
    expect(events).toEqual(["profile", "unban"]);
    expect(auditArgs()).toMatchObject({
      p_before: { is_active: false },
      p_after: { is_active: true },
    });
  });
});
