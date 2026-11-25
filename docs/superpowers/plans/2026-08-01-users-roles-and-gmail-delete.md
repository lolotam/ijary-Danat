# Users & Roles fixes + Gmail delete propagation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four defects in Settings → Users and Roles (stale linked-tenant count on role revocation, missing mobile field, edit form missing fields, deletion reporting success without deleting) and make deleting a Gmail inbox message move it to Trash in Gmail.

**Architecture:** Multi-step user mutations move out of the browser into admin-gated server functions running under `service_role` with a single `write_audit` entry each, following the `createAppUser` precedent. Every server function this plan touches throws `Error`, never `Response`, because a thrown `Response` resolves as success on the client (see Global Constraints). Gmail deletion becomes trash-then-delete-locally, failing closed.

**Tech Stack:** TanStack Start (React 19) server functions, Supabase JS (`supabaseAdmin` = service_role), TanStack Query, Zod, Vitest, Tailwind + shadcn/ui, manual SQL migrations in `db/migrations/`.

Spec: `docs/superpowers/specs/2026-08-01-users-roles-and-gmail-delete-design.md`
Branch: `fix/users-roles-and-gmail-delete` (already created; **never** force-push, rebase, amend or squash — the repo is Lovable-connected).

## Global Constraints

- **Never `throw new Response(...)` in any server function this plan creates or modifies.** `@tanstack/start-server-core/dist/esm/server-functions-handler.js:67-70` stamps a thrown `Response` with `x-tss-raw: true` and returns it; `@tanstack/start-client-core/dist/esm/client-rpc/serverFnFetcher.js:139` returns that response to the caller instead of throwing. The `await` resolves and the next line's `toast.success()` fires. Throw `Error` — it rejects correctly. Do **not** convert the ~20 other `src/fns/` files that use this pattern; out of scope.
- **Every server function that returns a success payload must return an explicit boolean/count, and every caller must assert on it** before showing a success toast.
- `SUPABASE_SERVICE_ROLE_KEY` is server-only. Never put a secret behind a `VITE_` prefix.
- `src/integrations/supabase/database.types.ts` is **hand-maintained** despite looking generated. Add new RPCs to it by hand. Never run `bun run gen:types` over it. (`profiles.phone` is already present in `Row`/`Insert`/`Update` there — no table change is needed for the mobile field.)
- `src/routeTree.gen.ts` is generated — never edit.
- All new user-facing strings need a key in **both** the `ar` and `en` blocks of `src/i18n/dictionary.ts`.
- Migrations are applied in filename order and must be idempotent. Next free number is **66**.
- Run `bun run lint && bun run typecheck && bun run test` before any commit that changes code.
- Commit message trailer on every commit: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## File Structure

| File                                                   | Responsibility                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| `src/fns/deleteAppUser.ts` (modify)                    | Delete an account and **prove** it is gone                          |
| `src/fns/deleteAppUser.test.ts` (create)               | Guards, verification, explicit payload                              |
| `src/fns/revokeUserRole.ts` (create)                   | Revoke a role; clear both tenant links when the role is `tenant`    |
| `src/fns/revokeUserRole.test.ts` (create)              | Link-clearing only fires for `tenant`                               |
| `db/migrations/66_find_phone_conflicts.sql` (create)   | Last-8-digit collision lookup mirroring migration 65                |
| `src/lib/phoneConflicts.server.ts` (create)            | Server-only phone normalisation + collision guard                   |
| `src/lib/phoneConflicts.test.ts` (create)              | Guard rejects short numbers and names the conflict                  |
| `src/fns/createAppUser.ts` (modify)                    | Accept and store `phone`                                            |
| `src/fns/updateAppUser.ts` (modify)                    | Accept `phone`, `role`, `tenantId`, `tenantIds`                     |
| `src/routes/admin.settings.users.tsx` (modify)         | Mobile field on both dialogs, Edit mirrors Add, assert on delete    |
| `src/hooks/useUsers.ts` (modify)                       | `useRevokeRole` calls the server fn; invalidates `user-tenants` too |
| `src/lib/gmailMessage.ts` (modify)                     | `resolveGmailId` — recover Gmail's own id                           |
| `src/lib/gmailMessage.test.ts` (modify/create)         | `resolveGmailId` cases                                              |
| `src/lib/gmailClient.server.ts` (modify)               | `GMAIL_MODIFY_SCOPE`, `grantCanModify`                              |
| `src/lib/gmailOAuthConfig.ts` (modify)                 | Add `gmail.modify` to `GMAIL_SCOPE`                                 |
| `src/fns/gmailTrashMessages.ts` (create)               | Trash in Gmail, then delete locally; fails closed                   |
| `src/fns/gmailTrashMessages.test.ts` (create)          | Refuses without scope; keeps the row when trash fails               |
| `src/hooks/useGmailMessages.ts` (modify)               | `useTrashGmailMessages` replaces `useDeleteGmailMessages`           |
| `src/routes/admin.inbox.tsx` (modify)                  | Report partial failures instead of a blanket success                |
| `src/i18n/dictionary.ts` (modify)                      | New keys, `ar` + `en`                                               |
| `src/integrations/supabase/database.types.ts` (modify) | `find_phone_conflicts` RPC signature                                |

---

### Task 1: Deletion actually deletes

**Files:**

- Modify: `src/fns/deleteAppUser.ts` (whole file)
- Modify: `src/routes/admin.settings.users.tsx:195-210` (`confirmDelete`)
- Modify: `src/i18n/dictionary.ts`
- Test: `src/fns/deleteAppUser.test.ts` (create)

**Interfaces:**

- Consumes: `requireSupabaseAuth`, `supabaseAdmin` (existing).
- Produces: `deleteAppUser` now resolves to `{ deleted: true; userId: string }`. Task 4 does not touch it.

**Diagnosis — already settled by the controller, no action needed in this task.**

The obvious repro (click delete on production and read the status code) was
rejected: if the original guard was transient, the click would now succeed and
really delete a live account. The question was answered read-only instead, on
2026-08-01:

| Check                                                         | Result      |
| ------------------------------------------------------------- | ----------- |
| `SUPABASE_PUBLISHABLE_KEY` against `/auth/v1/settings`        | 200 — valid |
| `SUPABASE_SERVICE_ROLE_KEY` against `/auth/v1/admin/users`    | 200 — valid |
| `has_role(<lolotam>, 'admin')` / `has_role(<admin>, 'admin')` | both `t`    |
| `EXECUTE` on `has_role` for `authenticated`                   | granted     |
| `DELETE /admin/users` in GoTrue, 720h                         | 0           |

So the deployed configuration does not reproduce a standing rejection, yet the
handler demonstrably never ran. The request was refused before it — a transient
`401` from `requireSupabaseAuth` (an access token that had expired in a
long-open tab is the likeliest cause) or a transient `403` — and the thrown
`Response` turned that refusal into a success toast.

The fix does not depend on which of the two it was, and this is reported to the
user as an inference, not a measurement.

- [ ] **Step 1: Write the failing test**

Create `src/fns/deleteAppUser.test.ts`. The `vi.hoisted` + `createServerFn` mock is copied from `src/fns/gmailSend.test.ts:3-36` — it is the repo's established way to call a server function's handler directly.

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- src/fns/deleteAppUser.test.ts`
Expected: FAIL — the non-admin case throws a `Response`, and the resolved value is `{ userId }` without `deleted`.

- [ ] **Step 3: Rewrite `src/fns/deleteAppUser.ts`**

```ts
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Permanently delete a user account (admin only). Admins cannot delete
 * themselves.
 *
 * Every failure path throws an `Error`, never a `Response`. TanStack Start
 * returns a thrown `Response` to the caller instead of rejecting
 * (start-server-core marks it `x-tss-raw`, start-client-core hands it back), so
 * a `throw new Response("Forbidden", { status: 403 })` here resolved the
 * caller's `await` and fired its success toast while nothing was deleted. That
 * is the bug this file exists to fix; do not reintroduce the pattern.
 *
 * The return value is deliberately `{ deleted: true }` rather than bare data:
 * the caller asserts on it, so any future path that returns something else
 * cannot be mistaken for a completed delete.
 */

const schema = z.object({ userId: z.string().uuid() });

export const deleteAppUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => schema.parse(data))
  .handler(async ({ data, context }) => {
    const roleCheck = await context.supabase.rpc("has_role" as any, {
      _user_id: context.userId,
      _role: "admin",
    });
    if (roleCheck.error || !roleCheck.data) {
      throw new Error("Only an admin may delete a user account.");
    }
    if (data.userId === context.userId) {
      throw new Error("You cannot delete your own account.");
    }

    const profile = await supabaseAdmin
      .from("profiles")
      .select("username, display_name, tenant_id")
      .eq("id", data.userId)
      .maybeSingle();

    const deleteRes = await supabaseAdmin.auth.admin.deleteUser(data.userId);
    if (deleteRes.error) throw new Error(deleteRes.error.message);

    // `profiles.id references auth.users(id) on delete cascade`, so this read
    // should find nothing. It is here because "the toast was green and the row
    // is still there" is precisely the failure being fixed — the delete is
    // confirmed rather than assumed.
    const survivor = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("id", data.userId)
      .maybeSingle();
    if (survivor.data) {
      const cleanup = await supabaseAdmin.from("profiles").delete().eq("id", data.userId);
      if (cleanup.error) {
        throw new Error(
          `The sign-in account was deleted but its profile row could not be removed: ${cleanup.error.message}`,
        );
      }
    }

    await supabaseAdmin.rpc("write_audit" as any, {
      p_action: "user.delete",
      p_entity_type: "user",
      p_entity_id: data.userId,
      p_before: profile.data ?? null,
      p_after: null,
      p_result: "success",
      p_error_code: null,
    });

    return { deleted: true as const, userId: data.userId };
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- src/fns/deleteAppUser.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Make the caller assert on the payload**

In `src/routes/admin.settings.users.tsx`, replace `confirmDelete` (currently lines 195-210) with:

```tsx
async function confirmDelete() {
  if (!deleteTarget) return;
  setDeletePending(true);
  try {
    // Asserted rather than assumed: a server function that throws a Response
    // resolves here with that Response instead of rejecting, so "it did not
    // throw" is not evidence the account is gone.
    const result = (await deleteUser({ data: { userId: deleteTarget.id } })) as
      | { deleted?: boolean }
      | undefined;
    if (!result?.deleted) throw new Error(t("users.deleteNotConfirmed"));
    toast.success(t("users.deleted"));
    setDeleteTarget(null);
    await usersQuery.refetch();
  } catch (error) {
    toast.error(t("users.actionError"), {
      description: error instanceof Error ? error.message : undefined,
    });
  } finally {
    setDeletePending(false);
  }
}
```

- [ ] **Step 6: Add the i18n key to both languages**

In `src/i18n/dictionary.ts`, add to the **Arabic** block beside `"users.deleted"`:

```ts
    "users.deleteNotConfirmed": "لم يؤكّد الخادم حذف الحساب. حدّث الصفحة وتحقّق قبل المحاولة مرة أخرى.",
```

and to the **English** block beside its `"users.deleted"`:

```ts
    "users.deleteNotConfirmed":
      "The server did not confirm the account was deleted. Refresh and check before trying again.",
```

- [ ] **Step 7: Run the gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/fns/deleteAppUser.ts src/fns/deleteAppUser.test.ts src/routes/admin.settings.users.tsx src/i18n/dictionary.ts
git commit -m "$(cat <<'EOF'
fix(users): confirm a user delete instead of assuming it

deleteAppUser signalled its guards with `throw new Response(...)`.
TanStack Start returns a thrown Response to the caller rather than
rejecting, so the guard resolved the caller's await and the success
toast fired while nothing was deleted — GoTrue logs show zero DELETE
requests in 30 days against five intact accounts.

Guards now throw Error, the handler re-reads to confirm the auth user
and profile row are gone, and the caller asserts on `{ deleted: true }`.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Revoking the tenant role clears both tenant links

**Files:**

- Create: `src/fns/revokeUserRole.ts`
- Test: `src/fns/revokeUserRole.test.ts`
- Modify: `src/hooks/useUsers.ts:68-93` (`useRevokeRole`)
- Modify: `src/routes/admin.settings.users.tsx` (`RevokeRoleDialog`, `revokeSelectedRole`, `UsersPage` wiring)
- Modify: `src/i18n/dictionary.ts`

**Interfaces:**

- Consumes: `requireSupabaseAuth`, `supabaseAdmin`, `AppRole` from `@/integrations/supabase/database.types`.
- Produces: `revokeUserRole` server fn resolving to
  `{ revoked: true; clearedTenantLink: boolean; removedAssignments: number }`.
  `useRevokeRole().mutateAsync({ userId, role })` resolves to that same object.

- [ ] **Step 1: Write the failing test**

Create `src/fns/revokeUserRole.test.ts`:

```ts
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

import { revokeUserRole } from "./revokeUserRole";

const USER = "11111111-1111-1111-1111-111111111111";
const ADMIN = "22222222-2222-2222-2222-222222222222";

/** Records every table touched, so the test can assert what was NOT touched. */
function trackTables(roleDeleted: { id: string } | null, assignmentCount: number) {
  const touched: string[] = [];
  mocks.from.mockImplementation((table: string) => {
    touched.push(table);
    if (table === "user_roles") {
      return {
        delete: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({ maybeSingle: async () => ({ data: roleDeleted, error: null }) }),
            }),
          }),
        }),
      };
    }
    if (table === "profiles") {
      return { update: () => ({ eq: async () => ({ error: null }) }) };
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
    trackTables(null, 0);
    await expect(callRevoke("tenant")).rejects.toThrow(/not found/i);
  });

  it("rejects a non-admin with an Error, not a Response", async () => {
    trackTables({ id: "r1" }, 0);
    const error = await callRevoke("tenant", false).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(Response);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- src/fns/revokeUserRole.test.ts`
Expected: FAIL — "Failed to resolve import ./revokeUserRole".

After Step 3, re-run and **read the failure messages, not just the red**. The
`trackTables` mock nests query-builder chains by hand; a chain shaped differently
from the implementation throws `x is not a function`, which looks like a failing
test while proving nothing about the behaviour. Every test here must fail for a
reason stated in its own assertion before you accept it as passing later.

- [ ] **Step 3: Create `src/fns/revokeUserRole.ts`**

```ts
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Revoke a role, and — for the `tenant` role — the tenant links that role
 * exists to serve.
 *
 * A tenant login is three rows, not one: the `user_roles` assignment, the
 * portal link `profiles.tenant_id` (which is what the portal actually reads),
 * and any `user_tenants` rows behind the "Linked tenants" count. Deleting only
 * the first left an account with no tenant role still linked to a tenant and
 * still counted, which is what was reported.
 *
 * This runs server-side under service_role rather than as three browser writes
 * because three sequential RLS'd writes have no transaction: a failure between
 * them produces exactly the inconsistent state being fixed.
 *
 * Revoking a managerial role deliberately touches neither link — an accountant
 * who also holds `tenant` keeps their portal access.
 */

const schema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["admin", "accountant", "collector", "readonly", "tenant"]),
});

export const revokeUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => schema.parse(data))
  .handler(async ({ data, context }) => {
    // Errors are thrown as `Error`, never `Response`: TanStack Start returns a
    // thrown Response to the caller instead of rejecting it.
    const permission = await context.supabase.rpc("has_permission" as any, {
      _code: "users.delete",
      _user_id: context.userId,
    });
    if (permission.error || !permission.data) {
      throw new Error("You do not have permission to revoke roles.");
    }

    const revoked = await supabaseAdmin
      .from("user_roles")
      .delete()
      .eq("user_id", data.userId)
      .eq("role", data.role)
      .select("id")
      .maybeSingle();
    if (revoked.error) throw new Error(revoked.error.message);
    if (!revoked.data) throw new Error("Role assignment was not found or cannot be revoked.");

    let clearedTenantLink = false;
    let removedAssignments = 0;

    if (data.role === "tenant") {
      const unlink = await supabaseAdmin
        .from("profiles")
        .update({ tenant_id: null } as any)
        .eq("id", data.userId);
      if (unlink.error) throw new Error(unlink.error.message);
      clearedTenantLink = true;

      const assignments = await supabaseAdmin
        .from("user_tenants" as any)
        .delete()
        .eq("user_id", data.userId)
        .select("id");
      if (assignments.error) throw new Error(assignments.error.message);
      removedAssignments = (assignments.data as unknown as unknown[] | null)?.length ?? 0;
    }

    await supabaseAdmin.rpc("write_audit" as any, {
      p_action: "user.role.revoke",
      p_entity_type: "user",
      p_entity_id: data.userId,
      p_before: { role: data.role },
      p_after: { cleared_tenant_link: clearedTenantLink, removed_assignments: removedAssignments },
      p_result: "success",
      p_error_code: null,
    });

    return { revoked: true as const, clearedTenantLink, removedAssignments };
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- src/fns/revokeUserRole.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Point `useRevokeRole` at the server function**

In `src/hooks/useUsers.ts`, add to the imports at the top:

```ts
import { useServerFn } from "@tanstack/react-start";

import { revokeUserRole } from "@/fns/revokeUserRole";
```

Replace the whole `useRevokeRole` function (currently lines 68-93) with:

```ts
/**
 * Revokes a role. Revoking `tenant` also clears `profiles.tenant_id` and the
 * user's `user_tenants` rows — see src/fns/revokeUserRole.ts for why that
 * happens server-side.
 *
 * Both query keys are invalidated. `user-tenants` backs the "Linked tenants"
 * count, and leaving it stale would keep showing the old number even once the
 * database is right.
 */
export function useRevokeRole() {
  const queryClient = useQueryClient();
  const revoke = useServerFn(revokeUserRole);

  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: AppRole }) => {
      const result = (await revoke({ data: { userId, role } })) as
        | { revoked?: boolean; clearedTenantLink?: boolean; removedAssignments?: number }
        | undefined;
      if (!result?.revoked) throw new Error("The server did not confirm the role was revoked.");
      return {
        clearedTenantLink: Boolean(result.clearedTenantLink),
        removedAssignments: result.removedAssignments ?? 0,
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users-with-roles"] });
      queryClient.invalidateQueries({ queryKey: ["user-tenants"] });
    },
  });
}
```

The `logAuditForCurrentSession` call is dropped because the server function now
writes the audit entry with `write_audit`. If `logAuditForCurrentSession` is no
longer imported anywhere in this file, remove its import — `bun run lint` will
flag it otherwise.

- [ ] **Step 6: Tell the admin what else the revoke removes**

In `src/routes/admin.settings.users.tsx`:

Extend the `RevokeTarget` interface (currently lines 81-84) so the dialog can
describe the consequences:

```tsx
interface RevokeTarget {
  userId: string;
  role: AppRole;
  /** Linked tenant count at the moment the dialog opened, for the warning. */
  assignedCount: number;
  /** Whether `profiles.tenant_id` is set, for the warning. */
  hasPortalLink: boolean;
}
```

In `UsersTable`, the revoke button (currently lines 459-468) must pass the new
fields. Replace its `onClick` with:

```tsx
                          onClick={() =>
                            requestRevoke({
                              userId: profile.id,
                              role,
                              assignedCount: assignedTenants?.get(profile.id)?.length ?? 0,
                              hasPortalLink: profile.tenant_id != null,
                            })
                          }
```

`UsersTable` already receives `assignedTenants`, but the tenants tab passes
`assignedTenants={undefined}` (line 284) — that is fine, the count falls back
to 0 and the warning simply omits the assignment clause.

Replace the body of `RevokeRoleDialog` (currently lines 635-663) with:

```tsx
function RevokeRoleDialog({
  target,
  pending,
  close,
  revokeSelectedRole,
}: {
  target: RevokeTarget | null;
  pending: boolean;
  close: () => void;
  revokeSelectedRole: () => Promise<void>;
}) {
  const { t } = useI18n();
  // Only the tenant role carries links, so only it gets the extra warning.
  const showsTenantWarning =
    target?.role === "tenant" && (target.hasPortalLink || target.assignedCount > 0);
  return (
    <AlertDialog open={Boolean(target)} onOpenChange={(open) => !open && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("users.revokeTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("users.revokeDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        {showsTenantWarning && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            {t("users.revokeTenantWarning").replace("{count}", String(target!.assignedCount))}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={revokeSelectedRole}>
            {pending ? t("common.loading") : t("users.revoke")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

Replace `revokeSelectedRole` (currently lines 173-184) with:

```tsx
async function revokeSelectedRole() {
  if (!revokeTarget) return;
  try {
    const result = await revokeRole.mutateAsync({
      userId: revokeTarget.userId,
      role: revokeTarget.role,
    });
    toast.success(
      result.clearedTenantLink
        ? t("users.roleRevokedWithLinks").replace("{count}", String(result.removedAssignments))
        : t("users.roleRevoked"),
    );
    setRevokeTarget(null);
  } catch (error) {
    toast.error(t("users.actionError"), {
      description: error instanceof Error ? error.message : undefined,
    });
  }
}
```

- [ ] **Step 7: Add the i18n keys to both languages**

Arabic block, beside `"users.roleRevoked"`:

```ts
    "users.roleRevokedWithLinks": "تم سحب الدور وإزالة ربط المستأجر ({count} مستأجر مرتبط).",
    "users.revokeTenantWarning":
      "سيؤدي سحب دور المستأجر أيضًا إلى إلغاء ربط حساب البوابة وإزالة {count} من المستأجرين المرتبطين، وسيختفي المستخدم من تبويب مستخدمي بوابة المستأجرين.",
```

English block, beside its `"users.roleRevoked"`:

```ts
    "users.roleRevokedWithLinks":
      "Role revoked, and the tenant link removed ({count} linked tenants).",
    "users.revokeTenantWarning":
      "Revoking the tenant role also unlinks the portal account and removes {count} linked tenants. The user will disappear from the Tenant portal users tab.",
```

- [ ] **Step 8: Run the gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/fns/revokeUserRole.ts src/fns/revokeUserRole.test.ts src/hooks/useUsers.ts src/routes/admin.settings.users.tsx src/i18n/dictionary.ts
git commit -m "$(cat <<'EOF'
fix(users): revoking the tenant role clears the tenant links too

A tenant login is three rows — the user_roles assignment, the portal
link profiles.tenant_id, and the user_tenants rows behind the "Linked
tenants" count. Revocation deleted only the first, leaving an account
with no tenant role still linked and still counted.

Revocation moves into an admin-gated server function so all three are
cleared under one service_role call with one audit entry, and the
confirm dialog now names what else it will remove.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Mobile number — migration, collision guard, server functions

**Files:**

- Create: `db/migrations/66_find_phone_conflicts.sql`
- Create: `src/lib/phoneConflicts.server.ts`
- Test: `src/lib/phoneConflicts.test.ts`
- Modify: `src/integrations/supabase/database.types.ts`
- Modify: `src/fns/createAppUser.ts`
- Modify: `src/fns/updateAppUser.ts`

**Interfaces:**

- Consumes: `nationalPhoneDigits` from `@/auth/loginIdentity` (existing, returns the last 8 digits or `null`).
- Produces:
  - SQL `public.find_phone_conflicts(_digits text, _exclude_profile uuid)` → rows of `(kind text, id uuid, label text)` where `kind` is `'profile'` or `'tenant'`.
  - `normalisePhoneForSave(phone: string | null | undefined, excludeProfileId: string | null): Promise<string | null>` — returns the trimmed number to store, `null` when blank, throws on a too-short number or a collision.
- Task 4 calls `normalisePhoneForSave` indirectly through `createAppUser` / `updateAppUser`; it does not import it.

- [ ] **Step 1: Write the migration**

Create `db/migrations/66_find_phone_conflicts.sql`:

```sql
-- 66_find_phone_conflicts.sql
--
-- Guards the mobile-number fields added to the user forms.
--
-- Sign-in by mobile (src/fns/signInWithIdentifier.ts) resolves an identifier by
-- comparing the LAST 8 DIGITS — the Kuwaiti subscriber number — across
-- profiles.phone and, via profiles.tenant_id, tenants.mobile. It then refuses
-- when more than one profile matches, because picking one would mean checking a
-- password against an account the person may not own.
--
-- So a number saved on one account can silently disable mobile login for
-- another. This function is how the save path refuses that, and it mirrors
-- migration 65's digits-only projection exactly. Any looser comparison would
-- admit values login cannot resolve; any stricter one would reject values that
-- are fine.
--
-- Two conflict kinds are reported:
--
--   'profile' — another profile already resolves from these digits. This is a
--               live collision: mobile login is broken for both today.
--   'tenant'  — a tenant carries this mobile but has no portal account yet. Not
--               a collision now, but a tenant's mobile is the number most likely
--               to be typed onto a managerial account by mistake, and the
--               collision would surface much later, when that portal login is
--               created. Reported so it can be refused at the point of entry.
--
-- The tenant branch is skipped whenever the tenant already has any profile: the
-- profile branch has that case, and it is the branch that applies _exclude_profile.
-- That exclusion is what lets a tenant-portal user keep their own tenant's number.
--
-- SECURITY DEFINER and service_role-only EXECUTE, matching migration 65: this
-- maps phone numbers onto account names, which no signed-in tenant and no
-- visitor has any business doing.
create or replace function public.find_phone_conflicts(_digits text, _exclude_profile uuid)
returns table (kind text, id uuid, label text)
language sql
security definer
set search_path = public
stable
as $$
  select
    'profile'::text,
    p.id,
    coalesce(p.display_name, p.username::text, p.email::text)
  from public.profiles p
  left join public.tenants t on t.id = p.tenant_id
  where
    (_exclude_profile is null or p.id <> _exclude_profile)
    and (
      (
        p.phone is not null
        and length(regexp_replace(p.phone, '\D', '', 'g')) >= 8
        and right(regexp_replace(p.phone, '\D', '', 'g'), 8) = right(_digits, 8)
      )
      or (
        t.mobile is not null
        and length(regexp_replace(t.mobile, '\D', '', 'g')) >= 8
        and right(regexp_replace(t.mobile, '\D', '', 'g'), 8) = right(_digits, 8)
      )
    )

  union all

  select
    'tenant'::text,
    t.id,
    t.name
  from public.tenants t
  where
    t.mobile is not null
    and length(regexp_replace(t.mobile, '\D', '', 'g')) >= 8
    and right(regexp_replace(t.mobile, '\D', '', 'g'), 8) = right(_digits, 8)
    and not exists (select 1 from public.profiles p where p.tenant_id = t.id)

  -- The caller only ever names the first conflict; a bounded result keeps a
  -- badly-typed digit string from scanning out a whole table into the response.
  limit 10;
$$;

revoke all on function public.find_phone_conflicts(text, uuid) from public;
revoke all on function public.find_phone_conflicts(text, uuid) from anon;
revoke all on function public.find_phone_conflicts(text, uuid) from authenticated;
grant execute on function public.find_phone_conflicts(text, uuid) to service_role;
```

- [ ] **Step 2: Verify the migration builds a clean database**

Run: `bun run test:db`
Expected: completes without error (it applies `db/migrations/` in filename order to a fresh Postgres in Docker).

Then confirm the function exists and behaves, against that test database:

Run: `bun run test:sql`
Expected: passes.

- [ ] **Step 3: Add the RPC to the hand-maintained types**

In `src/integrations/supabase/database.types.ts`, insert immediately **before**
the existing `find_profiles_by_phone_digits` entry (around line 1357), keeping
the block alphabetically ordered:

```ts
find_phone_conflicts: {
  Args: {
    _digits: string;
    _exclude_profile: string | null;
  }
  Returns: {
    kind: string;
    id: string;
    label: string | null;
  }
  [];
}
```

Do not regenerate this file. It is hand-maintained and `bun run gen:types`
writes a different, reference-only file.

- [ ] **Step 4: Write the failing test for the guard**

Create `src/lib/phoneConflicts.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import { normalisePhoneForSave } from "./phoneConflicts.server";

describe("normalisePhoneForSave", () => {
  beforeEach(() => {
    mocks.rpc.mockReset().mockResolvedValue({ data: [], error: null });
  });

  it("treats a blank number as no number and does not query", async () => {
    await expect(normalisePhoneForSave("   ", null)).resolves.toBeNull();
    await expect(normalisePhoneForSave(undefined, null)).resolves.toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects a number too short for sign-in to resolve", async () => {
    // Login compares the last 8 digits. Anything shorter can never match, so
    // storing it would look saved and never work.
    await expect(normalisePhoneForSave("5123", null)).rejects.toThrow(/8 digits/);
  });

  it("searches on the last 8 digits regardless of the format typed", async () => {
    await normalisePhoneForSave("+965 5123 4567", "user-1");
    expect(mocks.rpc).toHaveBeenCalledWith("find_phone_conflicts", {
      _digits: "51234567",
      _exclude_profile: "user-1",
    });
  });

  it("stores the number as typed once it clears", async () => {
    await expect(normalisePhoneForSave("  +965 5123 4567 ", null)).resolves.toBe("+965 5123 4567");
  });

  it("names the conflicting account when another profile already has the number", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ kind: "profile", id: "other", label: "Waleed" }],
      error: null,
    });
    await expect(normalisePhoneForSave("51234567", null)).rejects.toThrow(/Waleed/);
  });

  it("names the tenant when the number belongs to one with no portal account yet", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ kind: "tenant", id: "t1", label: "شركة الخليج" }],
      error: null,
    });
    await expect(normalisePhoneForSave("51234567", null)).rejects.toThrow(/شركة الخليج/);
  });

  it("surfaces a lookup failure instead of saving unchecked", async () => {
    // Failing open here would let the collision through, which is the outcome
    // the check exists to prevent.
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "nope" } });
    await expect(normalisePhoneForSave("51234567", null)).rejects.toThrow(/nope/);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `bun run test -- src/lib/phoneConflicts.test.ts`
Expected: FAIL — "Failed to resolve import ./phoneConflicts.server".

- [ ] **Step 6: Create `src/lib/phoneConflicts.server.ts`**

```ts
import { nationalPhoneDigits } from "@/auth/loginIdentity";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Validates a mobile number before it is stored on a profile.
 *
 * Server-only: it calls `find_phone_conflicts`, whose EXECUTE is granted to
 * service_role alone because it maps phone numbers onto account names.
 *
 * Two failures are refused here rather than discovered at the login screen:
 *
 * - A number with fewer than 8 digits. Sign-in resolves an identifier on the
 *   last 8 digits, so a shorter value can never match — it would look saved and
 *   silently never work.
 * - A number that collides with another account. Sign-in refuses when more than
 *   one profile matches, so saving a duplicate disables mobile login for both
 *   parties, and the symptom ("invalid credentials") points nowhere near the
 *   cause.
 *
 * Returns the number to store — trimmed, otherwise exactly as typed. It is
 * deliberately not reformatted: `profiles.phone` is free text that people read,
 * and the matching happens over a digits-only projection anyway.
 */
export async function normalisePhoneForSave(
  phone: string | null | undefined,
  excludeProfileId: string | null,
): Promise<string | null> {
  const trimmed = (phone ?? "").trim();
  if (!trimmed) return null;

  const digits = nationalPhoneDigits(trimmed);
  if (!digits) {
    throw new Error(
      "A mobile number needs at least 8 digits — sign-in matches the last 8, so a shorter number can never be used to log in.",
    );
  }

  const { data, error } = await supabaseAdmin.rpc("find_phone_conflicts", {
    _digits: digits,
    _exclude_profile: excludeProfileId,
  });
  if (error) throw new Error(`Could not check the mobile number: ${error.message}`);

  const conflicts = (data ?? []) as Array<{ kind: string; id: string; label: string | null }>;
  const conflict = conflicts[0];
  if (!conflict) return trimmed;

  const who = conflict.label ?? conflict.id;
  throw new Error(
    conflict.kind === "tenant"
      ? `This mobile number is already recorded for the tenant "${who}". Sign-in matches the last 8 digits, so reusing it would break mobile login for both once that tenant gets a portal account.`
      : `This mobile number is already used by "${who}". Sign-in matches the last 8 digits, so it has to be unique.`,
  );
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun run test -- src/lib/phoneConflicts.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 8: Accept `phone` in `createAppUser`**

In `src/fns/createAppUser.ts`:

Add the import beside the existing ones:

```ts
import { normalisePhoneForSave } from "@/lib/phoneConflicts.server";
```

Add to `schema` (after the `email` line):

```ts
  phone: z.string().trim().max(32).optional().nullable(),
```

Immediately after the `if (data.kind === "managerial" && !data.role)` guard, add:

```ts
// Checked before the auth user is created: a collision found afterwards
// would mean rolling back an account that already exists.
const phone = await normalisePhoneForSave(data.phone, null);
```

In the `profiles` upsert object, add `phone,` after the `email,` line:

```ts
        email,
        phone,
```

- [ ] **Step 9: Accept `phone` in `updateAppUser`**

In `src/fns/updateAppUser.ts`:

Add the import:

```ts
import { normalisePhoneForSave } from "@/lib/phoneConflicts.server";
```

Add to `schema`:

```ts
  phone: z.string().trim().max(32).optional().nullable(),
```

After the admin `roleCheck` block and before `authEmail` is computed, add:

```ts
// `undefined` means "the form did not send this field"; an empty string
// means "the admin cleared it". Only the second should null the column.
const phone =
  data.phone === undefined ? undefined : await normalisePhoneForSave(data.phone, data.userId);
```

In the `profileUpdates` block, after the `if (authEmail)` line, add:

```ts
if (phone !== undefined) profileUpdates.phone = phone;
```

Add `phone: phone ?? null,` to the `p_after` object of the `write_audit` call.

- [ ] **Step 10: Run the gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add db/migrations/66_find_phone_conflicts.sql src/lib/phoneConflicts.server.ts src/lib/phoneConflicts.test.ts src/integrations/supabase/database.types.ts src/fns/createAppUser.ts src/fns/updateAppUser.ts
git commit -m "$(cat <<'EOF'
feat(users): store a mobile number, and refuse one that breaks login

Sign-in by mobile resolves an account on the last 8 digits and refuses
when two profiles match, so an unguarded number field can silently
disable mobile login for two people at once.

Migration 66 adds find_phone_conflicts, mirroring migration 65's
digits-only projection so the save path refuses exactly what login
cannot resolve — including a tenant's mobile that has no portal account
yet, which would otherwise collide months later.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Mobile field on the Add form, and an Edit form that matches it

**Files:**

- Modify: `src/fns/updateAppUser.ts` (role and tenant links)
- Modify: `src/routes/admin.settings.users.tsx` (`CreateUserDialog`, `EditUserDialog`, wiring)
- Modify: `src/i18n/dictionary.ts`

**Interfaces:**

- Consumes: `normalisePhoneForSave` (Task 3, already wired into `updateAppUser`), `useUserTenants` (existing, `Map<string, string[]>`), `TenantMultiSelect` (existing).
- Produces: `updateAppUser` accepts `{ userId, username?, displayName?, email?, phone?, password?, role?, tenantId?, tenantIds? }` and resolves to `{ updated: true; userId: string }`.

- [ ] **Step 1: Extend `updateAppUser` with role and tenant links**

In `src/fns/updateAppUser.ts`, add to `schema`:

```ts
  /** The user's managerial role. Swapped, never merged — see the handler. */
  role: z.enum(["admin", "accountant", "collector", "readonly"]).optional().nullable(),
  /** Portal link for a tenant account (`profiles.tenant_id`). */
  tenantId: z.string().uuid().optional().nullable(),
  /** Managerial multi-tenant switcher rows (`user_tenants`). */
  tenantIds: z.array(z.string().uuid()).optional(),
```

Replace the **whole** `profileUpdates` block with the following. This is the
complete final block including the `phone` line Task 3 Step 9 already added — do
not splice, replace from `const profileUpdates` down to the closing brace of the
`if (Object.keys(...))` statement:

```ts
const profileUpdates: Record<string, string | null> = {};
if (data.username) profileUpdates.username = data.username;
if (data.displayName) profileUpdates.display_name = data.displayName;
if (authEmail) profileUpdates.email = authEmail;
if (phone !== undefined) profileUpdates.phone = phone;
// `undefined` means the form did not send the field; `null` means the admin
// cleared the portal link, and only the second should write.
if (data.tenantId !== undefined) profileUpdates.tenant_id = data.tenantId;
if (Object.keys(profileUpdates).length) {
  const profileRes = await supabaseAdmin
    .from("profiles")
    .update(profileUpdates as any)
    .eq("id", data.userId);
  if (profileRes.error) throw new Error(profileRes.error.message);
}
```

After the `profileUpdates` write block and before the `write_audit` call, add:

```ts
/*
 * Role changes swap the *managerial* role only.
 *
 * A user can hold several roles at once — an accountant who also holds
 * `tenant` is a real shape in this database. Treating the form's single
 * select as the whole truth would delete the tenant role on every save, and
 * with it the portal access that role represents. So the swap is scoped to
 * the managerial roles and `tenant` is left to the grant/revoke controls,
 * which are the only things that should ever touch it.
 */
if (data.role) {
  const existing = await supabaseAdmin.from("user_roles").select("role").eq("user_id", data.userId);
  if (existing.error) throw new Error(existing.error.message);

  const managerial = (existing.data ?? [])
    .map((row) => row.role as string)
    .filter((role) => role !== "tenant");

  if (!managerial.includes(data.role)) {
    if (managerial.length) {
      const dropped = await supabaseAdmin
        .from("user_roles")
        .delete()
        .eq("user_id", data.userId)
        .in("role", managerial as any);
      if (dropped.error) throw new Error(dropped.error.message);
    }
    const granted = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: data.userId, role: data.role, granted_by: context.userId } as any);
    if (granted.error) throw new Error(granted.error.message);
  }
}

// Replace rather than diff: the lists are small and a full replace lands on
// the same result whatever the previous state was.
if (data.tenantIds !== undefined) {
  const cleared = await supabaseAdmin
    .from("user_tenants" as any)
    .delete()
    .eq("user_id", data.userId);
  if (cleared.error) throw new Error(cleared.error.message);

  if (data.tenantIds.length) {
    const linked = await supabaseAdmin.from("user_tenants" as any).insert(
      data.tenantIds.map((tenantId) => ({
        user_id: data.userId,
        tenant_id: tenantId,
        created_by: context.userId,
      })) as any,
    );
    if (linked.error) throw new Error(linked.error.message);
  }
}
```

Replace the admin guard's `throw new Response("Forbidden", { status: 403 })`
(line 36) with:

```ts
throw new Error("Only an admin may update a user account.");
```

Extend the `p_after` object of `write_audit` with:

```ts
        role: data.role ?? null,
        tenant_id: data.tenantId ?? null,
        tenant_ids: data.tenantIds ?? null,
```

Change the final `return` to:

```ts
return { updated: true as const, userId: data.userId };
```

Do the same `Response` → `Error` swap in `src/fns/createAppUser.ts` line 44:

```ts
throw new Error("Only an admin may create a user account.");
```

- [ ] **Step 2: Run the gates on the server change alone**

Run: `bun run typecheck && bun run test`
Expected: pass. (`createAppUser.test.ts` exists — if it asserts on a thrown
`Response`, update that assertion to `Error`.)

- [ ] **Step 3: Add the mobile field to `CreateUserDialog`**

In `src/routes/admin.settings.users.tsx`, inside `CreateUserDialog`:

Add the state beside the others (after `const [email, setEmail] = useState("");`):

```tsx
const [phone, setPhone] = useState("");
```

Add `setPhone("");` to `reset()`.

Add `phone` to both `createUser` payloads — the tenant branch and the
managerial branch:

```tsx
            kind: "tenant",
            username,
            password,
            displayName,
            email,
            phone,
            tenantId: tenantIds[0],
```

```tsx
          data: { kind: "managerial", username, password, displayName, email, phone, role },
```

Add the field to the form, immediately after the email field's `</div>`:

```tsx
<div className="grid gap-1.5">
  <Label>{t("users.mobile")}</Label>
  <Input
    type="tel"
    inputMode="tel"
    dir="ltr"
    value={phone}
    onChange={(e) => setPhone(e.target.value)}
    placeholder="+965 5123 4567"
  />
  <p className="text-xs text-muted-foreground">{t("users.mobileHint")}</p>
</div>
```

- [ ] **Step 4: Rewrite `EditUserDialog` to mirror the Add form**

Replace the whole `EditUserDialog` function (currently lines 873-989) with:

```tsx
/**
 * Edits an existing account.
 *
 * Deliberately the same fields, in the same order, as CreateUserDialog — an
 * edit form that can set less than the create form leaves fields that can only
 * ever be set once, which is how accounts ended up with no mobile number.
 *
 * The one field that is not a straight copy is the role. The create form grants
 * exactly one role; a real account can hold several, and `accountant` + `tenant`
 * together is a shape this database already contains. A plain single select
 * would drop the second role on every save, so this one edits the *managerial*
 * role and leaves `tenant` to the role badges and the grant dialog.
 *
 * For the same reason the tenant selector edits one list, not both: a tenant
 * account's single portal link, or a managerial account's assignments. An
 * account holding both keeps its `user_tenants` rows untouched here; they are
 * edited from the Assign tenants dialog.
 */
function EditUserDialog({
  user,
  assignedTenantIds,
  canAssignTenants,
  close,
  updateUser,
  refresh,
}: {
  user: UserWithRoles | null;
  /** Current `user_tenants` links for this user. */
  assignedTenantIds: string[];
  canAssignTenants: boolean;
  close: () => void;
  updateUser: (input: { data: any }) => Promise<any>;
  refresh: () => void;
}) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Exclude<AppRole, "tenant">>("readonly");
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);

  // A tenant account is one that holds the role or carries the portal link —
  // the two are not always in step, which is what the revoke fix addresses.
  const isTenant = Boolean(user && (user.roles.includes("tenant") || user.tenant_id != null));

  useEffect(() => {
    if (!user) return;
    setUsername(user.username ?? "");
    setDisplayName(user.display_name ?? "");
    setEmail(user.email?.endsWith("@users.local") ? "" : (user.email ?? ""));
    setPhone(user.phone ?? "");
    setPassword("");
    const managerial = user.roles.find((r) => r !== "tenant") as
      | Exclude<AppRole, "tenant">
      | undefined;
    setRole(managerial ?? "readonly");
    // A tenant account edits its single portal link; a managerial account edits
    // its user_tenants assignments. An account carrying both — `accountant` +
    // `tenant`, which exists in this database — is treated as a tenant account
    // here and its user_tenants rows are left untouched, because the two lists
    // mean different things and one selector cannot honestly edit both.
    setTenantIds(isTenant ? (user.tenant_id ? [user.tenant_id] : []) : assignedTenantIds);
  }, [user, assignedTenantIds, isTenant]);

  async function submit() {
    if (!user) return;
    if (!username || !displayName) {
      toast.error(t("users.fillRequired"));
      return;
    }
    if (isTenant && tenantIds.length !== 1) {
      toast.error(t("users.pickTenant"));
      return;
    }
    setPending(true);
    try {
      const result = (await updateUser({
        data: {
          userId: user.id,
          username,
          displayName,
          email: email || undefined,
          // "" clears the column; undefined would leave it untouched, and the
          // admin who emptied the box means the first.
          phone,
          password: password || undefined,
          // A tenant account's role is not editable here; changing it belongs
          // to the role badges, which know about the tenant links.
          ...(isTenant ? {} : { role }),
          ...(isTenant ? { tenantId: tenantIds[0] } : canAssignTenants ? { tenantIds } : {}),
        },
      })) as { updated?: boolean } | undefined;
      if (!result?.updated) throw new Error(t("users.updateNotConfirmed"));
      toast.success(t("users.updated"));
      refresh();
      close();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  function genPassword() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    const randomValues = new Uint32Array(16);
    crypto.getRandomValues(randomValues);
    let out = "";
    for (let i = 0; i < randomValues.length; i += 1) out += chars[randomValues[i] % chars.length];
    setPassword(out);
  }

  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[90vh] max-w-lg flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="size-4" />
            {t("users.editUser")}
          </DialogTitle>
          <DialogDescription>{user?.display_name ?? user?.username}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>{t("users.username")}</Label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>{t("users.displayName")}</Label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>{t("users.email")}</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>{t("users.mobile")}</Label>
            <Input
              type="tel"
              inputMode="tel"
              dir="ltr"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+965 5123 4567"
            />
            <p className="text-xs text-muted-foreground">{t("users.mobileHint")}</p>
          </div>
          <div className="grid gap-1.5">
            <Label className="flex items-center justify-between">
              <span>{t("users.newPassword")}</span>
              <Button size="sm" variant="ghost" type="button" onClick={genPassword}>
                <KeyRound className="me-1 size-3" />
                {t("users.generate")}
              </Button>
            </Label>
            <Input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("users.passwordKeepHint")}
            />
          </div>

          {!isTenant && (
            <div className="grid gap-1.5">
              <Label>{t("users.role")}</Label>
              <Select value={role} onValueChange={(v) => setRole(v as any)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MANAGERIAL_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`roles.${r}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("users.roleEditHint")}</p>
            </div>
          )}

          {(canAssignTenants || isTenant) && (
            <div className="grid gap-1.5 rounded-lg border bg-muted/30 p-3">
              <Label>{isTenant ? t("users.linkedTenant") : t("users.assignTenants")}</Label>
              <p className="text-xs text-muted-foreground">
                {isTenant ? t("users.linkedTenantHint") : t("users.assignTenantsHint")}
              </p>
              <TenantMultiSelect
                selected={tenantIds}
                onChange={(ids) => setTenantIds(isTenant ? ids.slice(-1) : ids)}
                enabled={Boolean(user)}
                includeInactive
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={pending} onClick={submit}>
            {pending ? t("common.loading") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: Pass the new props at the call site**

In `UsersPage`, replace the `<EditUserDialog … />` element (currently lines
316-321) with:

```tsx
<EditUserDialog
  user={editTarget}
  assignedTenantIds={editTarget ? (userTenantsQuery.data?.get(editTarget.id) ?? []) : []}
  canAssignTenants={canAssignTenants}
  close={() => setEditTarget(null)}
  updateUser={updateUser as any}
  refresh={() => {
    usersQuery.refetch();
    userTenantsQuery.refetch();
  }}
/>
```

- [ ] **Step 6: Add the i18n keys to both languages**

Arabic block, beside `"users.password"`:

```ts
    "users.mobile": "رقم الجوال / واتساب",
    "users.mobileHint": "يمكن استخدام هذا الرقم لتسجيل الدخول. يجب ألا يقل عن ٨ أرقام وأن يكون غير مكرر.",
    "users.roleEditHint": "يغيّر هذا الدور الإداري فقط؛ يُدار دور المستأجر من شارات الأدوار في الجدول.",
    "users.updateNotConfirmed": "لم يؤكّد الخادم حفظ التعديلات. حدّث الصفحة وتحقّق قبل المحاولة مرة أخرى.",
```

English block, beside its `"users.password"`:

```ts
    "users.mobile": "Mobile / WhatsApp number",
    "users.mobileHint":
      "Can be used to sign in. At least 8 digits, and not already used by another account.",
    "users.roleEditHint":
      "Changes the managerial role only — the tenant role is managed from the role badges in the table.",
    "users.updateNotConfirmed":
      "The server did not confirm the changes were saved. Refresh and check before trying again.",
```

- [ ] **Step 7: Run the gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/fns/updateAppUser.ts src/fns/createAppUser.ts src/routes/admin.settings.users.tsx src/i18n/dictionary.ts
git commit -m "$(cat <<'EOF'
feat(users): mobile number on both forms, and an edit form that matches

The add form captured no mobile number, so login by mobile could never
work for a managerial account, and the edit form carried four of the
seven fields — leaving several settable only at creation time.

Edit now mirrors add field for field. The role select is scoped to the
managerial role: an account can hold `accountant` and `tenant` at once,
and treating one select as the whole truth would drop the tenant role,
and its portal access, on every save.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Deleting an inbox message moves it to Trash in Gmail

**Files:**

- Modify: `src/lib/gmailOAuthConfig.ts:9-23`
- Modify: `src/lib/gmailClient.server.ts`
- Modify: `src/lib/gmailMessage.ts`
- Test: `src/lib/gmailMessage.test.ts` (exists — append to it)
- Create: `src/fns/gmailTrashMessages.ts`
- Test: `src/fns/gmailTrashMessages.test.ts`
- Modify: `src/hooks/useGmailMessages.ts:56-66`
- Modify: `src/routes/admin.inbox.tsx` (import at line 54, `deleteGmail` at 135, `confirmDeleteGmail` at 294-307, dialog `pending` at 1030)
- Modify: `src/i18n/dictionary.ts`

**Interfaces:**

- Consumes: `readGmailGrant`, `getGmailAccessToken`, `GMAIL_API`, `describeGmailApiError` (all existing in `src/lib/gmailClient.server.ts`).
- Produces:
  - `GMAIL_MODIFY_SCOPE: string` and `grantCanModify(scope: string | null): boolean` in `src/lib/gmailClient.server.ts`.
  - `resolveGmailId(row: { message_id: string; raw_payload: unknown }): string | null` in `src/lib/gmailMessage.ts`.
  - `gmailTrashMessages` server fn resolving to `{ trashed: number; failed: Array<{ id: string; reason: string }> }`.
  - `useTrashGmailMessages()` returning a mutation whose `mutateAsync(ids: string[])` resolves to that same object.

- [ ] **Step 1: Add the scope**

In `src/lib/gmailOAuthConfig.ts`, replace the `GMAIL_SCOPE` block and its
comment (lines 9-23) with:

```ts
/**
 * Read the mailbox, send as it, and modify it.
 *
 * `gmail.modify` was added on 2026-08-01 so that deleting a message in the app
 * moves it to Trash in Gmail. Without it, a delete removed only the local row
 * and the next sync tick pulled the same message straight back in.
 *
 * Trash, not permanent delete: `modify` covers `messages/{id}/trash` and the
 * result is recoverable for 30 days. Permanent deletion needs the full
 * `https://mail.google.com/` scope, which is a far larger grant for a worse
 * failure mode.
 *
 * A refresh token does not gain scopes retroactively, so any connection made
 * before this date can read and send but not trash, and must be disconnected
 * and reconnected once. `grantCanModify` in lib/gmailClient.server.ts detects
 * that case and the delete path says so instead of failing opaquely — the same
 * treatment `gmail.send` got when it was added.
 */
export const GMAIL_SCOPE = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");
```

In `src/lib/gmailClient.server.ts`, after the `GMAIL_SEND_SCOPE` declaration
(line 16), add:

```ts
/** The scope a grant needs before it may trash a message. */
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
```

and after `grantCanSend` (line 73), add:

```ts
/** True when the stored grant may modify mail. A null scope is treated as unknown. */
export function grantCanModify(scope: string | null): boolean {
  return Boolean(scope?.split(/\s+/).includes(GMAIL_MODIFY_SCOPE));
}
```

- [ ] **Step 2: Write the failing test for `resolveGmailId`**

`src/lib/gmailMessage.test.ts` already exists. Append this block to it and add
`resolveGmailId` to its existing `from "./gmailMessage"` import.

```ts
describe("resolveGmailId", () => {
  it("takes Gmail's own id from the stored payload", () => {
    // `message_id` is the RFC 822 header, not Gmail's id — the trash endpoint
    // is addressed by the latter, which only survives inside raw_payload.
    expect(resolveGmailId({ message_id: "<abc@mail.example>", raw_payload: { id: "18f0c" } })).toBe(
      "18f0c",
    );
  });

  it("falls back to the gmail: prefix used when a message had no Message-ID header", () => {
    expect(resolveGmailId({ message_id: "gmail:18f0c", raw_payload: null })).toBe("18f0c");
  });

  it("returns null when neither source has an id, so the caller can refuse", () => {
    expect(resolveGmailId({ message_id: "<abc@mail.example>", raw_payload: null })).toBeNull();
    expect(resolveGmailId({ message_id: "gmail:", raw_payload: {} })).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run test -- src/lib/gmailMessage.test.ts`
Expected: FAIL — `resolveGmailId` is not exported.

- [ ] **Step 4: Implement `resolveGmailId`**

Append to `src/lib/gmailMessage.ts`:

```ts
/**
 * Recovers Gmail's own message id for a stored row.
 *
 * The `message_id` column is the RFC 822 `Message-ID` header — stable across
 * mailboxes, which is what makes it the right uniqueness key — and only falls
 * back to `gmail:<id>` when a message carried no such header. Gmail's API
 * addresses messages by its own id, so that is read from the stored
 * `format=full` payload, with the prefixed fallback as the second source.
 *
 * Returns null rather than guessing: a caller that cannot identify the message
 * must refuse, not delete the local row and hope.
 */
export function resolveGmailId(row: { message_id: string; raw_payload: unknown }): string | null {
  const payloadId = (row.raw_payload as { id?: unknown } | null | undefined)?.id;
  if (typeof payloadId === "string" && payloadId) return payloadId;
  if (row.message_id.startsWith("gmail:")) return row.message_id.slice("gmail:".length) || null;
  return null;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun run test -- src/lib/gmailMessage.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing test for the server function**

Create `src/fns/gmailTrashMessages.test.ts`:

```ts
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
    readGmailGrant: vi.fn(),
    getGmailAccessToken: vi.fn().mockResolvedValue("access-token"),
    from: vi.fn(),
    fetch: vi.fn(),
    remove: vi.fn(),
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

vi.mock("@/lib/gmailClient.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/gmailClient.server")>(
    "@/lib/gmailClient.server",
  );
  return {
    ...actual,
    readGmailGrant: mocks.readGmailGrant,
    getGmailAccessToken: mocks.getGmailAccessToken,
  };
});

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import { gmailTrashMessages } from "./gmailTrashMessages";

const ROW_ID = "11111111-1111-1111-1111-111111111111";

const modifiableGrant = {
  credentials: { clientId: "id", clientSecret: "secret", refreshToken: "r", address: "me" },
  connectionId: "conn-1",
  scope:
    "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify",
  emailAddress: "danatfuture@gmail.com",
};

function rowsReturning(rows: Array<Record<string, unknown>>) {
  mocks.from.mockReturnValue({
    select: () => ({ in: async () => ({ data: rows, error: null }) }),
    delete: () => ({ eq: mocks.remove }),
  });
}

function callTrash(ids: string[], isAdmin = true) {
  const fn = gmailTrashMessages as unknown as typeof mocks.serverFunction;
  fn.context = {
    supabase: { rpc: vi.fn().mockResolvedValue({ data: isAdmin, error: null }) },
    userId: "admin-1",
  };
  return fn({ ids });
}

describe("gmailTrashMessages", () => {
  beforeEach(() => {
    mocks.readGmailGrant.mockReset().mockResolvedValue(modifiableGrant);
    mocks.from.mockReset();
    mocks.remove.mockReset().mockResolvedValue({ error: null });
    mocks.fetch.mockReset().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", mocks.fetch);
  });

  it("trashes in Gmail and only then deletes the local row", async () => {
    rowsReturning([{ id: ROW_ID, message_id: "<a@b>", raw_payload: { id: "18f0c" } }]);
    await expect(callTrash([ROW_ID])).resolves.toEqual({ trashed: 1, failed: [] });
    expect(mocks.fetch.mock.calls[0][0]).toContain("/messages/18f0c/trash");
    expect(mocks.remove).toHaveBeenCalledWith("id", ROW_ID);
  });

  it("keeps the local row when Gmail refuses the trash", async () => {
    // Deleting locally after a failed trash reproduces the reported bug: the
    // message vanishes from the app and the next sync brings it back.
    rowsReturning([{ id: ROW_ID, message_id: "<a@b>", raw_payload: { id: "18f0c" } }]);
    mocks.fetch.mockResolvedValue({ ok: false, status: 404, text: async () => "not found" });
    const result = (await callTrash([ROW_ID])) as { trashed: number; failed: unknown[] };
    expect(result.trashed).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("refuses a connection granted before gmail.modify, with the reconnect instruction", async () => {
    mocks.readGmailGrant.mockResolvedValue({
      ...modifiableGrant,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    });
    rowsReturning([{ id: ROW_ID, message_id: "<a@b>", raw_payload: { id: "18f0c" } }]);
    await expect(callTrash([ROW_ID])).rejects.toThrow(/Disconnect, then Connect Gmail again/);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("refuses a row whose Gmail id cannot be resolved rather than deleting it", async () => {
    rowsReturning([{ id: ROW_ID, message_id: "<a@b>", raw_payload: null }]);
    const result = (await callTrash([ROW_ID])) as { trashed: number; failed: unknown[] };
    expect(result.trashed).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("rejects a non-admin with an Error, not a Response", async () => {
    rowsReturning([]);
    const error = await callTrash([ROW_ID], false).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(Response);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `bun run test -- src/fns/gmailTrashMessages.test.ts`
Expected: FAIL — "Failed to resolve import ./gmailTrashMessages".

- [ ] **Step 8: Create `src/fns/gmailTrashMessages.ts`**

```ts
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  describeGmailApiError,
  getGmailAccessToken,
  GMAIL_API,
  grantCanModify,
  readGmailGrant,
} from "@/lib/gmailClient.server";
import { resolveGmailId } from "@/lib/gmailMessage";

/**
 * Deletes inbox messages by moving them to Trash in Gmail.
 *
 * Deleting the local row alone did not delete anything: the sync job lists the
 * same 30-day window on its next tick and inserts the message straight back.
 * Trashed mail is excluded from `users.messages.list` unless
 * `includeSpamTrash=true`, which the sync job does not set — that exclusion is
 * the whole mechanism, so the local delete must follow a successful trash.
 *
 * **Fails closed.** A message that cannot be trashed keeps its local row and is
 * reported. Deleting locally after a failed trash would reproduce the exact bug
 * this replaces, only with the mailbox untouched and the admin told it worked.
 *
 * Admin-gated to match migration 50, where deleting a gmail_messages row is
 * admin-only while reading and mark-read are staff-level. The check is explicit
 * because this runs under service_role and inherits no RLS.
 *
 * Errors are thrown as `Error`, never `Response`: TanStack Start hands a thrown
 * Response back to the caller instead of rejecting, which turns a refusal into
 * a success toast.
 */

const schema = z.object({
  // Bounded because each id costs one serial Gmail round trip.
  ids: z.array(z.string().uuid()).min(1).max(100),
});

export const gmailTrashMessages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => schema.parse(data))
  .handler(async ({ data, context }) => {
    const roleCheck = await context.supabase.rpc("has_role" as any, {
      _user_id: context.userId,
      _role: "admin",
    });
    if (roleCheck.error || !roleCheck.data) {
      throw new Error("Only an admin may delete inbox messages.");
    }

    const grant = await readGmailGrant();
    if (!grant) {
      throw new Error("Gmail is not connected. Connect it in Settings → Integrations.");
    }
    // Checked before any work: letting it through costs a token refresh and a
    // request per message before Google answers "insufficient scopes", which
    // reaches the admin as an error code rather than the one-click fix.
    if (!grantCanModify(grant.scope)) {
      throw new Error(describeGmailApiError(403, "insufficient authentication scopes"));
    }

    const { data: rows, error } = await supabaseAdmin
      .from("gmail_messages")
      .select("id, message_id, raw_payload")
      .in("id", data.ids);
    if (error) throw new Error(error.message);

    const accessToken = await getGmailAccessToken(grant.credentials);
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    let trashed = 0;
    const failed: Array<{ id: string; reason: string }> = [];

    for (const row of rows ?? []) {
      const gmailId = resolveGmailId(row as { message_id: string; raw_payload: unknown });
      if (!gmailId) {
        failed.push({
          id: row.id,
          reason: "This message has no Gmail id stored, so it cannot be deleted in Gmail.",
        });
        continue;
      }

      const response = await fetch(
        `${GMAIL_API}/${grant.credentials.address}/messages/${gmailId}/trash`,
        { method: "POST", headers: authHeader },
      );
      if (!response.ok) {
        failed.push({
          id: row.id,
          reason: describeGmailApiError(response.status, await response.text()),
        });
        continue;
      }

      const removed = await supabaseAdmin.from("gmail_messages").delete().eq("id", row.id);
      if (removed.error) {
        // Gmail has it in Trash; the local row will disappear on the next
        // successful attempt. Reported rather than swallowed.
        failed.push({ id: row.id, reason: removed.error.message });
        continue;
      }
      trashed += 1;
    }

    return { trashed, failed };
  });
```

- [ ] **Step 9: Run it to verify it passes**

Run: `bun run test -- src/fns/gmailTrashMessages.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 10: Replace the hook**

In `src/hooks/useGmailMessages.ts`, add to the imports:

```ts
import { useServerFn } from "@tanstack/react-start";

import { gmailTrashMessages } from "@/fns/gmailTrashMessages";
```

Replace `useDeleteGmailMessages` (lines 56-66) with:

```ts
/**
 * Moves messages to Trash in Gmail, then removes the local rows.
 *
 * The previous version deleted the local row only, so the next sync tick pulled
 * every "deleted" message back in.
 *
 * Partial results are returned rather than thrown: some messages may be trashed
 * while others fail, and the caller has to be able to report both.
 * Invalidation happens in `onSettled` for the same reason.
 */
export function useTrashGmailMessages() {
  const queryClient = useQueryClient();
  const trash = useServerFn(gmailTrashMessages);
  return useMutation({
    mutationFn: async (
      ids: string[],
    ): Promise<{ trashed: number; failed: Array<{ id: string; reason: string }> }> => {
      if (!ids.length) return { trashed: 0, failed: [] };
      const result = (await trash({ data: { ids } })) as
        | { trashed?: number; failed?: Array<{ id: string; reason: string }> }
        | undefined;
      // A thrown Response resolves here instead of rejecting, so the shape is
      // checked rather than assumed.
      if (typeof result?.trashed !== "number") {
        throw new Error("Gmail did not confirm the messages were deleted.");
      }
      return { trashed: result.trashed, failed: result.failed ?? [] };
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["gmail-messages"] }),
  });
}
```

- [ ] **Step 11: Wire the inbox to report partial failures**

In `src/routes/admin.inbox.tsx`:

Change the import on line 54 from `useDeleteGmailMessages` to
`useTrashGmailMessages`, and line 135 to:

```tsx
const deleteGmail = useTrashGmailMessages();
```

Replace `confirmDeleteGmail` (lines 294-307) with:

```tsx
/**
 * A delete here moves the message to Trash in Gmail first. A message that
 * could not be trashed keeps its local row, so the count is reported rather
 * than a blanket success — the previous blanket success is what made a
 * failed delete look like a working one.
 */
async function confirmDeleteGmail() {
  if (!deleteGmailIds?.length) return;
  try {
    const result = await deleteGmail.mutateAsync(deleteGmailIds);
    setSelectedGmailIds((prev) => {
      const next = new Set(prev);
      deleteGmailIds.forEach((id) => next.delete(id));
      return next;
    });
    setDeleteGmailIds(null);
    if (result.failed.length) {
      toast.error(t("inbox.gmailDeletePartial").replace("{count}", String(result.failed.length)), {
        description: result.failed[0].reason,
      });
    } else {
      toast.success(t("phase2.deleted"));
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("common.error"));
  }
}
```

- [ ] **Step 12: Add the i18n key to both languages**

Arabic block:

```ts
    "inbox.gmailDeletePartial": "تعذّر حذف {count} من الرسائل من Gmail، وبقيت في القائمة.",
```

English block:

```ts
    "inbox.gmailDeletePartial":
      "{count} message(s) could not be deleted from Gmail and are still listed.",
```

- [ ] **Step 13: Run the gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all pass. `src/routes/admin.inbox.test.ts` exists but does not
reference the hook (it asserts on table headers), so no change is expected
there — if it does break, fix it rather than skipping it.

- [ ] **Step 14: Commit**

```bash
git add src/lib/gmailOAuthConfig.ts src/lib/gmailClient.server.ts src/lib/gmailMessage.ts src/lib/gmailMessage.test.ts src/fns/gmailTrashMessages.ts src/fns/gmailTrashMessages.test.ts src/hooks/useGmailMessages.ts src/routes/admin.inbox.tsx src/i18n/dictionary.ts
git commit -m "$(cat <<'EOF'
feat(inbox): deleting a Gmail message moves it to Trash in Gmail

Deleting removed the local row only, so the next sync tick listed the
same 30-day window and pulled every deleted message back in.

Adds the gmail.modify scope and trashes the message in Gmail before
removing the local row — trashed mail is excluded from messages.list,
which is what actually stops the resurrection. Fails closed: a message
that cannot be trashed keeps its row and is reported.

Requires a one-time Disconnect/Connect in Settings -> Integrations,
because a refresh token does not gain scopes retroactively.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Verify against the real system

**Files:** none changed unless a check fails.

- [ ] **Step 1: Full gates**

Run: `bun run lint && bun run typecheck && bun run test && bun run test:db`
Expected: all pass.

- [ ] **Step 2: Apply migration 66 to production**

The migration is additive (a new function plus grants) and idempotent.

Apply it with the `ssh-danatfuture-mcp` `exec` tool. That tool runs a command
string **on the remote host** and cannot read local files, so `< db/migrations/…`
would read nothing — the SQL is passed inline as a quoted heredoc instead.
Read `db/migrations/66_find_phone_conflicts.sql` and paste its exact contents
where marked:

```bash
docker exec -i danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres <<'MIGRATION_SQL'
-- paste the full contents of db/migrations/66_find_phone_conflicts.sql here
MIGRATION_SQL
```

The heredoc marker is single-quoted so the shell does not expand `$$`, which the
function body uses as its dollar-quote delimiter. Unquoted, the body would be
mangled before psql ever saw it.

Confirm:

```bash
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres -At \
  -c "select proname from pg_proc where proname = 'find_phone_conflicts'"
```

Expected: one row, `find_phone_conflicts`.

- [ ] **Step 3: Verify the revoke fix on production data**

After deploy, check the user who exposed the bug:

```sql
select p.id, p.tenant_id, (select count(*) from public.user_tenants ut where ut.user_id = p.id)
from public.profiles p where p.username = 'waleed';
```

Expected **before** any new action: `tenant_id` set, count 1 (the stale state).
Grant then revoke the `tenant` role through the UI, and expect `tenant_id` null
and count 0 afterwards.

- [ ] **Step 4: Reconnect Gmail and verify the trash path**

In Settings → Integrations: Disconnect, then Connect Gmail. Confirm the new
scope landed:

```sql
select scope from public.gmail_connections;
```

Expected: the string contains `https://www.googleapis.com/auth/gmail.modify`.

Then delete one message in the app's Gmail tab, confirm it appears in Gmail's
Trash, and force a sync tick:

```bash
curl -s -X POST https://danat-future.com/api/public/cron \
  -H "Authorization: Bearer $CRON_SECRET" -d '{"job":"gmail-sync"}'
```

Expected: the message does **not** reappear. This is the empirical check that
`messages.list` excludes trashed mail — do not skip it.

- [ ] **Step 5: Report**

Summarise for the user: the delete diagnosis (see the table at the head of
Task 1 — report it as the inference it is, not as a measured status code), the
revoke verification result, and confirmation that the Gmail message stayed gone
across a sync tick.

---

## Self-Review

**Spec coverage**

| Spec section                                      | Task                             |
| ------------------------------------------------- | -------------------------------- |
| 1 — revocation clears both links                  | Task 2                           |
| 2 — mobile field + migration 66 + collision guard | Task 3 (backend), Task 4 (forms) |
| 3 — edit form matches add form                    | Task 4                           |
| 4 — deletion actually deletes                     | Task 1                           |
| 5 — Gmail trash                                   | Task 5                           |
| Verification section                              | Task 6                           |

**Placeholder scan:** no TBD/TODO; every code step carries the literal code.

**Type consistency:** `{ deleted: true }` (Task 1) asserted in Task 1 Step 5.
`{ revoked, clearedTenantLink, removedAssignments }` (Task 2 Step 3) consumed in
Task 2 Steps 5 and 6. `normalisePhoneForSave` (Task 3 Step 6) called in Task 3
Steps 8-9. `{ updated: true }` (Task 4 Step 1) asserted in Task 4 Step 4.
`resolveGmailId` (Task 5 Step 4) called in Task 5 Step 8.
`{ trashed, failed }` (Task 5 Step 8) consumed in Steps 10-11.
`grantCanModify` (Task 5 Step 1) called in Step 8.
