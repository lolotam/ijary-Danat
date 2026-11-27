import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  callerRpc: vi.fn(),
  getRequest: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  createUser: vi.fn(),
  updateUserById: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: mocks.getRequest }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
    rpc: mocks.rpc,
    auth: {
      admin: {
        createUser: mocks.createUser,
        updateUserById: mocks.updateUserById,
        deleteUser: mocks.deleteUser,
      },
    },
  },
}));

import { PLATFORM_ADMIN_REQUIRED } from "./requirePlatformAdmin.server";
import { SLUG_IMMUTABLE, SLUG_INVALID, SLUG_RESERVED, SLUG_TAKEN } from "./slug";
import {
  COMPANY_NOT_FOUND,
  EMAIL_TAKEN,
  USER_NOT_FOUND,
  USERNAME_TAKEN,
} from "./companyStaffAccount";
import {
  platformCreateUser,
  platformListUsers,
  platformResetPassword,
  platformSetUserActive,
} from "./users";
import { platformCompanies as arabicMessages } from "@/i18n/locales/ar/platformCompanies";
import { platformCompanies as englishMessages } from "@/i18n/locales/en/platformCompanies";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

/** نتيجة استعلام واحدة: ما يرد به، وكم صفاً يعود. */
interface QueryOutcome {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
}

/** كتابة واحدة سجّلها الاستعلام الوهمي. */
interface RecordedWrite {
  table: string;
  method: string;
  payload?: unknown;
}

/**
 * يثبّت قاعدة بيانات وهمية: تحفظ كل كتابة وتردّ بما يحدده الاختبار.
 *
 * The responses are keyed by `table:method` — `profiles:select`,
 * `profiles:update`, `revoke_user_sessions` — because one table is read and
 * written in different shapes inside the same operation.
 */
function installFakeDatabase(responses: Record<string, QueryOutcome> = {}): {
  writes: RecordedWrite[];
} {
  const writes: RecordedWrite[] = [];
  const outcomeFor = (key: string): QueryOutcome => responses[key] ?? { data: null, error: null };

  mocks.from.mockImplementation((table: string) => {
    let writeMethod: string | null = null;

    const chain: Record<string, unknown> = {};
    const methods = [
      "select",
      "insert",
      "upsert",
      "update",
      "delete",
      "eq",
      "neq",
      "ilike",
      "in",
      "or",
      "order",
      "range",
      "limit",
      "offset",
      "is",
      "not",
      "gte",
      "gt",
      "lt",
    ];
    for (const method of methods) {
      chain[method] = vi.fn((...args: unknown[]) => {
        if (
          method === "insert" ||
          method === "upsert" ||
          method === "update" ||
          method === "delete"
        ) {
          writeMethod = method;
          writes.push({ table, method, payload: args[0] });
        }
        return chain;
      });
    }

    const result = () => {
      const outcome = outcomeFor(`${table}:${writeMethod ?? "select"}`);
      return Promise.resolve({
        data: outcome.data ?? null,
        error: outcome.error ?? null,
        count: outcome.count ?? null,
      });
    };

    chain.single = vi.fn(result);
    chain.maybeSingle = vi.fn(result);
    chain.then = (onFulfilled: unknown, onRejected: unknown) =>
      result().then(
        onFulfilled as (value: unknown) => unknown,
        onRejected as (reason: unknown) => unknown,
      );

    return chain;
  });

  mocks.rpc.mockImplementation(async (fn: string) => {
    const outcome = outcomeFor(fn);
    return { data: outcome.data ?? null, error: outcome.error ?? null };
  });

  return { writes };
}

/** يكتب الاختبار على الجدول نفسه أكثر من مرة؛ هذا يختار واحدة بعينها. */
function writeTo(
  writes: RecordedWrite[],
  table: string,
  method: string,
): RecordedWrite | undefined {
  return writes.find((write) => write.table === table && write.method === method);
}

describe("the platform refusal codes", () => {
  /**
   * كل رمز رفض ترفعه لوحة المنصة له رسالة في اللغتين.
   *
   * A code without a message renders as the raw code on screen, in the
   * super admin's face, in a panel whose whole job is to explain refusals.
   */
  const REFUSAL_CODES = [
    SLUG_INVALID,
    SLUG_RESERVED,
    SLUG_TAKEN,
    SLUG_IMMUTABLE,
    PLATFORM_ADMIN_REQUIRED,
    COMPANY_NOT_FOUND,
    USER_NOT_FOUND,
    USERNAME_TAKEN,
    EMAIL_TAKEN,
  ];

  it.each(REFUSAL_CODES)("%s is translated in both locales", (code) => {
    expect(arabicMessages[`platformCompanies.error.${code}`]).toBeTruthy();
    expect(englishMessages[`platformCompanies.error.${code}`]).toBeTruthy();
  });
});

describe("the platform account operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SUPABASE_URL", "https://supabase.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "publishable-key");

    const token = `header.${Buffer.from(
      JSON.stringify({ sub: ADMIN_ID, aal: "aal2" }),
      "utf8",
    ).toString("base64url")}.signature`;

    mocks.getRequest.mockReturnValue({
      headers: {
        get: (name: string) => (name.toLowerCase() === "authorization" ? `Bearer ${token}` : null),
      },
    });
    mocks.createClient.mockReturnValue({ rpc: mocks.callerRpc });
    mocks.callerRpc.mockResolvedValue({ data: true, error: null });
    mocks.createUser.mockImplementation(async (attributes: { id: string }) => ({
      data: { user: { id: attributes.id } },
      error: null,
    }));
    mocks.updateUserById.mockResolvedValue({ data: {}, error: null });
    mocks.deleteUser.mockResolvedValue({ data: null, error: null });
  });

  describe("platformListUsers", () => {
    it("returns the company's accounts with the roles each one holds", async () => {
      installFakeDatabase({
        "companies:select": { data: { id: COMPANY_ID } },
        "profiles:select": {
          data: [
            {
              id: USER_ID,
              display_name: "Amina",
              username: "amina",
              email: "amina@example.test",
              phone: "51234567",
              is_active: true,
              must_change_password: false,
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
          count: 1,
        },
        "user_roles:select": { data: [{ user_id: USER_ID, role: "admin" }] },
      });

      const result = await platformListUsers({ companyId: COMPANY_ID });

      expect(result.count).toBe(1);
      expect(result.rows[0]).toEqual({
        id: USER_ID,
        displayName: "Amina",
        username: "amina",
        email: "amina@example.test",
        phone: "51234567",
        isActive: true,
        mustChangePassword: false,
        roles: ["admin"],
        createdAt: "2026-01-01T00:00:00Z",
      });
    });

    it("refuses a caller that is not a platform admin before touching the database", async () => {
      installFakeDatabase();
      mocks.callerRpc.mockResolvedValue({ data: false, error: null });

      await expect(platformListUsers({ companyId: COMPANY_ID })).rejects.toThrow(
        PLATFORM_ADMIN_REQUIRED,
      );
      expect(mocks.from).not.toHaveBeenCalled();
    });
  });

  describe("platformCreateUser", () => {
    it("creates the GoTrue account, a profile that must change its password, and the role", async () => {
      const { writes } = installFakeDatabase({
        "companies:select": { data: { id: COMPANY_ID } },
      });

      const result = await platformCreateUser({
        companyId: COMPANY_ID,
        fullName: "Amina",
        username: "amina",
        email: "amina@example.test",
        role: "admin",
      });

      expect(result.userId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.tempPassword).toBeTruthy();

      expect(writeTo(writes, "profiles", "upsert")?.payload).toMatchObject({
        id: result.userId,
        company_id: COMPANY_ID,
        username: "amina",
        display_name: "Amina",
        email: "amina@example.test",
        is_active: true,
        must_change_password: true,
      });

      expect(writeTo(writes, "user_roles", "insert")?.payload).toMatchObject({
        company_id: COMPANY_ID,
        user_id: result.userId,
        role: "admin",
        granted_by: ADMIN_ID,
      });
    });

    it("writes one audit row and keeps the temporary password out of it", async () => {
      const { writes } = installFakeDatabase({
        "companies:select": { data: { id: COMPANY_ID } },
      });

      const result = await platformCreateUser({
        companyId: COMPANY_ID,
        fullName: "Amina",
        username: "amina",
        role: "readonly",
      });

      const audits = writes.filter((write) => write.table === "platform_audit_log");
      expect(audits).toHaveLength(1);
      expect(audits[0].payload).toMatchObject({
        action: "user.create",
        entity: "user",
        entity_id: result.userId,
        company_id: COMPANY_ID,
        actor_id: ADMIN_ID,
      });
      expect(JSON.stringify(audits[0].payload)).not.toContain(result.tempPassword);
    });

    it("deletes the GoTrue account when the profile cannot be written", async () => {
      installFakeDatabase({
        "companies:select": { data: { id: COMPANY_ID } },
        "profiles:upsert": { error: { message: "permission denied" } },
      });

      await expect(
        platformCreateUser({
          companyId: COMPANY_ID,
          fullName: "Amina",
          username: "amina",
          role: "admin",
        }),
      ).rejects.toThrow("profile insert failed: permission denied");

      const createdId = mocks.createUser.mock.calls[0][0].id as string;
      expect(mocks.deleteUser).toHaveBeenCalledWith(createdId);
    });
  });

  describe("platformSetUserActive", () => {
    it("bans the account, revokes its sessions and clears the profile flag", async () => {
      const { writes } = installFakeDatabase({
        "profiles:select": { data: { id: USER_ID, is_active: true } },
      });

      await platformSetUserActive({
        companyId: COMPANY_ID,
        userId: USER_ID,
        isActive: false,
      });

      expect(mocks.updateUserById).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ ban_duration: "876000h" }),
      );
      expect(mocks.rpc).toHaveBeenCalledWith("revoke_user_sessions", { _user_id: USER_ID });
      expect(writeTo(writes, "profiles", "update")?.payload).toEqual({ is_active: false });
    });

    it("writes one audit row carrying the state the account was in", async () => {
      const { writes } = installFakeDatabase({
        "profiles:select": { data: { id: USER_ID, is_active: true } },
      });

      await platformSetUserActive({
        companyId: COMPANY_ID,
        userId: USER_ID,
        isActive: false,
      });

      const audits = writes.filter((write) => write.table === "platform_audit_log");
      expect(audits).toHaveLength(1);
      expect(audits[0].payload).toMatchObject({
        action: "user.status.update",
        entity: "user",
        entity_id: USER_ID,
        company_id: COMPANY_ID,
        actor_id: ADMIN_ID,
        before: { is_active: true },
        after: { is_active: false },
      });
    });

    it("refuses an account that is not in the named company", async () => {
      installFakeDatabase({ "profiles:select": { data: null } });

      await expect(
        platformSetUserActive({
          companyId: COMPANY_ID,
          userId: USER_ID,
          isActive: false,
        }),
      ).rejects.toThrow(USER_NOT_FOUND);
    });
  });

  describe("platformResetPassword", () => {
    it("forces a password change, revokes the sessions and returns the temporary password once", async () => {
      const { writes } = installFakeDatabase({
        "profiles:select": { data: { id: USER_ID } },
      });

      const result = await platformResetPassword({
        companyId: COMPANY_ID,
        userId: USER_ID,
      });

      expect(result.tempPassword).toBeTruthy();
      expect(mocks.updateUserById).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ password: result.tempPassword }),
      );
      expect(mocks.rpc).toHaveBeenCalledWith("revoke_user_sessions", { _user_id: USER_ID });
      expect(writeTo(writes, "profiles", "update")?.payload).toEqual({
        must_change_password: true,
      });

      const audits = writes.filter((write) => write.table === "platform_audit_log");
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits[0].payload)).not.toContain(result.tempPassword);
    });

    // Security review: a sign-in with the old password between the first
    // revoke and the password change must not survive the reset.
    it("revokes the sessions again after the password has changed", async () => {
      installFakeDatabase({ "profiles:select": { data: { id: USER_ID } } });

      await platformResetPassword({ companyId: COMPANY_ID, userId: USER_ID });

      const revokeCalls = mocks.rpc.mock.calls.filter(([name]) => name === "revoke_user_sessions");
      expect(revokeCalls).toHaveLength(2);
      const passwordOrder = mocks.updateUserById.mock.invocationCallOrder.at(-1) ?? 0;
      const lastRevokeOrder = mocks.rpc.mock.invocationCallOrder.at(-1) ?? 0;
      expect(lastRevokeOrder).toBeGreaterThan(passwordOrder);
    });
  });
});
