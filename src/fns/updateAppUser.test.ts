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

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: { admin: { updateUserById: mocks.updateUserById } },
    from: mocks.from,
    rpc: mocks.rpc,
  },
}));

import { updateAppUser } from "./updateAppUser";

const USER = "11111111-1111-1111-1111-111111111111";
const ADMIN = "22222222-2222-2222-2222-222222222222";

/**
 * Records every `user_roles` call, distinguishing delete role lists from the
 * final insert, so the tests can assert the `tenant` role is never among the
 * roles deleted — the guard this whole task hinges on.
 */
function trackUserRoles(existingRoles: string[]) {
  const deletedRoleLists: string[][] = [];
  const inserted: Array<{ user_id: string; role: string; granted_by: string }> = [];
  mocks.from.mockImplementation((table: string) => {
    if (table === "user_roles") {
      return {
        select: () => ({
          eq: async () => ({
            data: existingRoles.map((role) => ({ role })),
            error: null,
          }),
        }),
        delete: () => ({
          eq: () => ({
            in: (_col: string, roles: string[]) => {
              deletedRoleLists.push(roles);
              return Promise.resolve({ error: null });
            },
          }),
        }),
        insert: (row: { user_id: string; role: string; granted_by: string }) => {
          inserted.push(row);
          return Promise.resolve({ error: null });
        },
      };
    }
    // profiles is only *read* by these saves (no tenantId sent, so the stored
    // link — null here — decides the contact-sync target, and the sync is
    // skipped); user_tenants / tenants are not touched either.
    return {
      ...profilesTenantLinkRead(null),
      update: () => ({ eq: async () => ({ error: null }) }),
    };
  });
  return { deletedRoleLists, inserted };
}

function callUpdate(data: Record<string, unknown>, isAdmin = true) {
  const fn = updateAppUser as unknown as typeof mocks.serverFunction;
  fn.context = {
    supabase: { rpc: vi.fn().mockResolvedValue({ data: isAdmin, error: null }) },
    userId: ADMIN,
  };
  return fn({ userId: USER, ...data });
}

/**
 * يبني سلسلة قراءة «profiles» لرابط المستأجر الحالي، كما تقرؤها المزامنة.
 *
 * The handler reads the stored tenant link before any write when the save
 * sends no tenantId of its own (the link then decides the contact-sync
 * target), so every tracker's profiles stub needs this chain.
 */
function profilesTenantLinkRead(storedTenantId: string | null) {
  return {
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { tenant_id: storedTenantId }, error: null }),
        // The re-link guard: no other account holds the tenant.
        neq: () => ({ limit: async () => ({ data: [], error: null }) }),
      }),
    }),
  };
}

/**
 * يبني سلسلة «tenants» الكاملة: تفعيل البوابة يُنتظر عند eq، ومزامنة
 * بيانات التواصل تكمل السلسلة بـ select ثم maybeSingle (قراءةً وكتابة).
 *
 * `eq` deliberately returns a plain object rather than a promise: the portal
 * write awaits it directly (an awaited non-thenable resolves to itself, whose
 * `.error` is undefined — the handler's falsy check), while the contact sync
 * chains `.select("id").maybeSingle()` off the same object.
 */
function tenantsSyncChain(onUpdate?: (payload: Record<string, unknown>) => void) {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          // No stored email/whatsapp, so a sent contact detail always counts
          // as changed and exercises the sync's write path.
          data: { id: TENANT, email: null, whatsapp: null },
          error: null,
        }),
      }),
    }),
    update: (payload: Record<string, unknown>) => {
      onUpdate?.(payload);
      return {
        eq: () => ({
          select: () => ({
            maybeSingle: async () => ({ data: { id: TENANT }, error: null }),
          }),
        }),
      };
    },
  };
}

describe("updateAppUser role swap", () => {
  beforeEach(() => {
    mocks.from.mockReset();
    mocks.rpc.mockReset().mockResolvedValue({ data: null, error: null });
    mocks.updateUserById.mockReset();
  });

  it("swaps the managerial role and never deletes the tenant role", async () => {
    // The shape this whole task protects: an accountant who also holds
    // `tenant`. Saving a new managerial role from the edit dialog must not
    // touch the tenant role, or the account loses portal access on save.
    const { deletedRoleLists, inserted } = trackUserRoles(["accountant", "tenant"]);

    const result = await callUpdate({ role: "admin" });

    expect(result).toEqual({ updated: true, userId: USER, tenantContactSynced: true });
    expect(deletedRoleLists).toHaveLength(1);
    expect(deletedRoleLists[0]).toEqual(["accountant"]);
    expect(deletedRoleLists[0]).not.toContain("tenant");
    expect(inserted).toEqual([{ user_id: USER, role: "admin", granted_by: ADMIN }]);
  });

  it("does not call delete when there is no existing managerial role to drop", async () => {
    // Guard against an empty .in(...) call: a pure tenant account has no
    // managerial role at all, so the delete step must be skipped entirely
    // rather than issued with an empty role list.
    const { deletedRoleLists, inserted } = trackUserRoles(["tenant"]);

    const result = await callUpdate({ role: "readonly" });

    expect(result).toEqual({ updated: true, userId: USER, tenantContactSynced: true });
    expect(deletedRoleLists).toHaveLength(0);
    expect(inserted).toEqual([{ user_id: USER, role: "readonly", granted_by: ADMIN }]);
  });

  it("does not touch user_roles at all when the role already matches", async () => {
    const { deletedRoleLists, inserted } = trackUserRoles(["admin", "tenant"]);

    const result = await callUpdate({ role: "admin" });

    expect(result).toEqual({ updated: true, userId: USER, tenantContactSynced: true });
    expect(deletedRoleLists).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it("rejects a non-admin with an Error, not a Response", async () => {
    trackUserRoles(["admin"]);
    const error = await callUpdate({ role: "admin" }, false).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(Response);
  });
});

/**
 * Records every `profiles.update(...)` payload and counts `user_tenants`
 * delete/insert calls separately, so the tests can assert that omitting
 * `tenantId`/`tenantIds` leaves both completely alone — the clobber
 * protection the Edit dialog's "only send when actually changed" logic
 * depends on. Without it, the handler's `!== undefined` guards are the only
 * thing standing between an unrelated save (a typo fix in the phone field)
 * and a full delete-then-insert of a user's tenant links.
 */
function trackProfileAndTenants() {
  const profileUpdates: Record<string, unknown>[] = [];
  let userTenantsDeleteCount = 0;
  let userTenantsInsertCount = 0;
  mocks.from.mockImplementation((table: string) => {
    if (table === "profiles") {
      return {
        ...profilesTenantLinkRead(null),
        update: (payload: Record<string, unknown>) => {
          profileUpdates.push(payload);
          return { eq: async () => ({ error: null }) };
        },
      };
    }
    if (table === "user_tenants") {
      return {
        delete: () => {
          userTenantsDeleteCount += 1;
          return { eq: async () => ({ error: null }) };
        },
        insert: (_rows: unknown[]) => {
          userTenantsInsertCount += 1;
          return Promise.resolve({ error: null });
        },
      };
    }
    // user_roles is not touched by these tests (no role sent).
    return {};
  });
  return {
    profileUpdates,
    getUserTenantsDeleteCount: () => userTenantsDeleteCount,
    getUserTenantsInsertCount: () => userTenantsInsertCount,
  };
}

describe("updateAppUser tenant-links protection", () => {
  beforeEach(() => {
    mocks.from.mockReset();
    mocks.rpc.mockReset().mockResolvedValue({ data: null, error: null });
    mocks.updateUserById.mockReset().mockResolvedValue({ data: {}, error: null });
  });

  it("omitting tenantId and tenantIds leaves user_tenants and profiles.tenant_id untouched", async () => {
    // The everyday case this protects: an editor with users.assign_tenants
    // fixes a typo in the display name. No tenant field is sent at all, so
    // neither the links nor profiles.tenant_id should be written.
    const { profileUpdates, getUserTenantsDeleteCount, getUserTenantsInsertCount } =
      trackProfileAndTenants();

    const result = await callUpdate({ displayName: "New Name" });

    expect(result).toEqual({ updated: true, userId: USER, tenantContactSynced: true });
    expect(getUserTenantsDeleteCount()).toBe(0);
    expect(getUserTenantsInsertCount()).toBe(0);
    expect(profileUpdates).toHaveLength(1);
    expect(profileUpdates[0]).not.toHaveProperty("tenant_id");
  });

  it("an empty tenantIds array deletes the existing links and inserts nothing", async () => {
    // A deliberate "clear all assignments" save: tenantIds is sent as [],
    // which must still delete the existing rows (the field was sent, so it
    // is not "unknown") but insert nothing back.
    const { getUserTenantsDeleteCount, getUserTenantsInsertCount } = trackProfileAndTenants();

    const result = await callUpdate({ tenantIds: [] });

    expect(result).toEqual({ updated: true, userId: USER, tenantContactSynced: true });
    expect(getUserTenantsDeleteCount()).toBe(1);
    expect(getUserTenantsInsertCount()).toBe(0);
  });
});

/**
 * Records every `tenants.update(...)` payload, so the tests can assert the
 * portal-enable write mirrors createAppUser's: fires only when `tenantId` is
 * an actual uuid, never for `null` (a deliberately cleared link) or an
 * absent field (the tenant field was not part of this save at all).
 */
function trackTenantsPortalEnable() {
  const tenantsUpdates: Record<string, unknown>[] = [];
  mocks.from.mockImplementation((table: string) => {
    if (table === "tenants") {
      return tenantsSyncChain((payload) => tenantsUpdates.push(payload));
    }
    // profiles is read whenever tenantId is absent from the save (the stored
    // link then decides the sync target); the write itself is exercised by
    // the tests above, so it is stubbed here.
    return {
      ...profilesTenantLinkRead(null),
      update: () => ({ eq: async () => ({ error: null }) }),
    };
  });
  return { tenantsUpdates };
}

describe("updateAppUser tenant portal enable", () => {
  const TENANT = "33333333-3333-3333-3333-333333333333";

  beforeEach(() => {
    mocks.from.mockReset();
    mocks.rpc.mockReset().mockResolvedValue({ data: null, error: null });
    mocks.updateUserById.mockReset().mockResolvedValue({ data: {}, error: null });
  });

  it("enables the linked tenant's portal when tenantId is a real uuid", async () => {
    // Relinking a tenant portal account must enable the new tenant's portal,
    // exactly like createAppUser does at account creation — otherwise the
    // portal refuses the user with "Tenant portal disabled" and the users
    // screen gives no clue why.
    const { tenantsUpdates } = trackTenantsPortalEnable();

    const result = await callUpdate({ tenantId: TENANT });

    expect(result).toEqual({ updated: true, userId: USER, tenantContactSynced: true });
    expect(tenantsUpdates).toEqual([{ tenant_portal_enabled: true }]);
  });

  it("does not touch tenants when tenantId is explicitly cleared to null", async () => {
    const { tenantsUpdates } = trackTenantsPortalEnable();

    const result = await callUpdate({ tenantId: null });

    expect(result).toEqual({ updated: true, userId: USER, tenantContactSynced: true });
    expect(tenantsUpdates).toEqual([]);
  });

  it("does not touch tenants when tenantId is absent from the save", async () => {
    const { tenantsUpdates } = trackTenantsPortalEnable();

    const result = await callUpdate({ displayName: "New Name" });

    expect(result).toEqual({ updated: true, userId: USER, tenantContactSynced: true });
    expect(tenantsUpdates).toEqual([]);
  });
});

const TENANT = "33333333-3333-3333-3333-333333333333";
const OTHER_TENANT = "44444444-4444-4444-4444-444444444444";

/**
 * Stands the phone guard up end to end, against a stored `profiles.tenant_id`.
 *
 * `find_phone_conflicts` is mocked to *behave* like its SQL rather than to
 * record its arguments: it reports the number as belonging both to TENANT and
 * to the account itself, and drops each row only when the matching exclusion is
 * passed. A save that survives is therefore evidence the right tenant was
 * excluded — which asserting the call shape would not be, since the two
 * exclusions could be transposed, or name a tenant that does not conflict, and
 * still match.
 */
function stubTenantOwnedNumber(storedTenantId: string | null) {
  mocks.from.mockImplementation((table: string) => {
    if (table === "profiles") {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { tenant_id: storedTenantId }, error: null }),
            // The re-link guard: no other account holds the tenant.
            neq: () => ({ limit: async () => ({ data: [], error: null }) }),
          }),
        }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    // tenants is reached by the contact sync once the phone save lands on a
    // linked tenant: the sync reads the tenant row and writes whatsapp back.
    return tenantsSyncChain();
  });
  mocks.rpc.mockImplementation(
    async (
      fn: string,
      args: { _exclude_profile: string | null; _exclude_tenant: string | null },
    ) => {
      if (fn !== "find_phone_conflicts") return { data: null, error: null };
      const rows = [
        { kind: "tenant", id: TENANT, label: "Tenant One" },
        { kind: "profile", id: USER, label: "The account being edited" },
      ];
      return {
        data: rows.filter((row) =>
          row.kind === "tenant"
            ? args._exclude_tenant !== row.id
            : args._exclude_profile !== row.id,
        ),
        error: null,
      };
    },
  );
}

describe("updateAppUser phone conflict exclusions", () => {
  beforeEach(() => {
    mocks.from.mockReset();
    mocks.rpc.mockReset().mockResolvedValue({ data: null, error: null });
    mocks.updateUserById.mockReset().mockResolvedValue({ data: {}, error: null });
  });

  // Saving a tenant account whose phone IS its tenant's mobile is the ordinary
  // case now, not an edge one: the create form prefills the number straight off
  // the tenant record. Each row re-saves that number and must be allowed
  // through. Refusing it would make tenant accounts uneditable, and the failure
  // would read as "this number belongs to a tenant" — pointing nowhere near the
  // exclusion that was actually wrong.
  it.each([
    {
      scenario: "the save names the tenant it is landing on",
      storedTenantId: TENANT,
      sent: { phone: "+965 5123 4567", tenantId: TENANT },
    },
    {
      scenario: "only the phone was edited, so the tenant comes from the profile",
      storedTenantId: TENANT,
      sent: { phone: "51234567" },
    },
    {
      scenario: "the link is being moved, so the incoming tenant wins over the stored one",
      storedTenantId: OTHER_TENANT,
      sent: { phone: "51234567", tenantId: TENANT },
    },
  ])("saves a tenant's own mobile when $scenario", async ({ storedTenantId, sent }) => {
    stubTenantOwnedNumber(storedTenantId);

    await expect(callUpdate(sent)).resolves.toEqual({
      updated: true,
      userId: USER,
      tenantContactSynced: true,
    });
  });

  it("still refuses a number belonging to a tenant this account is not linked to", async () => {
    // The exclusions must not be so broad that the guard stops guarding. An
    // admin typing Tenant One's number onto an account linked elsewhere is the
    // collision the check exists to catch, and it has to survive the rows above.
    stubTenantOwnedNumber(OTHER_TENANT);

    await expect(callUpdate({ phone: "51234567", tenantId: OTHER_TENANT })).rejects.toThrow(
      /Tenant One/,
    );
  });
});

describe("updateAppUser re-link to a tenant that already has an account", () => {
  beforeEach(() => {
    mocks.updateUserById.mockReset();
    mocks.from.mockReset();
  });

  it("refuses before changing the login's email or password", async () => {
    mocks.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          neq: () => ({
            limit: async () => ({ data: [{ id: "other-account" }], error: null }),
          }),
        }),
      }),
    }));

    await expect(
      callUpdate({
        tenantId: "33333333-3333-3333-3333-333333333333",
        email: "new@example.com",
        password: "new-password-123",
      }),
    ).rejects.toThrow("already has a portal account");
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });
});

describe("updateAppUser username rename", () => {
  beforeEach(() => {
    mocks.updateUserById.mockReset().mockResolvedValue({ data: {}, error: null });
    mocks.from.mockReset();
    mocks.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  });

  /**
   * يزرع «profiles» بحيث يعيد فحص اسم المستخدم المالكين المعطَين، مستثنيًا
   * الحساب الذي يمرَّر إلى neq كما يفعل الاستعلام الحقيقي.
   */
  function stubUsernameOwners(owners: Array<{ id: string; display_name: string }>) {
    mocks.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { tenant_id: null }, error: null }),
          neq: (_column: string, excluded: string) => ({
            limit: async () => ({
              data: owners.filter((owner) => owner.id !== excluded),
              error: null,
            }),
          }),
        }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }));
  }

  it("refuses a username held by another account before changing the login", async () => {
    stubUsernameOwners([{ id: "other-account", display_name: "Faisal" }]);

    await expect(callUpdate({ username: "faisal", password: "new-password-123" })).rejects.toThrow(
      'The username "faisal" is already used by "Faisal".',
    );
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });

  it("lets an account re-save its own unchanged username", async () => {
    // The edit dialog sends the current username back on every save.
    stubUsernameOwners([{ id: USER, display_name: "Self" }]);

    await expect(callUpdate({ username: "self.name" })).resolves.toEqual({
      updated: true,
      userId: USER,
      tenantContactSynced: true,
    });
    expect(mocks.updateUserById).toHaveBeenCalled();
  });
});
