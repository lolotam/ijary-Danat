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
    createClient: vi.fn(),
    from: vi.fn(),
    rpc: vi.fn(),
    signInWithPassword: vi.fn(),
    recordLoginAttempt: vi.fn(),
    recordFailedLoginAttempt: vi.fn(),
    serverFunction,
  };
});

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const serverFunctionBuilder = {
      handler: (handler: typeof mocks.serverFunction.handler) => {
        mocks.serverFunction.handler = handler;
        return mocks.serverFunction;
      },
    };
    return {
      middleware: () => ({
        inputValidator: () => serverFunctionBuilder,
        validator: () => serverFunctionBuilder,
      }),
      inputValidator: () => serverFunctionBuilder,
      validator: () => serverFunctionBuilder,
    };
  },
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
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

vi.mock("@/fns/loginAudit", () => ({
  recordLoginAttempt: mocks.recordLoginAttempt,
  recordFailedLoginAttempt: mocks.recordFailedLoginAttempt,
}));

import { signInWithIdentifier } from "./signInWithIdentifier";

// The mocked createServerFn returns a plain callable, so the exported symbol's
// fetcher type does not describe how it is driven here. Same cast as
// createAppUser.test.ts.
const signIn = signInWithIdentifier as unknown as typeof mocks.serverFunction;

/** صفوف profiles التي يعيدها المستعلم في كل اختبار. */
let profileRows: Array<{ id: string; email: string | null; is_active: boolean }>;

/**
 * وسائط آخر صف تدقيق كُتب لمحاولة الدخول، من أيٍّ من المسارين.
 *
 * Migration 215 routed the two attacker-reachable failures through
 * `recordFailedLoginAttempt`, which throttles before it writes and therefore
 * takes no `actorId`/`result` — those are implied by the RPC it calls. Reading
 * whichever writer fired last keeps these tests about the recorded outcome
 * rather than about which of the two functions produced it.
 */
function lastAuditInput() {
  const throttled = mocks.recordFailedLoginAttempt.mock.calls;
  if (throttled.length) {
    const input = throttled[throttled.length - 1][0] as {
      identifier: string;
      accountId: string | null;
      errorCode: string | null;
    };
    return { ...input, actorId: null, result: "failure" };
  }
  const calls = mocks.recordLoginAttempt.mock.calls;
  return calls[calls.length - 1][0] as {
    identifier: string;
    accountId: string | null;
    actorId: string | null;
    result: string;
    errorCode: string | null;
  };
}

/** نتيجة نداء GoTrue لمحاولة الدخول في كل اختبار. */
let signInResult: { data: { session: unknown }; error: unknown };

/**
 * يستدعي دالة الخادم بالطريقة نفسها التي تستخدمها الاختبارات أعلاه.
 */
function callHandler(data: { identifier: string; password: string }) {
  return signIn(data) as Promise<unknown>;
}

describe("signInWithIdentifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_URL = "https://supabase.example.test";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    profileRows = [
      { id: "11111111-1111-4111-8111-111111111111", email: "admin@example.test", is_active: true },
    ];
    signInResult = {
      data: {
        session: {
          access_token: "access",
          refresh_token: "refresh",
          user: { id: "11111111-1111-4111-8111-111111111111" },
        },
      },
      error: null,
    };
    mocks.createClient.mockReturnValue({
      auth: { signInWithPassword: mocks.signInWithPassword },
    });
    // An identifier that classifies as an email resolves through profiles.
    // Reads through `profileRows`/`signInResult` at call time so a test can
    // stage its own state after this reset.
    mocks.from.mockReturnValue({
      select: () => ({
        eq: () => ({ limit: () => Promise.resolve({ data: profileRows }) }),
      }),
    });
    mocks.signInWithPassword.mockImplementation(() => Promise.resolve(signInResult));
  });

  /**
   * The bug this guards against did not fail a login — it succeeded, and left a
   * refresh ticker running in the server process holding the user's session.
   * The browser holds the same session and GoTrue rotates refresh tokens, so
   * the second refresh was rejected as token reuse and the session family was
   * revoked. The user was silently signed out mid-session and every permission
   * check then failed, surfacing as "no permission to access the dashboard".
   *
   * auth-js starts that ticker unconditionally off-browser, so the only thing
   * preventing it is this option being explicitly false.
   */
  it("builds its login client with auto-refresh disabled", async () => {
    await signIn({ identifier: "admin@example.test", password: "secret-password" });

    expect(mocks.createClient).toHaveBeenCalled();
    const options = mocks.createClient.mock.calls[0][2];
    expect(options.auth.autoRefreshToken).toBe(false);
    expect(options.auth.persistSession).toBe(false);
  });

  it("returns the session tokens for the browser to install", async () => {
    const result = await signIn({
      identifier: "admin@example.test",
      password: "secret-password",
    });

    expect(result).toEqual({ ok: true, accessToken: "access", refreshToken: "refresh" });
  });

  it("reports one opaque failure so the form is not an account-existence oracle", async () => {
    signInResult = {
      data: { session: null },
      error: { message: "Invalid login credentials" },
    };

    const result = await callHandler({
      identifier: "admin@example.test",
      password: "wrong-password",
    });

    expect(result).toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
  });

  it("an active account signs in and receives its tokens", async () => {
    profileRows = [
      { id: "22222222-2222-4222-8222-222222222222", email: "active@example.test", is_active: true },
    ];
    signInResult = {
      data: { session: { access_token: "a", refresh_token: "r", user: { id: "u-1" } } },
      error: null,
    };

    const result = await callHandler({ identifier: "active", password: "pw" });

    expect(result).toEqual({ ok: true, accessToken: "a", refreshToken: "r" });
  });

  it("a deactivated account is refused even with the correct password", async () => {
    profileRows = [
      { id: "33333333-3333-4333-8333-333333333333", email: "off@example.test", is_active: false },
    ];
    signInResult = {
      data: { session: { access_token: "a", refresh_token: "r", user: { id: "u-1" } } },
      error: null,
    };

    const result = await callHandler({ identifier: "off", password: "correct-pw" });

    expect(result).toEqual({ ok: false, error: "ACCOUNT_DEACTIVATED" });
  });

  it("an unbanned deactivated account is not revealed to someone without the password", async () => {
    profileRows = [
      { id: "33333333-3333-4333-8333-333333333333", email: "off@example.test", is_active: false },
    ];
    signInResult = {
      data: { session: null },
      error: { message: "Invalid login credentials" },
    };

    const result = await callHandler({ identifier: "off", password: "wrong-pw" });

    // Only reachable while `is_active` is false but `banned_until` is not yet set
    // — the window between a failed ban and its retry. Once the account is banned,
    // GoTrue answers `user_banned` to any password and the case below applies.
    expect(result).toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
  });

  it("a banned account reports deactivation rather than bad credentials", async () => {
    profileRows = [
      { id: "33333333-3333-4333-8333-333333333333", email: "off@example.test", is_active: false },
    ];
    signInResult = {
      data: { session: null },
      error: { code: "user_banned", message: "User is banned" },
    };

    const result = await callHandler({ identifier: "off", password: "correct-pw" });

    expect(result).toEqual({ ok: false, error: "ACCOUNT_DEACTIVATED" });
  });

  /**
   * Reconstructing one customer's failed login used to mean reading three
   * container logs that rotate away while the Audit screen showed nothing.
   * These four cases are the four outcomes the screen has to be able to show.
   */
  describe("audit trail", () => {
    it("records a successful login against the account that signed in", async () => {
      await callHandler({ identifier: "admin@example.test", password: "secret-password" });

      expect(lastAuditInput()).toEqual({
        identifier: "admin@example.test",
        accountId: "11111111-1111-4111-8111-111111111111",
        actorId: "11111111-1111-4111-8111-111111111111",
        result: "success",
        errorCode: null,
      });
    });

    it("records a wrong password as a failure carrying the identifier as typed", async () => {
      signInResult = { data: { session: null }, error: { message: "Invalid login credentials" } };

      await callHandler({ identifier: "admin@example.test", password: "wrong-password" });

      expect(lastAuditInput()).toMatchObject({
        identifier: "admin@example.test",
        result: "failure",
        errorCode: "INVALID_CREDENTIALS",
      });
    });

    /**
     * The identifier that resolves to nothing is the one worth recording: a
     * mistyped username or a mobile stored in another format leaves no
     * `entity_id` at all, so `after.identifier` is the only handle on it.
     */
    it("records an unresolvable identifier with no account attached", async () => {
      // A mobile identifier goes through the phone RPC, not the profiles read.
      mocks.rpc.mockResolvedValue({ data: [] });
      signInResult = { data: { session: null }, error: { message: "Invalid login credentials" } };

      await callHandler({ identifier: "96550009999", password: "pw" });

      expect(lastAuditInput()).toMatchObject({
        identifier: "96550009999",
        accountId: null,
        result: "failure",
        errorCode: "INVALID_CREDENTIALS",
      });
    });

    it("records a banned account under its own error code", async () => {
      profileRows = [
        { id: "33333333-3333-4333-8333-333333333333", email: "off@example.test", is_active: false },
      ];
      signInResult = { data: { session: null }, error: { code: "user_banned", message: "banned" } };

      await callHandler({ identifier: "off", password: "correct-pw" });

      expect(lastAuditInput()).toMatchObject({
        result: "failure",
        errorCode: "ACCOUNT_DEACTIVATED",
      });
    });

    /**
     * The password verified, so a session exists — but naming that account as
     * the actor would render a refused login as a successful sign-in in the
     * actor column.
     */
    it("does not attribute a refused deactivated account to itself", async () => {
      profileRows = [
        { id: "33333333-3333-4333-8333-333333333333", email: "off@example.test", is_active: false },
      ];
      signInResult = {
        data: { session: { access_token: "a", refresh_token: "r", user: { id: "u-1" } } },
        error: null,
      };

      await callHandler({ identifier: "off", password: "correct-pw" });

      expect(lastAuditInput()).toMatchObject({
        actorId: null,
        result: "failure",
        errorCode: "ACCOUNT_DEACTIVATED",
      });
    });

    /** The one thing that must never reach an audit row. */
    it("never passes the password to the audit writer", async () => {
      signInResult = { data: { session: null }, error: { message: "Invalid login credentials" } };

      await callHandler({ identifier: "admin@example.test", password: "s3cr3t-p4ssw0rd" });

      // Both writers, not just the one this path happens to use today.
      expect(JSON.stringify(mocks.recordLoginAttempt.mock.calls)).not.toContain("s3cr3t-p4ssw0rd");
      expect(JSON.stringify(mocks.recordFailedLoginAttempt.mock.calls)).not.toContain(
        "s3cr3t-p4ssw0rd",
      );
    });

    /**
     * Review finding on PR #206. Accounts with no real address authenticate as
     * `<username>@users.local` and resolve to no profile row, so taking the id
     * only from that lookup recorded their successful login as "system" with no
     * account attached — precisely the login nobody could then trace. GoTrue has
     * just authenticated the person, so its own answer identifies them.
     */
    it("attributes a legacy fallback login from the authentication response", async () => {
      profileRows = [];
      signInResult = {
        data: {
          session: { access_token: "a", refresh_token: "r", user: { id: "legacy-user-id" } },
        },
        error: null,
      };

      await callHandler({ identifier: "legacy.user", password: "pw" });

      expect(lastAuditInput()).toMatchObject({
        identifier: "legacy.user",
        accountId: "legacy-user-id",
        actorId: "legacy-user-id",
        result: "success",
      });
    });
  });
});
