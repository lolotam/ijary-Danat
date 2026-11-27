import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () =>
  (await import("./passwordReset.testkit")).supabaseJsModule(),
);
vi.mock("@tanstack/react-start", async () =>
  (await import("./passwordReset.testkit")).serverFnModule(),
);
vi.mock("@/company/companyClient.server", async () =>
  (await import("./passwordReset.testkit")).companyClientModule(),
);
vi.mock("@/company/requestCompany.server", async () =>
  (await import("./passwordReset.testkit")).requestCompanyModule(),
);
vi.mock("@/platform/authAdmin.server", async () =>
  (await import("./passwordReset.testkit")).authAdminModule(),
);
vi.mock("@/fns/loginAudit", async () =>
  (await import("./passwordReset.testkit")).loginAuditModule(),
);

import { changeOwnPassword, confirmPasswordReset, requestPasswordReset } from "./passwordReset";
import {
  OTHER_COMPANY_ID,
  RESET_COMPANY,
  RESET_USER,
  resetBoundary,
  resetFixtures,
  resetState,
  type TokenRow,
} from "./passwordReset.testkit";

/**
 * The mocked `createServerFn` returns a plain callable, so the exported
 * symbol's fetcher type does not describe how it is driven here.
 */
type ServerFn = {
  context: unknown;
  (data: unknown): Promise<unknown>;
};

const requestReset = requestPasswordReset as unknown as ServerFn;
const confirmReset = confirmPasswordReset as unknown as ServerFn;
const changeOwn = changeOwnPassword as unknown as ServerFn;

/** الرمز الصريح الذي تُبنى منه البصمة المخزَّنة. */
const RAW_TOKEN = "raw-reset-token-value";

/** كلمة المرور الجديدة في كل السيناريوهات. */
const NEW_PASSWORD = "NewPassw0rd!";

/**
 * بصمة الرمز كما يخزّنها الخادم.
 */
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * يضع رمزاً صالحاً (أو معدَّلاً) في حالة الشركة.
 */
function stageToken(overrides: Partial<TokenRow> = {}) {
  resetState.tokens.push({
    id: "44444444-4444-4444-8444-444444444444",
    company_id: RESET_COMPANY.id,
    user_id: RESET_USER.id,
    token_hash: digest(RAW_TOKEN),
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    used_at: null,
    ...overrides,
  });
}

/**
 * يستخرج الرمز الصريح من رابط رسالة الاستعادة.
 */
function tokenInMessage(): string {
  const body = resetState.notifications[0]?.body ?? "";
  const match = /token=([^"&]+)/.exec(body);
  expect(match, "the message must carry the reset link").toBeTruthy();
  return match![1];
}

beforeEach(() => {
  resetFixtures();
});

describe("requesting a password reset", () => {
  it("answers the same way whether or not the account exists", async () => {
    const unknown = await requestReset({ identifier: "nobody" });

    // Nothing may be minted or sent for an account that is not there.
    expect(resetState.tokens).toHaveLength(0);
    expect(resetState.notifications).toHaveLength(0);
    expect(resetState.jobs).toHaveLength(0);

    const known = await requestReset({ identifier: "waleed" });

    // The two answers must be indistinguishable, or the form becomes an
    // account-existence oracle.
    expect(known).toEqual(unknown);
    expect(known).toEqual({ ok: true });
  });

  it("joins the sign-in failure ladder, so a spray stays bounded", async () => {
    await requestReset({ identifier: "waleed" });

    expect(resetBoundary.recordFailedLoginAttempt).toHaveBeenCalledWith({
      identifier: "waleed",
      accountId: RESET_USER.id,
      errorCode: "INVALID_CREDENTIALS",
    });
  });

  it("stores only the digest of the token", async () => {
    await requestReset({ identifier: "waleed" });

    const raw = tokenInMessage();
    const stored = resetState.tokens[0].token_hash;
    expect(stored).toBe(digest(raw));
    // The plaintext must not be recoverable from the database row.
    expect(JSON.stringify(resetState.tokens)).not.toContain(raw);
  });

  it("keeps the token out of the notification payload", async () => {
    await requestReset({ identifier: "waleed" });

    const notification = resetState.notifications[0];
    expect(notification.body).toContain("reset-password?token=");
    expect(JSON.stringify(notification.payload)).not.toContain("token");
  });

  it("queues the message through a notification.dispatch job", async () => {
    await requestReset({ identifier: "waleed" });

    const job = resetState.jobs.find((entry) => entry.kind === "notification.dispatch");
    expect(job).toBeTruthy();
    expect(job!.payload).toEqual({ notificationId: resetState.notifications[0].id });
    expect(job!.dedupe_key).toBe(`notification.dispatch:${resetState.notifications[0].id}`);
  });

  it("addresses the message to the account's own mailbox", async () => {
    await requestReset({ identifier: "waleed" });

    expect(resetState.notifications[0].recipient_address).toBe(RESET_USER.email);
  });

  it("finds the account by mobile number as well", async () => {
    await requestReset({ identifier: "51234567" });

    expect(resetState.tokens).toHaveLength(1);
    expect(resetState.tokens[0].user_id).toBe(RESET_USER.id);
  });

  it("mints nothing for a deactivated account", async () => {
    resetState.profiles[0].is_active = false;

    await requestReset({ identifier: "waleed" });

    expect(resetState.tokens).toHaveLength(0);
    expect(resetState.notifications).toHaveLength(0);
  });

  it("stops minting after 3 tokens in 15 minutes without revealing the cap", async () => {
    // An older token outside the 15-minute window must not count toward the cap.
    stageToken({
      id: "44444444-4444-4444-8444-444444444440",
      token_hash: digest("expired-window-token"),
      created_at: new Date(Date.now() - 16 * 60_000).toISOString(),
    });

    for (let i = 0; i < 3; i += 1) {
      const ok = await requestReset({ identifier: "waleed" });
      expect(ok).toEqual({ ok: true });
    }
    expect(resetState.tokens).toHaveLength(4);
    expect(resetState.notifications).toHaveLength(3);

    const capped = await requestReset({ identifier: "waleed" });

    expect(capped).toEqual({ ok: true });
    expect(resetState.tokens).toHaveLength(4);
    expect(resetState.notifications).toHaveLength(3);
  });
});

describe("confirming a password reset", () => {
  it("sets the password, clears the flag and consumes the token", async () => {
    resetState.profiles[0].must_change_password = true;
    stageToken();

    const result = await confirmReset({ token: RAW_TOKEN, password: NEW_PASSWORD });

    expect(result).toEqual({ ok: true, portalAccount: false });
    expect(resetBoundary.updateAuthUserById).toHaveBeenCalledWith(RESET_USER.id, {
      password: NEW_PASSWORD,
    });
    expect(resetBoundary.signOutAuthUser).toHaveBeenCalledTimes(1);
    expect(resetBoundary.signOutAuthUser).toHaveBeenCalledWith(RESET_USER.id);
    expect(resetState.profiles[0].must_change_password).toBe(false);
    expect(resetState.tokens[0].used_at).not.toBeNull();
  });

  it.each([
    ["an expired token", { expires_at: new Date(Date.now() - 60_000).toISOString() }],
    ["a token that was already used", { used_at: new Date().toISOString() }],
    ["a token minted by another company", { company_id: OTHER_COMPANY_ID }],
  ])("refuses %s without touching the password", async (_label, overrides) => {
    stageToken(overrides);

    const result = await confirmReset({ token: RAW_TOKEN, password: NEW_PASSWORD });

    expect(result).toEqual({ ok: false, error: "INVALID_TOKEN" });
    expect(resetBoundary.updateAuthUserById).not.toHaveBeenCalled();
    expect(resetBoundary.signOutAuthUser).not.toHaveBeenCalled();
  });

  it("refuses a token that was never issued", async () => {
    const result = await confirmReset({ token: "never-issued", password: NEW_PASSWORD });

    expect(result).toEqual({ ok: false, error: "INVALID_TOKEN" });
    expect(resetBoundary.updateAuthUserById).not.toHaveBeenCalled();
    expect(resetBoundary.signOutAuthUser).not.toHaveBeenCalled();
  });

  it("tells a renter's account apart from a staff account", async () => {
    resetState.profiles[0].tenant_id = "55555555-5555-4555-8555-555555555555";
    stageToken();

    const result = await confirmReset({ token: RAW_TOKEN, password: NEW_PASSWORD });

    expect(result).toEqual({ ok: true, portalAccount: true });
  });

  it("writes the change to the platform audit log", async () => {
    stageToken();

    await confirmReset({ token: RAW_TOKEN, password: NEW_PASSWORD });

    expect(resetState.audits).toContainEqual({
      action: "user.password_reset",
      entity_id: RESET_USER.id,
      result: "success",
    });
  });

  it("revokes other open reset tokens for the same user in the company", async () => {
    stageToken();
    stageToken({
      id: "55555555-5555-4555-8555-555555555555",
      token_hash: digest("older-open-token"),
      expires_at: new Date(Date.now() + 120_000).toISOString(),
    });

    await confirmReset({ token: RAW_TOKEN, password: NEW_PASSWORD });

    const secondToken = resetState.tokens[1];
    expect(secondToken.used_at).toBeNull();
    expect(new Date(secondToken.expires_at).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("refuses a second confirm with the same token and updates the password once", async () => {
    stageToken();

    const [first, second] = await Promise.all([
      confirmReset({ token: RAW_TOKEN, password: NEW_PASSWORD }),
      confirmReset({ token: RAW_TOKEN, password: NEW_PASSWORD }),
    ]);

    expect([first, second]).toContainEqual({ ok: true, portalAccount: false });
    expect([first, second]).toContainEqual({ ok: false, error: "INVALID_TOKEN" });
    expect(resetBoundary.updateAuthUserById).toHaveBeenCalledTimes(1);
  });
});

describe("changing the signed-in account's password", () => {
  it("allows a forced change without current password and revokes every session", async () => {
    resetState.profiles[0].must_change_password = true;
    changeOwn.context = { userId: RESET_USER.id, supabase: {} };

    const result = await changeOwn({ password: NEW_PASSWORD });

    expect(result).toEqual({ ok: true });
    expect(resetBoundary.signInWithPassword).not.toHaveBeenCalled();
    expect(resetBoundary.updateAuthUserById).toHaveBeenCalledWith(RESET_USER.id, {
      password: NEW_PASSWORD,
    });
    expect(resetBoundary.signOutAuthUser).toHaveBeenCalledTimes(1);
    expect(resetBoundary.signOutAuthUser).toHaveBeenCalledWith(RESET_USER.id);
    expect(resetState.profiles[0].must_change_password).toBe(false);
  });

  it("allows a non-forced change when the current password verifies and revokes every session", async () => {
    resetState.profiles[0].must_change_password = false;
    resetBoundary.signInWithPassword.mockResolvedValueOnce({
      data: { session: { access_token: "verify-jwt" }, user: { id: RESET_USER.id } },
      error: null,
    });
    changeOwn.context = { userId: RESET_USER.id, supabase: {} };

    const result = await changeOwn({
      currentPassword: "OldPassw0rd!",
      password: NEW_PASSWORD,
    });

    expect(result).toEqual({ ok: true });
    expect(resetBoundary.signInWithPassword).toHaveBeenCalledWith({
      email: `${RESET_USER.id}@auth.ijary.invalid`,
      password: "OldPassw0rd!",
    });
    expect(resetBoundary.signOutLocal).toHaveBeenCalledWith({ scope: "local" });
    expect(resetBoundary.updateAuthUserById).toHaveBeenCalledWith(RESET_USER.id, {
      password: NEW_PASSWORD,
    });
    expect(resetBoundary.signOutAuthUser).toHaveBeenCalledTimes(1);
    expect(resetBoundary.signOutAuthUser).toHaveBeenCalledWith(RESET_USER.id);
  });

  it.each([
    ["no current password", { password: NEW_PASSWORD }],
    ["a wrong current password", { currentPassword: "WrongPassw0rd!", password: NEW_PASSWORD }],
  ])(
    "refuses a non-forced change with %s without updating or signing out",
    async (_label, input) => {
      resetState.profiles[0].must_change_password = false;
      changeOwn.context = { userId: RESET_USER.id, supabase: {} };

      const result = await changeOwn(input);

      expect(result).toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
      expect(resetBoundary.updateAuthUserById).not.toHaveBeenCalled();
      expect(resetBoundary.signOutAuthUser).not.toHaveBeenCalled();
      expect(resetBoundary.recordFailedLoginAttempt).toHaveBeenCalledWith({
        identifier: "waleed",
        accountId: RESET_USER.id,
        errorCode: "INVALID_CREDENTIALS",
      });
    },
  );

  it("refuses a current password that only signs in to a different account", async () => {
    // Profile email/username can point at another GoTrue account whose password
    // the caller knows; that sign-in must not count as proof (security review).
    resetState.profiles[0].must_change_password = false;
    resetBoundary.signInWithPassword.mockResolvedValue({
      data: {
        session: { access_token: "other-jwt" },
        user: { id: "77777777-7777-4777-8777-777777777777" },
      },
      error: null,
    });
    changeOwn.context = { userId: RESET_USER.id, supabase: {} };

    const result = await changeOwn({ currentPassword: "OtherPassw0rd!", password: NEW_PASSWORD });

    expect(result).toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
    expect(resetBoundary.updateAuthUserById).not.toHaveBeenCalled();
    expect(resetBoundary.signOutAuthUser).not.toHaveBeenCalled();
  });

  it("refuses a foreign-company user without touching the password", async () => {
    const foreignUserId = "66666666-6666-4666-8666-666666666666";
    resetState.profiles.push({
      ...resetState.profiles[0],
      id: foreignUserId,
      company_id: OTHER_COMPANY_ID,
    });
    changeOwn.context = { userId: foreignUserId, supabase: {} };

    await expect(changeOwn({ password: NEW_PASSWORD })).rejects.toThrow("Unauthorized");
    expect(resetBoundary.updateAuthUserById).not.toHaveBeenCalled();
    expect(resetBoundary.signOutAuthUser).not.toHaveBeenCalled();
  });

  it("refuses a password shorter than the platform's minimum", async () => {
    changeOwn.context = { userId: RESET_USER.id, supabase: {} };

    await expect(changeOwn({ password: "short" })).rejects.toThrow(/password/i);
    expect(resetBoundary.updateAuthUserById).not.toHaveBeenCalled();
    expect(resetBoundary.signOutAuthUser).not.toHaveBeenCalled();
  });
});
