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

import { revokeUserRole } from "./revokeUserRole";

const USER = "11111111-1111-1111-1111-111111111111";
const ADMIN = "22222222-2222-2222-2222-222222222222";

/**
 * Records every table touched, so the test can assert what was NOT touched.
 *
 * `user_roles` needs two independent chains: `select(...).eq().eq().maybeSingle()`
 * for the up-front existence check, and `delete().eq().eq()` for the final
 * deletion — the read happens first and no longer shares a call with the
 * delete, since the delete moved to last in the revoke order.
 *
 * `profiles.update(...)` chains through `.eq("id", …).not("tenant_id", "is",
 * null).select("id")`: the `.not(...)` filter is what makes `clearedTenantLink`
 * honest — matching by id alone would return the row whether or not
 * tenant_id was already null, so `tenantAlreadyLinked` controls whether the
 * mock's `.select(...)` resolves with a matched row or an empty array,
 * mirroring what that filter would actually do in Postgres.
 */
function trackTables(
  roleDeleted: { id: string } | null,
  assignmentCount: number,
  tenantAlreadyLinked = true,
) {
  const touched: string[] = [];
  mocks.from.mockImplementation((table: string) => {
    touched.push(table);
    if (table === "user_roles") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: roleDeleted, error: null }) }),
          }),
        }),
        delete: () => ({
          eq: () => ({
            eq: async () => ({ error: null }),
          }),
        }),
      };
    }
    if (table === "profiles") {
      return {
        update: () => ({
          eq: () => ({
            not: () => ({
              select: async () => ({
                data: tenantAlreadyLinked ? [{ id: "profile-1" }] : [],
                error: null,
              }),
            }),
          }),
        }),
      };
    }
    // user_tenants
    return {
      delete: () => ({
        eq: () => ({
          select: async () => ({
            data: Array.from({ length: assignmentCount }, (_, i) => ({ id: `a${i}` })),
            error: null,
          }),
        }),
      }),
    };
  });
  return touched;
}

function callRevoke(role: string, isAdmin = true) {
  const fn = revokeUserRole as unknown as typeof mocks.serverFunction;
  fn.context = {
    supabase: { rpc: vi.fn().mockResolvedValue({ data: isAdmin, error: null }) },
    userId: ADMIN,
  };
  return fn({ userId: USER, role });
}

describe("revokeUserRole", () => {
  beforeEach(() => {
    mocks.from.mockReset();
    mocks.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  });

  it("clears profiles.tenant_id and every user_tenants row when the tenant role goes", async () => {
    // The reported bug: revoking `tenant` left the linked-tenant badge at 1
    // because only the user_roles row was deleted.
    const touched = trackTables({ id: "r1" }, 1);
    await expect(callRevoke("tenant")).resolves.toEqual({
      revoked: true,
      clearedTenantLink: true,
      removedAssignments: 1,
    });
    expect(touched).toContain("profiles");
    expect(touched).toContain("user_tenants");
  });

  it("does not claim the tenant link was cleared when tenant_id was already null", async () => {
    // The reported bug: clearedTenantLink was set unconditionally after the
    // profiles update, so an account whose tenant_id was already null still
    // produced "Role revoked, and the tenant link removed (0 linked
    // tenants)" — a false claim in a branch whose thesis is that success
    // must be evidenced.
    const touched = trackTables({ id: "r1" }, 0, false);
    await expect(callRevoke("tenant")).resolves.toEqual({
      revoked: true,
      clearedTenantLink: false,
      removedAssignments: 0,
    });
    expect(touched).toContain("profiles");
  });

  it("leaves the tenant links alone when a managerial role goes", async () => {
    // An accountant who also holds `tenant` keeps their portal link when only
    // the accountant role is revoked.
    const touched = trackTables({ id: "r1" }, 0);
    await expect(callRevoke("accountant")).resolves.toEqual({
      revoked: true,
      clearedTenantLink: false,
      removedAssignments: 0,
    });
    expect(touched).not.toContain("profiles");
    expect(touched).not.toContain("user_tenants");
  });

  it("errors when the role assignment does not exist", async () => {
    // The existence check runs before any tenant link is touched — otherwise
    // a call for a role the user never had could clear real links before
    // discovering there was nothing to revoke.
    const touched = trackTables(null, 0);
    await expect(callRevoke("tenant")).rejects.toThrow(/not found/i);
    expect(touched).not.toContain("profiles");
    expect(touched).not.toContain("user_tenants");
  });

  it("rejects a non-admin with an Error, not a Response", async () => {
    trackTables({ id: "r1" }, 0);
    const error = await callRevoke("tenant", false).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(Response);
  });
});
