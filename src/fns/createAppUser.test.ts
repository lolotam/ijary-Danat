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
    createUser: vi.fn(),
    from: vi.fn(),
    deleteUser: vi.fn(),
    linkedProfiles: vi.fn(),
    usernameOwners: vi.fn(),
    emailOwners: vi.fn(),
    profileUpsert: vi.fn(),
    notifyUserCredentials: vi.fn(),
    notificationStates: vi.fn(),
    rpc: vi.fn(),
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
    };
  },
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
}));

vi.mock("@/platform/authAdmin.server", () => ({
  createAuthUser: mocks.createUser,
  deleteAuthUser: mocks.deleteUser,
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
  serverCompanyClient: (companyId?: string | null) => ({
    companyId: companyId ?? "11111111-1111-4111-8111-111111111111",
    client: { from: mocks.from, rpc: mocks.rpc },
  }),
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: "11111111-1111-4111-8111-111111111111",
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
}));

vi.mock("./notifyUserCredentials", () => ({
  notifyUserCredentials: mocks.notifyUserCredentials,
}));

import { parseUserConflict } from "@/lib/userConflicts";
import { TENANT_PAUSED_REASON } from "@/lib/tenantNotificationsPaused";
import { createAppUser } from "./createAppUser";

describe("createAppUser", () => {
  beforeEach(() => {
    mocks.createUser.mockReset();
    mocks.from.mockReset();
    mocks.rpc.mockReset();
    mocks.from.mockImplementation((table: string) => {
      if (table === "profiles") {
        return {
          // The tenant-link guard filters on tenant_id, the username guard on
          // username, the email-owner lookup on email; routing by column lets
          // each be driven on its own.
          select: () => {
            const byColumn = (column: string): Record<string, unknown> => ({
              eq: (innerColumn: string) => (column === "company_id" ? byColumn(innerColumn) : {}),
              limit:
                column === "username"
                  ? mocks.usernameOwners
                  : column === "email"
                    ? mocks.emailOwners
                    : mocks.linkedProfiles,
            });
            return {
              eq: (column: string) => byColumn(column),
            };
          },
          upsert: () => ({ select: () => ({ single: mocks.profileUpsert }) }),
        };
      }
      if (table === "user_roles") {
        return { insert: () => Promise.resolve({ error: null }) };
      }
      if (table === "notifications") {
        return { select: () => ({ in: mocks.notificationStates }) };
      }
      return { update: () => ({ eq: () => Promise.resolve({ error: null }) }) };
    });
    mocks.rpc.mockResolvedValue({ error: null });
    mocks.linkedProfiles.mockReset();
    mocks.linkedProfiles.mockResolvedValue({ data: [], error: null });
    mocks.usernameOwners.mockReset();
    mocks.usernameOwners.mockResolvedValue({ data: [], error: null });
    mocks.emailOwners.mockReset();
    mocks.emailOwners.mockResolvedValue({ data: [], error: null });
    mocks.profileUpsert.mockReset();
    mocks.profileUpsert.mockResolvedValue({ error: null });
    mocks.deleteUser.mockReset();
    mocks.notifyUserCredentials.mockReset();
    mocks.notifyUserCredentials.mockResolvedValue({
      ids: ["notification-1"],
      recipientIds: ["notification-1"],
    });
    mocks.notificationStates.mockReset();
    mocks.notificationStates.mockResolvedValue({
      data: [{ state: "sent", failure_reason: null }],
      error: null,
    });
  });

  /**
   * يشغّل الدالة بسياق مسؤول ومستخدم مصادقة جديد — الشكل الوحيد الذي تحتاجه
   * كل الحالات أدناه.
   *
   * Drives the handler with an admin context and a fresh auth user.
   */
  async function createTenant() {
    mocks.createUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } }, error: null });
    const fn = createAppUser as unknown as typeof mocks.serverFunction;
    fn.context = {
      supabase: { rpc: vi.fn().mockResolvedValue({ data: true, error: null }) },
      userId: "admin-1",
    };
    return (await fn({
      kind: "tenant",
      username: "tenant.user",
      password: "password-123",
      displayName: "Tenant User",
      email: "tenant@example.com",
      tenantId: "00000000-0000-0000-0000-000000000001",
    })) as { credentialDelivery: { status: string; reason: string | null } };
  }

  /** وسائط صفوف التدقيق المكتوبة خلال الاستدعاء. */
  function auditCalls() {
    return mocks.rpc.mock.calls
      .filter((call) => call[0] === "write_audit")
      .map((call) => call[1] as Record<string, unknown>);
  }

  it("refuses a second portal account for an already-linked tenant before creating it", async () => {
    mocks.linkedProfiles.mockResolvedValueOnce({ data: [{ id: "existing-user" }], error: null });

    await expect(createTenant()).rejects.toThrow("already has a portal account");
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it("rolls back and explains when a concurrent save linked the tenant first", async () => {
    mocks.profileUpsert.mockResolvedValueOnce({
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "profiles_tenant_id_unique"',
      },
    });

    await expect(createTenant()).rejects.toThrow("already has a portal account");
    expect(mocks.deleteUser).toHaveBeenCalledWith("user-1");
  });

  /**
   * Regression, 2026-09-28: creating a managerial account with a username
   * already held by a tenant portal login failed with the raw
   * `profiles_username_key` violation. The `handle_new_user` trigger suffixes
   * a clashing name, so the auth user was created first and the clash only
   * surfaced at the profile write.
   */
  it("refuses a taken username by name before creating the auth user", async () => {
    mocks.usernameOwners.mockResolvedValueOnce({
      data: [{ id: "existing-user", display_name: "Faisal" }],
      error: null,
    });

    await expect(createTenant()).rejects.toThrow(
      'The username "tenant.user" is already used by "Faisal".',
    );
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it("explains a username taken by a concurrent save instead of the raw constraint", async () => {
    mocks.profileUpsert.mockResolvedValueOnce({
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "profiles_username_key"',
      },
    });

    const error = (await createTenant().catch((e: unknown) => e)) as Error;

    expect(parseUserConflict(error.message)).toEqual({ kind: "username", value: "tenant.user" });
    expect(mocks.deleteUser).toHaveBeenCalledWith("user-1");
  });

  it("reports an email GoTrue already holds as an email conflict naming its owner", async () => {
    mocks.createUser.mockResolvedValueOnce({
      data: { user: null },
      error: { code: "email_exists", message: "Email address already exists", status: 422 },
    });
    mocks.emailOwners.mockResolvedValueOnce({ data: [{ display_name: "Faisal" }], error: null });

    const error = (await createTenant().catch((e: unknown) => e)) as Error;

    expect(parseUserConflict(error.message)).toEqual({
      kind: "email",
      value: "tenant@example.com",
      owner: "Faisal",
    });
    expect(mocks.profileUpsert).not.toHaveBeenCalled();
  });

  it("uses the supplied tenant email as the auth identifier", async () => {
    mocks.createUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } }, error: null });

    const createTenantUser = createAppUser as unknown as typeof mocks.serverFunction;
    createTenantUser.context = {
      supabase: { rpc: vi.fn().mockResolvedValue({ data: true, error: null }) },
      userId: "admin-1",
    };

    await createTenantUser({
      kind: "tenant",
      username: "tenant.user",
      password: "password-123",
      displayName: "Tenant User",
      email: "tenant@example.com",
      tenantId: "00000000-0000-0000-0000-000000000001",
    });

    expect(mocks.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "tenant@example.com" }),
    );
  });

  /**
   * The failure this guards against did not throw: the admin saw "user
   * created", assumed the customer had their password, and the gap surfaced
   * only when that customer phoned in.
   */
  describe("credential delivery", () => {
    it("reports a real send as sent", async () => {
      const result = await createTenant();

      expect(result.credentialDelivery).toEqual({ status: "sent", reason: null });
      expect(auditCalls().some((args) => args.p_action === "user.credentials_send")).toBe(false);
    });

    /**
     * The row leaves the request and the notify worker still owns the send, so
     * the credentials are on their way. Reading that as a failure would send
     * the admin after a send that is still in flight.
     */
    it.each([
      [["queued"], "queued"],
      [["failed", "queued"], "queued"],
    ] as const)(
      "reports the owner rows %s as %s rather than a failure",
      async (states, expected) => {
        mocks.notificationStates.mockResolvedValue({
          data: states.map((state) => ({ state, failure_reason: null })),
          error: null,
        });

        const result = await createTenant();

        expect(result.credentialDelivery).toEqual({ status: expected, reason: null });
      },
    );

    it("reports a delivered channel as sent even when a sibling row is still queued", async () => {
      mocks.notificationStates.mockResolvedValue({
        data: [
          { state: "sent", failure_reason: null },
          { state: "queued", failure_reason: null },
        ],
        error: null,
      });

      const result = await createTenant();

      expect(result.credentialDelivery).toEqual({ status: "sent", reason: null });
    });

    it("writes no failure audit row for credentials that are still in flight", async () => {
      mocks.notificationStates.mockResolvedValue({
        data: [{ state: "queued", failure_reason: null }],
        error: null,
      });

      await createTenant();

      // The audit row claims the customer was told nothing; a queued row says
      // the opposite, so writing one would be a lie about the delivery.
      expect(auditCalls().some((args) => args.p_action === "user.credentials_send")).toBe(false);
    });

    it("reports a thrown send as failed, with the reason", async () => {
      mocks.notifyUserCredentials.mockRejectedValue(new Error("SMTP refused the message"));

      const result = await createTenant();

      expect(result.credentialDelivery).toEqual({
        status: "failed",
        reason: "SMTP refused the message",
      });
    });

    /**
     * A paused workflow returns normally — it is not an error anywhere in the
     * notification stack — so a try/catch alone cannot see it, and the admin
     * was told nothing at all.
     */
    it("reports a paused workflow rather than swallowing it", async () => {
      mocks.notifyUserCredentials.mockResolvedValue({
        ids: [],
        recipientIds: [],
        skipped: true,
        reason: "Workflow is paused.",
      });

      const result = await createTenant();

      expect(result.credentialDelivery).toEqual({
        status: "paused",
        reason: "Workflow is paused.",
      });
    });

    it("reports an empty send as having had no recipient", async () => {
      mocks.notifyUserCredentials.mockResolvedValue({ ids: [], recipientIds: [] });

      const result = await createTenant();

      expect(result.credentialDelivery).toEqual({ status: "no-recipients", reason: null });
    });

    /**
     * The tenant's own switch, not the workflow's: every owner row comes back
     * `skipped` with the pause reason, so the customer was never going to be
     * reached and the admin has to be told why.
     */
    it("reports a tenant whose notifications are paused", async () => {
      mocks.notifyUserCredentials.mockResolvedValue({
        ids: ["notification-1"],
        recipientIds: ["notification-1"],
      });
      mocks.notificationStates.mockResolvedValue({
        data: [{ state: "skipped", failure_reason: TENANT_PAUSED_REASON }],
        error: null,
      });

      const result = await createTenant();

      expect(result.credentialDelivery).toEqual({ status: "tenant-paused", reason: null });
    });

    it("writes a failure audit row so the trail does not claim an unqualified success", async () => {
      mocks.notifyUserCredentials.mockRejectedValue(new Error("SMTP refused the message"));

      await createTenant();

      expect(auditCalls()).toContainEqual(
        expect.objectContaining({
          p_action: "user.credentials_send",
          p_entity_id: "user-1",
          p_result: "failure",
          p_error_code: "failed",
        }),
      );
    });

    it("never puts the new account's password in an audit row", async () => {
      mocks.notifyUserCredentials.mockRejectedValue(new Error("SMTP refused the message"));

      await createTenant();

      expect(JSON.stringify(auditCalls())).not.toContain("password-123");
    });

    /**
     * Review finding on PR #206, and the reason reading `ids.length` was wrong.
     * `dispatchNotificationRecord` catches a provider rejection and *returns*
     * the notification row with `state: 'failed'` — it does not throw — so a
     * refused SMTP or WhatsApp send still yields an id. The original test
     * mocked a rejection, which is not how the helper behaves, and so the exact
     * failure this feature exists to surface was still reported as success.
     */
    it("reports a provider rejection that came back as a failed row, not a throw", async () => {
      mocks.notificationStates.mockResolvedValue({
        data: [{ state: "failed", failure_reason: "SMTP 550 mailbox unavailable" }],
        error: null,
      });

      const result = await createTenant();

      expect(result.credentialDelivery).toEqual({
        status: "failed",
        reason: "SMTP 550 mailbox unavailable",
      });
    });

    /**
     * Where a tenant gets both an email and a WhatsApp message and only one
     * lands, the person was still told; warning the admin would be a false
     * alarm.
     */
    it("counts delivery as sent when at least one channel landed", async () => {
      mocks.notifyUserCredentials.mockResolvedValue({
        ids: ["email-1", "wa-1"],
        recipientIds: ["email-1", "wa-1"],
      });
      mocks.notificationStates.mockResolvedValue({
        data: [
          { state: "failed", failure_reason: "WhatsApp session closed" },
          { state: "sent", failure_reason: null },
        ],
        error: null,
      });

      const result = await createTenant();

      expect(result.credentialDelivery).toEqual({ status: "sent", reason: null });
    });

    it("reports a failure when the notification rows cannot be read back", async () => {
      mocks.notificationStates.mockResolvedValue({
        data: null,
        error: { message: "notifications read failed" },
      });

      const result = await createTenant();

      expect(result.credentialDelivery).toEqual({
        status: "failed",
        reason: "notifications read failed",
      });
    });

    /**
     * Review finding on PR #206. A managerial account mails the new user and
     * copies the company and admin addresses; those are separate notification
     * rows. Judging delivery from all of them let a delivered admin copy mask a
     * failed send to the person who actually needs the password.
     */
    it("ignores the admin copy when deciding whether the owner was told", async () => {
      mocks.notifyUserCredentials.mockResolvedValue({
        ids: ["user-mail", "admin-copy"],
        recipientIds: ["user-mail"],
      });
      mocks.notificationStates.mockResolvedValue({
        data: [{ state: "failed", failure_reason: "SMTP 550 mailbox unavailable" }],
        error: null,
      });

      const result = await createTenant();

      expect(mocks.notificationStates).toHaveBeenCalledWith("id", ["user-mail"]);
      expect(result.credentialDelivery).toEqual({
        status: "failed",
        reason: "SMTP 550 mailbox unavailable",
      });
    });

    it("reports no recipient when only an admin copy was enqueued", async () => {
      mocks.notifyUserCredentials.mockResolvedValue({
        ids: ["admin-copy"],
        recipientIds: [],
      });

      const result = await createTenant();

      expect(result.credentialDelivery).toEqual({ status: "no-recipients", reason: null });
      expect(mocks.notificationStates).not.toHaveBeenCalled();
    });
  });
});

/**
 * The tenant path must never fail the call after the account exists (D10):
 * the portal-enable write and the contact sync each carry their own flag, so
 * the dialog warns about the right thing. Both are driven through the
 * Supabase boundary — syncTenantContact itself is never mocked — so a sync
 * regression fails these rather than a stub.
 */
describe("createAppUser tenant portal + contact sync flags", () => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000001";

  /**
   * يزرع جداول المسار Tenant: البوابة تُقرأ من حمولة التحديث نفسها، والمزامنة
   * تُدار عبر سلسلة القراءة/الكتابة الحقيقية.
   *
   * The portal write is `update(...).eq(...)` awaited directly, while the
   * contact sync chains `.select("id").maybeSingle()` off the same shape — so
   * `eq` returns one object serving both: `error` for the portal check, and a
   * `select` chain for the sync. Payloads tell the two writes apart.
   */
  function stubTenantTables(options: {
    portalError: string | null;
    storedTenant: { id: string; email: string | null; whatsapp: string | null } | null;
  }) {
    const portalUpdates: Record<string, unknown>[] = [];
    const syncUpdates: Record<string, unknown>[] = [];
    mocks.from.mockImplementation((table: string) => {
      if (table === "profiles") {
        return {
          select: () => {
            const chain: Record<string, unknown> = {
              eq: () => chain,
              limit: () => Promise.resolve({ data: [], error: null }),
            };
            return chain;
          },
          upsert: () => ({ select: () => ({ single: () => Promise.resolve({ error: null }) }) }),
        };
      }
      if (table === "user_roles") {
        return { insert: () => Promise.resolve({ error: null }) };
      }
      if (table === "notifications") {
        return { select: () => ({ in: mocks.notificationStates }) };
      }
      if (table === "tenants") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () =>
                options.storedTenant
                  ? { data: options.storedTenant, error: null }
                  : { data: null, error: null },
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            if ("tenant_portal_enabled" in payload) portalUpdates.push(payload);
            else syncUpdates.push(payload);
            return {
              eq: () => {
                if ("tenant_portal_enabled" in payload) {
                  return options.portalError
                    ? { error: { message: options.portalError } }
                    : { error: null };
                }
                return {
                  error: null,
                  select: () => ({
                    maybeSingle: async () => ({ data: { id: TENANT_ID }, error: null }),
                  }),
                };
              },
            };
          },
        };
      }
      return { update: () => ({ eq: () => Promise.resolve({ error: null }) }) };
    });
    return { portalUpdates, syncUpdates };
  }

  /**
   * ينفّذ إنشاء حساب بوابة ويعيد رايتي المسار Tenant كاملتين.
   */
  async function createTenantAccount() {
    mocks.createUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } }, error: null });
    const fn = createAppUser as unknown as typeof mocks.serverFunction;
    fn.context = {
      supabase: { rpc: vi.fn().mockResolvedValue({ data: true, error: null }) },
      userId: "admin-1",
    };
    return (await fn({
      kind: "tenant",
      username: "tenant.user",
      password: "password-123",
      displayName: "Tenant User",
      email: "tenant@example.com",
      tenantId: TENANT_ID,
    })) as { tenantPortalEnabled: boolean; tenantContactSynced: boolean };
  }

  it("a refused portal-enable write reports tenantPortalEnabled false without throwing or touching the sync flag", async () => {
    // The stored email differs, so the contact sync takes its write path and
    // succeeds — tenantContactSynced must stay true while the portal flag drops.
    const { portalUpdates, syncUpdates } = stubTenantTables({
      portalError: "tenant portal update refused",
      storedTenant: { id: TENANT_ID, email: "old@example.com", whatsapp: null },
    });

    const result = await createTenantAccount();

    expect(result.tenantPortalEnabled).toBe(false);
    expect(result.tenantContactSynced).toBe(true);
    expect(portalUpdates).toEqual([{ tenant_portal_enabled: true }]);
    expect(syncUpdates).toEqual([{ email: "tenant@example.com" }]);
  });

  it("a failed contact sync reports tenantContactSynced false without throwing or touching the portal flag", async () => {
    // No stored tenant row: the sync fails on the missing record while the
    // portal write lands, so only the sync flag drops.
    const { portalUpdates, syncUpdates } = stubTenantTables({
      portalError: null,
      storedTenant: null,
    });

    const result = await createTenantAccount();

    expect(result.tenantPortalEnabled).toBe(true);
    expect(result.tenantContactSynced).toBe(false);
    expect(portalUpdates).toEqual([{ tenant_portal_enabled: true }]);
    expect(syncUpdates).toEqual([]);
  });
});
