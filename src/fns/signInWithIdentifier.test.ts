import { beforeEach, describe, expect, it, test, vi } from "vitest";

vi.mock("@tanstack/react-start", async () =>
  (await import("./signInWithIdentifier.testkit")).serverFnModule(),
);
vi.mock("@supabase/supabase-js", async () =>
  (await import("./signInWithIdentifier.testkit")).supabaseJsModule(),
);
vi.mock("@/company/companyClient.server", async () =>
  (await import("./signInWithIdentifier.testkit")).companyClientModule(),
);
vi.mock("@/company/requestCompany.server", async () =>
  (await import("./signInWithIdentifier.testkit")).requestCompanyModule(),
);
vi.mock("@/fns/loginAudit", async () =>
  (await import("./signInWithIdentifier.testkit")).loginAuditModule(),
);

import type { RequestCompany } from "@/company/requestCompany.server";
import { getPublicRequestCompanyId, signInWithIdentifier } from "./signInWithIdentifier";
import {
  lastAuditInput,
  resetSignInFixtures,
  serverFunction,
  signInBoundary,
  signInState,
  stageAuthAccounts,
  type ProfileRow,
} from "./signInWithIdentifier.testkit";

// The mocked createServerFn returns a plain callable, so the exported symbol's
// fetcher type does not describe how it is driven here. Same cast as
// createAppUser.test.ts.
const signIn = signInWithIdentifier as unknown as typeof serverFunction;

/**
 * يستدعي دالة الخادم بالطريقة نفسها التي تستخدمها الاختبارات أعلاه.
 */
function callHandler(data: { identifier: string; password: string }) {
  return signIn(data) as Promise<unknown>;
}

/**
 * يحل محل صفوف profiles المرئية لشركة الطلب الحالية في حدود Supabase الوهمية.
 */
function stageProfiles(rows: ProfileRow[]) {
  signInState.profilesByCompany[signInState.requestCompany.id] = rows;
}

const companyA: RequestCompany = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  slug: "acme",
  status: "active",
  host: "acme.ijary.app",
};
const companyB: RequestCompany = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  slug: "beta",
  status: "active",
  host: "beta.ijary.app",
};
const frozenCompany: RequestCompany = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  slug: "frozen",
  status: "suspended",
  host: "frozen.ijary.app",
};
const userA = "a0000000-0000-4000-8000-000000000001";
const userB = "b0000000-0000-4000-8000-000000000002";

/**
 * يجهّز شركتين تتقاسمان معرّفاً واحداً بحسابين منفصلين لكل منهما كلمة مروره.
 *
 * Both companies hold a profile for the identifier, and each profile carries
 * its own address and its own GoTrue account. The account is also reachable
 * under R3's synthetic address so the scenario keeps holding when T083/T084
 * move the password grant onto it; the password and account id carry the
 * scenario, not the address spelling.
 */
function stageSharedIdentifierAccounts() {
  signInState.profilesByCompany = {
    [companyA.id]: [{ id: userA, email: "john@acme.test", is_active: true }],
    [companyB.id]: [{ id: userB, email: "john@beta.test", is_active: true }],
  };
  signInState.phoneRowsByCompany = {
    [companyA.id]: [{ id: userA, email: "john@acme.test" }],
    [companyB.id]: [{ id: userB, email: "john@beta.test" }],
  };
  stageAuthAccounts({
    "john@acme.test": { userId: userA, password: "pw-acme" },
    [`${userA}@auth.ijary.invalid`]: { userId: userA, password: "pw-acme" },
    "john@beta.test": { userId: userB, password: "pw-beta" },
    [`${userB}@auth.ijary.invalid`]: { userId: userB, password: "pw-beta" },
  });
}

describe("signInWithIdentifier", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_URL = "https://supabase.example.test";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    resetSignInFixtures();
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

    expect(signInBoundary.createClient).toHaveBeenCalled();
    const options = signInBoundary.createClient.mock.calls[0][2];
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
    signInState.signInResult = {
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
    stageProfiles([
      { id: "22222222-2222-4222-8222-222222222222", email: "active@example.test", is_active: true },
    ]);
    signInState.signInResult = {
      data: {
        session: {
          access_token: "a",
          refresh_token: "r",
          user: { id: "22222222-2222-4222-8222-222222222222" },
        },
      },
      error: null,
    };

    const result = await callHandler({ identifier: "active", password: "pw" });

    expect(result).toEqual({ ok: true, accessToken: "a", refreshToken: "r" });
  });

  it("grants the password against the account's synthetic auth address first", async () => {
    // R3's address is what keys the login; `profiles.email` is only the
    // person's contact address and may sit on two companies' profiles at once.
    stageProfiles([
      { id: "22222222-2222-4222-8222-222222222222", email: "active@example.test", is_active: true },
    ]);

    await callHandler({ identifier: "active", password: "pw" });

    expect(signInBoundary.signInWithPassword.mock.calls[0][0]).toEqual({
      email: "22222222-2222-4222-8222-222222222222@auth.ijary.invalid",
      password: "pw",
    });
  });

  it("still signs in a legacy account through its stored address once the synthetic one fails", async () => {
    // Accounts created before synthetic auth emails hold a real (or
    // `@users.local`) address in GoTrue. They keep signing in through it until
    // their next admin edit converges them onto the synthetic form.
    stageProfiles([
      { id: "22222222-2222-4222-8222-222222222222", email: "active@example.test", is_active: true },
    ]);
    stageAuthAccounts({
      "active@example.test": { userId: "22222222-2222-4222-8222-222222222222", password: "pw" },
    });

    const result = await callHandler({ identifier: "active", password: "pw" });

    expect(result).toEqual({
      ok: true,
      accessToken: "access-22222222-2222-4222-8222-222222222222",
      refreshToken: "refresh-22222222-2222-4222-8222-222222222222",
    });
  });

  // Regression (T052r, second US1 review 2026-11-26): the identifier lookup is
  // company-scoped, but its fallback hands any email to GoTrue, whose accounts
  // span every company. A correct password for another company's account
  // returned a session on this company's host.
  it("refuses another company's account with the same opaque failure and revokes its session", async () => {
    stageProfiles([]);
    signInState.signInResult = {
      data: {
        session: { access_token: "a", refresh_token: "r", user: { id: "other-company-user" } },
      },
      error: null,
    };

    const result = await callHandler({ identifier: "owner@other.test", password: "correct-pw" });

    expect(result).toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
    expect(signInBoundary.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(signInBoundary.recordLoginAttempt).not.toHaveBeenCalled();
    // The other company's account id must not land in this company's audit trail.
    expect(lastAuditInput()).toMatchObject({
      identifier: "owner@other.test",
      accountId: null,
      result: "failure",
      errorCode: "INVALID_CREDENTIALS",
    });
  });

  it("a deactivated account is refused even with the correct password", async () => {
    stageProfiles([
      { id: "33333333-3333-4333-8333-333333333333", email: "off@example.test", is_active: false },
    ]);
    signInState.signInResult = {
      data: {
        session: {
          access_token: "a",
          refresh_token: "r",
          user: { id: "33333333-3333-4333-8333-333333333333" },
        },
      },
      error: null,
    };

    const result = await callHandler({ identifier: "off", password: "correct-pw" });

    expect(result).toEqual({ ok: false, error: "ACCOUNT_DEACTIVATED" });
  });

  it("an unbanned deactivated account is not revealed to someone without the password", async () => {
    stageProfiles([
      { id: "33333333-3333-4333-8333-333333333333", email: "off@example.test", is_active: false },
    ]);
    signInState.signInResult = {
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
    stageProfiles([
      { id: "33333333-3333-4333-8333-333333333333", email: "off@example.test", is_active: false },
    ]);
    signInState.signInResult = {
      data: { session: null },
      error: { code: "user_banned", message: "User is banned" },
    };

    const result = await callHandler({ identifier: "off", password: "correct-pw" });

    expect(result).toEqual({ ok: false, error: "ACCOUNT_DEACTIVATED" });
  });

  it("the session GoTrue issues for another company's account is treated as signed out", async () => {
    // One real address, two profile rows: GoTrue holds a single account for the
    // address (company A's person), while company B's profile points at it too.
    signInState.requestCompany = companyB;
    stageAuthAccounts({ "home@shared.test": { userId: userA, password: "pw-shared" } });
    signInState.profilesByCompany = {
      [companyA.id]: [{ id: userA, email: "home@shared.test", is_active: true }],
      [companyB.id]: [{ id: userB, email: "home@shared.test", is_active: true }],
    };
    signInState.phoneRowsByCompany = {};

    const result = await callHandler({ identifier: "home@shared.test", password: "pw-shared" });

    expect(result).toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
    // The session GoTrue just issued is revoked (local scope: this session only),
    // so a session of another company leaves nothing signed in behind it.
    expect(signInBoundary.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(lastAuditInput()).toMatchObject({ accountId: null, result: "failure" });
  });

  it("a suspended company's host refuses sign-in even with a correct password", async () => {
    // RLS fails closed for a suspended company (`current_company_id()` is
    // null), so its client sees no profiles; the refusal below rides on that.
    // The error code is deliberately not pinned: research.md R18 says the
    // function "refuses", and whether the refusal stays RLS-mediated or becomes
    // an explicit COMPANY_SUSPENDED answer is T084's to decide.
    signInState.requestCompany = frozenCompany;
    signInState.profilesByCompany = { [frozenCompany.id]: [] };
    signInState.phoneRowsByCompany = {};
    stageAuthAccounts({ "home@shared.test": { userId: userA, password: "pw-acme" } });

    const result = await callHandler({ identifier: "home@shared.test", password: "pw-acme" });

    expect(result).toMatchObject({ ok: false });
    expect(result).not.toHaveProperty("accessToken");
  });

  describe("the same identifier in two companies", () => {
    it.each([["john"], ["96550001111"]])(
      "the shared identifier %s signs in only the host company's account with its own password",
      async (identifier) => {
        stageSharedIdentifierAccounts();

        signInState.requestCompany = companyA;
        const atA = await callHandler({ identifier, password: "pw-acme" });
        expect(atA).toEqual({
          ok: true,
          accessToken: `access-${userA}`,
          refreshToken: `refresh-${userA}`,
        });

        // The other account's password fails here exactly like a wrong password.
        const foreignAtA = await callHandler({ identifier, password: "pw-beta" });
        expect(foreignAtA).toEqual({ ok: false, error: "INVALID_CREDENTIALS" });

        signInState.requestCompany = companyB;
        const atB = await callHandler({ identifier, password: "pw-beta" });
        expect(atB).toEqual({
          ok: true,
          accessToken: `access-${userB}`,
          refreshToken: `refresh-${userB}`,
        });
      },
    );

    // T083 + T084: both profiles carry one real email address, and GoTrue holds
    // a single account for it, so the two companies shared one password before.
    // Synthetic per-account auth emails (T083) and a password grant against the
    // host company's own account (T084) are what give each account its own
    // password; the fixture stages those synthetic addresses to pin the end
    // state from research.md R3.
    test("the same email address in two companies keeps separate passwords", async () => {
      signInState.requestCompany = companyA;
      signInState.profilesByCompany = {
        [companyA.id]: [{ id: userA, email: "home@shared.test", is_active: true }],
        [companyB.id]: [{ id: userB, email: "home@shared.test", is_active: true }],
      };
      signInState.phoneRowsByCompany = {};
      stageAuthAccounts({
        [`${userA}@auth.ijary.invalid`]: { userId: userA, password: "pw-acme" },
        [`${userB}@auth.ijary.invalid`]: { userId: userB, password: "pw-beta" },
      });

      const atA = await callHandler({ identifier: "home@shared.test", password: "pw-acme" });
      expect(atA).toEqual({
        ok: true,
        accessToken: `access-${userA}`,
        refreshToken: `refresh-${userA}`,
      });

      signInState.requestCompany = companyB;
      const atB = await callHandler({ identifier: "home@shared.test", password: "pw-beta" });
      expect(atB).toEqual({
        ok: true,
        accessToken: `access-${userB}`,
        refreshToken: `refresh-${userB}`,
      });
    });
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
      signInState.signInResult = {
        data: { session: null },
        error: { message: "Invalid login credentials" },
      };

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
      signInBoundary.rpc.mockResolvedValue({ data: [] });
      signInState.signInResult = {
        data: { session: null },
        error: { message: "Invalid login credentials" },
      };

      await callHandler({ identifier: "96550009999", password: "pw" });

      expect(lastAuditInput()).toMatchObject({
        identifier: "96550009999",
        accountId: null,
        result: "failure",
        errorCode: "INVALID_CREDENTIALS",
      });
    });

    it("records a banned account under its own error code", async () => {
      stageProfiles([
        { id: "33333333-3333-4333-8333-333333333333", email: "off@example.test", is_active: false },
      ]);
      signInState.signInResult = {
        data: { session: null },
        error: { code: "user_banned", message: "banned" },
      };

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
      stageProfiles([
        { id: "33333333-3333-4333-8333-333333333333", email: "off@example.test", is_active: false },
      ]);
      signInState.signInResult = {
        data: {
          session: {
            access_token: "a",
            refresh_token: "r",
            user: { id: "33333333-3333-4333-8333-333333333333" },
          },
        },
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
      signInState.signInResult = {
        data: { session: null },
        error: { message: "Invalid login credentials" },
      };

      await callHandler({ identifier: "admin@example.test", password: "s3cr3t-p4ssw0rd" });

      // Both writers, not just the one this path happens to use today.
      expect(JSON.stringify(signInBoundary.recordLoginAttempt.mock.calls)).not.toContain(
        "s3cr3t-p4ssw0rd",
      );
      expect(JSON.stringify(signInBoundary.recordFailedLoginAttempt.mock.calls)).not.toContain(
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
      // A legacy account has a profile in this company but no real address, so
      // the identifier lookup resolves nothing and the `@users.local` mapping signs in.
      stageProfiles([{ id: "legacy-user-id", email: null, is_active: true }]);
      signInState.signInResult = {
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

describe("getPublicRequestCompanyId", () => {
  it("returns the host company's id so the browser can finish its sign-in check", async () => {
    // AuthProvider compares this against the signed-in profile's company_id;
    // a session from another company then counts as not signed in.
    const getCompanyId = getPublicRequestCompanyId as unknown as typeof serverFunction;

    await expect(getCompanyId(undefined)).resolves.toBe(signInState.requestCompany.id);
  });
});
