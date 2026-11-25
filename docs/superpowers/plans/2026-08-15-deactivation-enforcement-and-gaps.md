# Deactivation Enforcement and Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `profiles.is_active` actually block login and API access, without turning "contract ended" into an account lockout, and fix three unrelated gaps (gallery toggle, empty states, bilingual report names).

**Architecture:** `profiles.is_active` is enforced in three layers — rejected at the login server function, not bypassed by the client fallback, and inert at the issuer (`auth.users.banned_until`) and in RLS (`has_permission` / `is_staff`). Migration 21's contract trigger is repointed off the account flag onto `tenants.tenant_portal_enabled`, where it belongs. Sections 2–4 are independent fixes.

**Tech Stack:** TanStack Start (React 19), self-hosted Supabase (Postgres 17 + GoTrue + PostgREST), Bun, Vitest, Tailwind 4 + shadcn/ui, manual SQL migrations.

**Spec:** `docs/superpowers/specs/2026-08-15-deactivation-enforcement-and-gaps-design.md`

## Global Constraints

- **Arabic doc comments.** Every function gets a doc comment *before* it, leading with an Arabic description. English follows for the *why*. Comments explain why, never restate what.
- **File ceiling 500–600 lines** for application code. Do not let any touched file cross it; split
  by responsibility if it would. **Migrations are exempt** — migration 143 re-issues a ~570-line
  function body that must not be split, and splitting a `create or replace` is not possible anyway.
- **Migrations are manual SQL** in `db/migrations/`, ordered by leading number (`sort -V`). The next free number is **142**. Never edit an already-applied migration — re-issue in a new one.
- **`database.types.ts` is hand-maintained.** After a schema change, hand-edit it. Never run `gen:types` over it.
- **Never throw a `Response` from a server function** to signal failure — it resolves client-side via `x-tss-raw`. Return an explicit flag.
- **`create or replace function` cannot change an OUT-parameter row type**, and cannot patch a body — re-issue the whole function.
- **i18n parity is enforced** by `src/i18n/dictionary.test.ts`: a key added to one locale and not the other fails `bun run test`. Add every new key to both `ar` and `en`.
- **Gates:** `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:sql`. Any task that
  adds a migration also runs **`bun run test:db`**, which builds the database from scratch in
  numeric order — `CLAUDE.md` requires it, and it is the only check that proves a new migration
  applies on a virgin database rather than only on your already-migrated local copy.
- **Do not run `bun run format`** across the repo — it rewrites all markdown and buries the real diff. Format only the files you touched.
- **Do not commit.** The orchestrator reviews and commits.

---

### Task 1: Migration 142 — repoint the portal trigger and backfill

**Files:**
- Create: `db/migrations/142_deactivation_enforcement.sql`
- Test: `src/db/deactivationEnforcement.sqltest.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `public.deactivate_portal_users_without_active_contract()` writing `tenants.tenant_portal_enabled`; `has_permission(uuid, text)` and `is_staff(uuid)` additionally requiring `profiles.is_active`.

**Context you need:** `db/migrations/21_settings_integrations.sql:51-77` currently sets
`profiles.is_active = false` when a tenant's last active contract ends. Its own comment says it is
deactivating the *portal* login. Nothing reads `is_active` today, so this is inert — but this task makes
`is_active` a login gate, at which point that trigger would lock people out of their accounts for
having a contract end. The highest-numbered definitions you are replacing are:
`has_permission` in `db/migrations/16_custom_roles.sql:117-145` and `is_staff` in
`db/migrations/01_schema_core.sql:114-126`. Read both before writing; re-issue them in full with the
new clause, changing nothing else.

- [ ] **Step 1: Write the failing SQL test**

Create `src/db/deactivationEnforcement.sqltest.ts`, following the shape of
`src/db/loginByPhone.sqltest.ts` (which shows `withRollback`, `closePool`, and how inserting into
`auth.users` auto-creates the profile via the `handle_new_user` trigger):

```ts
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * ينشئ مستأجرًا وملفًا شخصيًا مرتبطًا به، مع عقد اختياري نشط.
 *
 * The trigger under test keys off "does this tenant still have an active
 * contract", so every case here differs only in that one fact.
 */
async function seedTenantWithProfile(client: PoolClient, withActiveContract: boolean) {
  const tenantId = randomUUID();
  const userId = randomUUID();
  await client.query(
    `insert into public.tenants (id, code, name, tenant_portal_enabled)
     values ($1, $2, 'مستأجر اختبار', true)`,
    [tenantId, `T-${tenantId.slice(0, 8)}`],
  );
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@example.test`],
  );
  await client.query(`update public.profiles set tenant_id = $2 where id = $1`, [userId, tenantId]);

  let contractId: string | null = null;
  if (withActiveContract) {
    contractId = randomUUID();
    await client.query(
      `insert into public.contracts (id, tenant_id, state, start_date, end_date)
       values ($1, $2, 'active', current_date - 30, current_date + 300)`,
      [contractId, tenantId],
    );
  }
  return { tenantId, userId, contractId };
}

describe("migration 142 — the contract trigger stops touching the account flag", () => {
  test("ending the last active contract disables the portal, not the account", async () => {
    await withRollback(async (client) => {
      const { tenantId, userId, contractId } = await seedTenantWithProfile(client, true);

      await client.query(`update public.contracts set state = 'expired' where id = $1`, [
        contractId,
      ]);

      const { rows: profile } = await client.query(
        `select is_active from public.profiles where id = $1`,
        [userId],
      );
      const { rows: tenant } = await client.query(
        `select tenant_portal_enabled from public.tenants where id = $1`,
        [tenantId],
      );

      expect(profile[0].is_active).toBe(true);
      expect(tenant[0].tenant_portal_enabled).toBe(false);
    });
  });

  test("a tenant with another active contract keeps portal access", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedTenantWithProfile(client, true);
      const second = randomUUID();
      await client.query(
        `insert into public.contracts (id, tenant_id, state, start_date, end_date)
         values ($1, $2, 'active', current_date - 10, current_date + 300)`,
        [second, tenantId],
      );

      await client.query(`update public.contracts set state = 'expired' where id = $1`, [
        contractId,
      ]);

      const { rows } = await client.query(
        `select tenant_portal_enabled from public.tenants where id = $1`,
        [tenantId],
      );
      expect(rows[0].tenant_portal_enabled).toBe(true);
    });
  });
});

describe("migration 142 — has_permission respects the account flag", () => {
  test("an inactive profile is refused a permission its role grants", async () => {
    await withRollback(async (client) => {
      const { userId } = await seedTenantWithProfile(client, true);
      await client.query(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [
        userId,
      ]);

      const { rows: before } = await client.query(
        `select public.has_permission($1, 'tenants.read') as allowed`,
        [userId],
      );
      expect(before[0].allowed).toBe(true);

      await client.query(`update public.profiles set is_active = false where id = $1`, [userId]);

      const { rows: after } = await client.query(
        `select public.has_permission($1, 'tenants.read') as allowed`,
        [userId],
      );
      expect(after[0].allowed).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:sql -- deactivationEnforcement`
Expected: FAIL — the first test fails because `is_active` becomes `false` and
`tenant_portal_enabled` stays `true`; the `has_permission` test fails because the flag is ignored.

- [ ] **Step 3: Write migration 142**

Create `db/migrations/142_deactivation_enforcement.sql`. Read
`db/migrations/16_custom_roles.sql:117-145` and `db/migrations/01_schema_core.sql:114-126` and copy
those bodies verbatim, adding only the `is_active` clause — do not restructure them.

```sql
-- 142_deactivation_enforcement.sql
--
-- `profiles.is_active` has been written by four paths since migration 01 and
-- read by none: the admin Users switch, createAppUser, the closeout restore
-- RPCs, and the contract trigger from migration 21. Deactivating a user has
-- never blocked anything. This migration makes the flag load-bearing.
--
-- Migration 21's trigger is the one thing that must move first. Its comment
-- says it deactivates "that tenant's portal login", but it writes the ACCOUNT
-- flag. Inert while nothing read `is_active`; the moment login consults it,
-- every tenant whose contract merely ended is locked out of their account.
-- It is repointed at `tenants.tenant_portal_enabled`, which is what the portal
-- already gates on (portal.tsx, createPayment.ts, RLS in migration 06).

-- ---------------------------------------------------------------------------
-- ١. يوقف بوابة المستأجر — لا الحساب — عند انتهاء آخر عقد نشط.
-- ---------------------------------------------------------------------------
create or replace function public.deactivate_portal_users_without_active_contract()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _tenant uuid := coalesce(old.tenant_id, new.tenant_id);
begin
  if _tenant is not null and not exists (
    select 1 from public.contracts c
    where c.tenant_id = _tenant and c.state = 'active'
  ) then
    update public.tenants
      set tenant_portal_enabled = false
      where id = _tenant and tenant_portal_enabled;
  end if;
  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------------------
-- ٢. يعيد تفعيل الحسابات التي أوقفها المُشغِّل القديم وحده.
--
-- Expressed as the trigger's own precondition rather than as "every false row
-- was the trigger". The single inactive row in production has an ACTIVE
-- contract, so the trigger cannot have written it — an admin did, deliberately,
-- and a blanket restore would undo exactly the deactivation this migration
-- exists to enforce. Staff profiles are excluded because the trigger only ever
-- touched rows with a tenant_id.
-- ---------------------------------------------------------------------------
with restored as (
  update public.profiles p
     set is_active = true
   where not p.is_active
     and p.tenant_id is not null
     and not exists (
       select 1 from public.contracts c
        where c.tenant_id = p.tenant_id and c.state = 'active')
  returning p.tenant_id
)
update public.tenants t
   set tenant_portal_enabled = false
 where t.id in (select tenant_id from restored)
   and t.tenant_portal_enabled;
```

**The two statements must be one CTE, exactly as above.** Written as two independent sweeps, the
second would disable the portal for *every* tenant without an active contract — but
`contract_states` is `draft, active, frozen, suspended, expired, renewed, terminated` (`04:26`) and
`tenants.tenant_portal_enabled` defaults to `false` (`04:122`), turned on deliberately by
`createAppUser` / `updateAppUser`. A blanket sweep would therefore revoke access from a tenant whose
contract is merely `frozen` or `suspended`, and from a brand-new tenant still on a `draft` contract
the trigger never fired for. The CTE moves state only for rows the trigger actually authored.

Idempotent: on a second run no profile matches, `restored` is empty, and the update is a no-op.

Then — **and this step is what makes the whole feature work on the account that reported the bug** —
converge the issuer with the flag for every profile that is *still* inactive after that restore:

```sql
-- ---------------------------------------------------------------------------
-- ٣. يمنع الحسابات الموقوفة أصلاً من إصدار أي جلسة جديدة.
--
-- Task 5 only bans accounts toggled from here on. Every row deactivated BEFORE
-- this migration would keep a usable password grant against GoTrue directly —
-- including the one account in production that reported this bug, verified as
-- is_active = false with banned_until unset. Without this the feature ships and
-- the reported case stays open.
-- ---------------------------------------------------------------------------
update auth.users u
   set banned_until = 'infinity'
 where exists (select 1 from public.profiles p where p.id = u.id and not p.is_active)
   and u.banned_until is distinct from 'infinity';
```

It must run **after** the CTE above, so it bans only the deliberately-deactivated rows and not the
trigger-authored ones the CTE just restored. Idempotent via the `is distinct from` guard.

Finally, stop the closeout-restore RPCs from undoing deactivation. Both
`87_contract_closeout_rpcs.sql:1058-1061` and `114_closeout_multi_unit.sql:818-821` end with:

```sql
  -- 6. EXPLICITLY re-enable portal profiles.
  update public.profiles set is_active = true where tenant_id = v_contract.tenant_id;
```

That step exists only to undo migration 21's one-way trigger. Once the trigger writes
`tenant_portal_enabled` instead, step 5 above it already restores the portal — and step 6 becomes a
live bug: restoring *any* contract would silently re-activate an account an admin deliberately
deactivated, and would desync it from `banned_until`, so the Users table would read "active" while
GoTrue still refused the login.

Re-issue both functions with **step 6 deleted and nothing else changed**, and update the now-false
comment above step 5. Copy each body verbatim from its source migration — the same transcription
discipline as Task 8 applies.

Then re-issue `is_staff` and `has_permission`. **Both bodies below are the real current ones with
the `is_active` clause already added — use them exactly as written.** Two traps they defuse:

- `has_permission`'s second parameter is named **`_code`**, not `_permission`. Postgres
  `create or replace function` cannot rename an input parameter; it aborts with
  `cannot change name of input parameter "_code"`.
- `is_staff` uses an explicit role allow-list, **not** `role <> 'tenant'`. The two are not
  equivalent — `<>` would silently grant staff status to custom roles the list excludes.

```sql
-- ---------------------------------------------------------------------------
-- ٣. يمنع الحساب الموقوف من اجتياز فحوص الصلاحيات.
--
-- Defence in depth, not decoration: the anon key and Supabase URL are compiled
-- into the browser bundle, so a login-form check alone is bypassable by calling
-- GoTrue directly. This makes any token that is obtained anyway read nothing.
--
-- No RLS recursion: `profiles_select_own_or_admin` calls has_permission, and
-- has_permission now reads profiles. Both functions are SECURITY DEFINER owned
-- by `postgres`, which owns `profiles`, and the table does not have FORCE ROW
-- LEVEL SECURITY — so the definer's read bypasses the policy instead of
-- re-entering it. Verified against production before this was written.
-- ---------------------------------------------------------------------------
create or replace function public.is_staff(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = _user_id and p.is_active
  ) and exists (
    select 1 from public.user_roles
    where user_id = _user_id
      and role in ('admin', 'accountant', 'collector', 'readonly')
  )
$$;

create or replace function public.has_permission(_user_id uuid, _code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = _user_id and p.is_active
  ) and coalesce(
    public.has_role(_user_id, 'admin')
    or exists (
      select 1
      from public.user_roles ur
      join public.role_permissions rp on rp.role = ur.role
      where ur.user_id = _user_id
        and rp.permission_code = _code
    )
    or exists (
      select 1
      from public.user_custom_roles ucr
      join public.custom_roles cr on cr.id = ucr.custom_role_id
      join public.custom_role_permissions crp on crp.custom_role_id = cr.id
      where ucr.user_id = _user_id
        and cr.is_active = true
        and crp.permission_code = _code
    ),
    false
  )
$$;
```

**`has_role` gets the same clause, and it matters more than the other two.** It is the single
definition at `01:101-112` and has 74 call sites, including every admin policy on `profiles` itself
(`01:141`, `:148`, `:153-154`), `companies_write_admin`, and `branding_admin_write` on
`storage.objects` (`21:41-45`). Leave it ungated and a deactivated **admin** holding a valid token
keeps read and write access to every profile row in the system — the highest-privilege role would be
the least defended, which is backwards.

```sql
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = _user_id and p.is_active
  ) and exists (
    select 1 from public.user_roles
    where user_id = _user_id and role = _role
  )
$$;
```

The recursion worry applies here too and resolves the same way — `has_role` is the function
`profiles_select_own_or_admin` calls, and it is SECURITY DEFINER owned by `postgres`, which owns
`profiles`, with no FORCE ROW LEVEL SECURITY anywhere. The added `exists` is a primary-key probe;
`stable` remains correct.

Close with the grants those functions carry today (copy them from the source migrations, including
`96_revoke_anon_execute_on_definer_functions.sql`'s `revoke … from public, anon`) and:

```sql
notify pgrst, 'reload schema';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:sql -- deactivationEnforcement`
Expected: PASS, all three tests.

- [ ] **Step 5: Run the full SQL suite, and expect one known failure**

Run: `bun run test:sql`

**`src/db/contractCloseout.sqltest.ts:455` will fail, and that is correct.** The test is named
*"8. profiles.is_active becomes false via trigger; RPC does not write profiles in close_out"* and
asserts `expect(profile.rows[0].is_active).toBe(false)` at `:496`. That assertion pins the crossed
behaviour this migration exists to remove. Update it to assert
`tenants.tenant_portal_enabled === false` instead, and rename the test to match what it now checks.

That is the **only** assertion you may change. If any other test fails, it is a real regression —
report it, do not adjust it. List every changed assertion explicitly in your report.

- [ ] **Step 5b: Prove the migration applies to a virgin database**

Run: `bun run test:db`
Expected: PASS. `CLAUDE.md` requires this for any migration — it builds the database from scratch in
numeric order, which is the only thing that proves 142 applies cleanly on top of 01/16/21/87/114
rather than only against your already-migrated local copy.

- [ ] **Step 6: Report — do not commit**

**What this task does not close (state it in your report, do not try to fix it here).** The
`is_active` clause covers every path that goes through `has_permission` or `is_staff` — that is all
staff access. It does **not** cover tenants: the portal policies derive access straight from the
profile row (`06:100-107`) and never consult `is_active`. There are 32 such predicates across ~15
migrations and no single helper to patch. Tenants are closed by the ban in Task 5 instead, which
leaves a residual window of at most one hour (production runs `GOTRUE_JWT_EXP=3600`). That is a
deliberate, accepted trade — do not expand this task to chase it.

---

### Task 2: Reject deactivated accounts at the login server function

**Files:**
- Modify: `src/fns/signInWithIdentifier.ts:78-139`
- Test: `src/fns/signInWithIdentifier.test.ts`

**Interfaces:**
- Consumes: Task 1's migration (not required to run — this task is pure TS).
- Produces: `signInWithIdentifier` returning `{ ok: false, error: "ACCOUNT_DEACTIVATED" }` in addition
  to its existing `{ ok: true, accessToken, refreshToken }` and
  `{ ok: false, error: "INVALID_CREDENTIALS" }`. Task 3 depends on this exact string.

**Context you need.** Two deliberate properties of the current code must survive:

1. `findAccountEmail` returning `null` falls through to the legacy `<username>@users.local`
   mapping so that an unknown identifier still costs a real password check. That is an
   anti-enumeration measure. Keep it.
2. The single `INVALID_CREDENTIALS` message for every failure exists so the form is not an
   account-existence oracle. Keep it for every failure *except* deactivation, which the product
   owner has explicitly chosen to surface.

**Therefore the flag check runs only on an otherwise-successful login.** Do not check `is_active`
before verifying the password — that would tell an attacker with no credentials that an account
exists and is deactivated. Verify first, then discard the session.

Be clear about what that does and does not buy, because the `user_banned` branch below is a
different case and the two are easily conflated. Once Task 5's ban is set, GoTrue rejects the
account *before* it checks the password, so `user_banned` comes back to anyone who asks — the
existence leak is real, and it is GoTrue's, reachable by calling `/token` directly whether or not
this function mirrors it. The post-password `is_active` check therefore protects exactly one state:
`is_active = false` with no ban yet, which is the gap between a failed ban and its retry. Keep both
branches, and do not write comments claiming the pair is oracle-free.

- [ ] **Step 1: Write the failing tests**

Add to `src/fns/signInWithIdentifier.test.ts`, matching the mocking style already in that file:

```ts
test("an active account signs in and receives its tokens", async () => {
  profileRows = [{ email: "active@example.test", is_active: true }];
  signInResult = { data: { session: { access_token: "a", refresh_token: "r" } }, error: null };

  const result = await callHandler({ identifier: "active", password: "pw" });

  expect(result).toEqual({ ok: true, accessToken: "a", refreshToken: "r" });
});

test("a deactivated account is refused even with the correct password", async () => {
  profileRows = [{ email: "off@example.test", is_active: false }];
  signInResult = { data: { session: { access_token: "a", refresh_token: "r" } }, error: null };

  const result = await callHandler({ identifier: "off", password: "correct-pw" });

  expect(result).toEqual({ ok: false, error: "ACCOUNT_DEACTIVATED" });
});

test("an unbanned deactivated account is not revealed to someone without the password", async () => {
  profileRows = [{ email: "off@example.test", is_active: false }];
  signInResult = { data: { session: null }, error: { message: "Invalid login credentials" } };

  const result = await callHandler({ identifier: "off", password: "wrong-pw" });

  // Only reachable while `is_active` is false but `banned_until` is not yet set
  // — the window between a failed ban and its retry. Once the account is banned,
  // GoTrue answers `user_banned` to any password and the case below applies.
  expect(result).toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
});

test("a banned account reports deactivation rather than bad credentials", async () => {
  profileRows = [{ email: "off@example.test", is_active: false }];
  signInResult = { data: { session: null }, error: { code: "user_banned", message: "User is banned" } };

  const result = await callHandler({ identifier: "off", password: "correct-pw" });

  expect(result).toEqual({ ok: false, error: "ACCOUNT_DEACTIVATED" });
});
```

If the existing test file has no `callHandler` helper, add one that invokes the handler the same way
the file's current tests do. **Note:** the `createServerFn` mock in this project skips `.validator()`
/ `.inputValidator()`, so the Zod schema never runs in tests. Export the schema from the module and
assert on it directly if you add schema coverage.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- signInWithIdentifier`
Expected: FAIL — the deactivation cases return `{ ok: true, ... }` or `INVALID_CREDENTIALS`.

- [ ] **Step 3: Widen the lookup and add the check**

In `findAccountEmail`, change the return type to carry the flag and widen both reads:

```ts
type ResolvedAccount = { email: string; isActive: boolean };

/**
 * يحوّل المعرّف المكتوب إلى بريد الحساب وحالته، أو null إذا تعذّر التحديد.
 *
 * `is_active` travels with the email rather than being fetched later so the
 * deactivation decision cannot race a second round-trip, and so an ambiguous
 * match still resolves to nothing at all.
 */
async function findAccountEmail(identifier: string): Promise<ResolvedAccount | null> {
```

For the username/email branch select `"email, is_active"`; for the phone branch, the RPC
`find_profiles_by_phone_digits` returns only `id, email`, so read the flag with a follow-up
`supabaseAdmin.from("profiles").select("is_active").eq("id", match.id).single()`. Return
`{ email, isActive }`; keep every `return null` exactly where it is.

In the handler:

```ts
const resolved = await findAccountEmail(data.identifier);
const email = resolved?.email ?? loginIdentifierToEmail(data.identifier);

const { data: session, error } = await anonClient().auth.signInWithPassword({
  email,
  password: data.password,
});

// GoTrue refuses a banned account before it checks the password, so this is the
// only signal available once `banned_until` is set — without it a deactivated
// user would be told their credentials were wrong.
//
// This does leak that the account exists and is disabled, to anyone, with any
// password. That leak is GoTrue's, not ours: `POST /token` returns the same
// `user_banned` to a direct caller whatever this function does. Mirroring it
// here costs nothing an attacker cannot already obtain, and the alternative is
// telling a real deactivated tenant their password is wrong.
if (error && (error as { code?: string }).code === "user_banned") {
  return { ok: false as const, error: "ACCOUNT_DEACTIVATED" };
}

if (error || !session.session) {
  return { ok: false as const, error: "INVALID_CREDENTIALS" };
}

// Checked only after the password verifies. Returning this on a failed password
// would turn the form into an oracle for which accounts exist and are disabled.
if (resolved && !resolved.isActive) {
  return { ok: false as const, error: "ACCOUNT_DEACTIVATED" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- signInWithIdentifier`
Expected: PASS.

- [ ] **Step 5: Report — do not commit**

---

### Task 3: Stop the client fallback from bypassing the rejection

**Files:**
- Modify: `src/auth/AuthProvider.tsx:62-83`
- Create: `src/auth/AuthProvider.test.tsx`

**Interfaces:**
- Consumes: `ACCOUNT_DEACTIVATED` from Task 2.
- Produces: `signInWithPassword` returning `{ error: "ACCOUNT_DEACTIVATED" }` without calling the
  direct Supabase path. Task 4 renders that string.

**Context you need.** The fallthrough is deliberate and documented in the file: if the resolver
server function is unavailable (cold start, network blip), login still works through the direct
client-side path, so a resolver outage cannot lock anyone out. **Do not delete the fallback.** Carve
out the deactivation case only — everything else keeps falling through exactly as today.

- [ ] **Step 1: Write the failing test**

Create `src/auth/AuthProvider.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

const signInWithIdentifier = vi.fn();
const directSignIn = vi.fn();

vi.mock("@/fns/signInWithIdentifier", () => ({
  signInWithIdentifier: (args: unknown) => signInWithIdentifier(args),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
      setSession: vi.fn().mockResolvedValue({ error: null }),
      signInWithPassword: (args: unknown) => directSignIn(args),
    },
  },
}));

import { AuthProvider, useAuth } from "@/auth/AuthProvider";

function Harness() {
  const { signInWithPassword } = useAuth();
  return (
    <button
      onClick={async () => {
        const { error } = await signInWithPassword("someone", "pw");
        document.title = error ?? "ok";
      }}
    >
      go
    </button>
  );
}

beforeEach(() => {
  signInWithIdentifier.mockReset();
  directSignIn.mockReset();
  directSignIn.mockResolvedValue({ error: null });
});

describe("the direct sign-in fallback", () => {
  test("is not reached when the account is deactivated", async () => {
    signInWithIdentifier.mockResolvedValue({ ok: false, error: "ACCOUNT_DEACTIVATED" });

    render(<AuthProvider><Harness /></AuthProvider>);
    await userEvent.click(screen.getByRole("button", { name: "go" }));

    // The whole point: falling through here would sign the user in anyway via
    // the legacy <username>@users.local mapping.
    await waitFor(() => expect(document.title).toBe("ACCOUNT_DEACTIVATED"));
    expect(directSignIn).not.toHaveBeenCalled();
  });

  test("is still reached when the resolver throws", async () => {
    signInWithIdentifier.mockRejectedValue(new Error("offline"));

    render(<AuthProvider><Harness /></AuthProvider>);
    await userEvent.click(screen.getByRole("button", { name: "go" }));

    await waitFor(() => expect(directSignIn).toHaveBeenCalledTimes(1));
  });

  test("is still reached on ordinary bad credentials", async () => {
    signInWithIdentifier.mockResolvedValue({ ok: false, error: "INVALID_CREDENTIALS" });

    render(<AuthProvider><Harness /></AuthProvider>);
    await userEvent.click(screen.getByRole("button", { name: "go" }));

    await waitFor(() => expect(directSignIn).toHaveBeenCalledTimes(1));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- AuthProvider`
Expected: FAIL on the first case — `directSignIn` is called once.

- [ ] **Step 3: Carve out the deactivation case**

Inside the `try` block in `signInWithPassword`, after the `if (result.ok)` branch:

```ts
// The only non-ok result that must NOT fall through. Everything else keeps the
// documented resilience: if the resolver cannot answer, the direct path below
// still produces the real outcome. But a deactivated account that fell through
// would authenticate against `<username>@users.local` and be let straight in,
// which would make the whole check cosmetic.
if (result.error === "ACCOUNT_DEACTIVATED") {
  return { error: "ACCOUNT_DEACTIVATED" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- AuthProvider`
Expected: PASS, all three.

- [ ] **Step 5: Report — do not commit**

---

### Task 4: Show the deactivation message on both login pages

**Files:**
- Modify: `src/routes/auth.tsx`, `src/routes/portal_.auth.tsx`
- Modify: `src/i18n/` dictionaries (both `ar` and `en`)

**Interfaces:**
- Consumes: `{ error: "ACCOUNT_DEACTIVATED" }` from Task 3.
- Produces: nothing downstream.

**Context you need.** `src/i18n/dictionary.test.ts` fails the suite if a key exists in one locale and
not the other, and also checks that every `t("literal")` in the codebase resolves. Add the key to
both locales in the same change.

- [ ] **Step 1: Add the dictionary key to both locales**

`src/i18n/dictionary.ts` holds both locales in one file as flat dotted keys. The existing auth
errors are `auth.error.invalid` and `auth.error.generic` (ar at `:83-84`, en at the mirroring
position around `:1808`), plus `auth.error.notStaff` (`:1182`). Add, in both blocks:

- key: **`auth.error.deactivated`**
- `ar`: `"تم إيقاف الحساب. يرجى التواصل مع الإدارة."`
- `en`: `"Account is deactivated. Please contact the administrator."`

- [ ] **Step 2: Render it in both login pages**

`src/routes/auth.tsx:72-73` currently maps every failure with:

```ts
err.toLowerCase().includes("invalid") ? t("auth.error.invalid") : t("auth.error.generic")
```

`"ACCOUNT_DEACTIVATED"` does not contain `"invalid"`, so without a new branch it falls to
`auth.error.generic` and the deactivation message never appears — the task would look done and do
nothing. Branch on the exact string **first**, in `auth.tsx` and in the matching place in
`portal_.auth.tsx`:

```ts
setError(
  err === "ACCOUNT_DEACTIVATED"
    ? t("auth.error.deactivated")
    : err.toLowerCase().includes("invalid")
      ? t("auth.error.invalid")
      : t("auth.error.generic"),
);
```

- [ ] **Step 3: Run the suite**

Run: `bun run test -- dictionary`
Expected: PASS — proves parity and that the new key resolves.

- [ ] **Step 4: Report — do not commit**

---

### Task 5: Move deactivation server-side and ban at the issuer

**Files:**
- Create: `src/fns/setUserActive.ts`
- Modify: `src/hooks/useUsers.ts:223-252`
- Test: `src/fns/setUserActive.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `setUserActive({ data: { userId: string, isActive: boolean } })` returning
  `{ ok: true } | { ok: false, error: string }`.

**Context you need.** Today `useSetUserActive` updates `profiles` straight from the browser under
RLS and writes an audit row. That cannot set `auth.users.banned_until`, which is what actually stops
GoTrue issuing tokens and kills existing refresh tokens — requirement 3. Move the write to a server
function using `supabaseAdmin` (service role), and keep the audit row.

Model the new file on an existing server function that already uses `supabaseAdmin` and
`requireSupabaseAuth` — read `src/fns/createAppUser.ts` first and follow its structure, including how
it authorises the caller.

**The caller must be permission-checked on `users.update`.** This is not a judgement call: the
browser update you are replacing was gated by the RLS policy `profiles_update_own_or_admin`
(`db/migrations/03_phase1_permissions_audit.sql:397`), whose predicate is
`auth.uid() = id or public.has_permission(auth.uid(), 'users.update')`. A service-role function
bypasses RLS entirely, so anything looser silently widens who can deactivate users. Check
`users.update`, and reject otherwise.

While you are moving it: the current audit row writes `before: { is_active: !isActive }` — a guess
inferred from the new value. Server-side you can read the row first, so write the **actual** prior
value.

- [ ] **Step 1: Write the failing test**

Create `src/fns/setUserActive.test.ts` asserting: deactivating updates `profiles.is_active` to
`false` **and** calls the admin API with a non-null `ban_duration`/`banned_until`; reactivating sets
`is_active` true and clears the ban; a caller without the permission is refused with
`{ ok: false }` and neither write happens. Mock `supabaseAdmin` the way the sibling `src/fns` tests do.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test -- setUserActive`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the server function**

**Order the two writes so a failure cannot leave a deactivated-but-unbanned row.** They are not in
one transaction: profile state lives in Postgres, the ban lives in GoTrue. Write the profile first
and the ban second, and a GoTrue blip leaves exactly the hole this whole task exists to close — the
admin sees "deactivated", the login form refuses, and a direct GoTrue password grant still works,
forever, with nothing to retry it.

So: **on deactivate, ban first, then write the profile; if the profile write fails, lift the ban
again before returning the error.** On reactivate, reverse it — write the profile first, then lift
the ban — so the failure direction is always toward "still locked out" rather than "quietly open".
Task 5 requires a test for the compensation path.

```ts
await supabaseAdmin.auth.admin.updateUserById(userId, {
  ban_duration: isActive ? "none" : "876000h",
});
```

`ban_duration` is confirmed available in this repo's installed version — `@supabase/supabase-js`
`^2.110.2` (`package.json:47`) declares `ban_duration?: string | 'none'` on `AdminUserAttributes`
(`node_modules/@supabase/auth-js/dist/module/lib/types.d.ts:455`). You do not need to hunt for an
alternative. `"none"` is the documented clear value; `"876000h"` is ~100 years.

Write the audit row (with the real `before` value, per above) and return `{ ok: true }`.

**Do not call `logAuditForCurrentSession`.** It is browser-only by construction: it reads the
Supabase session from the browser client and throws `Cannot write an audit log without an
authenticated session` when there isn't one (`src/lib/audit.ts:18-20`). Server-side, use the RPC
directly the way `src/fns/createAppUser.ts:120` does:

```ts
await supabaseAdmin.rpc("write_audit" as any, { /* … */ });
```

Follow `createAppUser`'s argument names exactly rather than inventing them.

- [ ] **Step 4: Point the hook at it**

Replace the body of `useSetUserActive` with a call to the new server function, keeping the
`onSuccess` invalidation of `["users-with-roles"]` intact. The audit call moves into the server
function — do not write it twice.

- [ ] **Step 5: Run the tests**

Run: `bun run test -- setUserActive` then `bun run test -- useUsers`
Expected: PASS.

- [ ] **Step 6: Report — do not commit**

---

### Task 6: Gallery "in gallery" toggle can be switched off

**Files:**
- Modify: `src/components/admin/landing-page/GalleryTable.tsx:68`
- Modify: `src/routes/admin.settings.landing-page.tsx:588-603`
- Test: `src/components/admin/landing-page/GalleryTable.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

**Context you need.** Line 68 reads
`const shown = !!media.show_in_gallery && media.is_active !== false;`. For a row that is inactive but
flagged, `shown` is `false`, so the menu sends `!shown === true` — it tries to turn the flag *on* and
can never turn it off. The parent handler already writes `show_in_gallery` alone, so only the
derivation is wrong. Two different facts were being packed into one boolean.

- [ ] **Step 1: Write the failing test**

Create `src/components/admin/landing-page/GalleryTable.test.tsx`. Render a `GalleryTable` with one
item where `show_in_gallery: true, is_active: false`, open the actions menu, click "In gallery", and
assert `onToggleGalleryItem` was called with `(id, false)`.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test -- GalleryTable`
Expected: FAIL — called with `(id, true)`.

- [ ] **Step 3: Split the two facts**

```ts
// `is_active` is a different question from "is this flagged for the gallery",
// and folding it in here made the flag unreachable: an inactive-but-flagged row
// computed `shown === false`, so the menu only ever offered to switch it ON.
const shown = !!media.show_in_gallery;
const hiddenByInactive = shown && media.is_active === false;
```

Render `hiddenByInactive` as secondary text inside `CardContent` so the row still reads as not
actually visible:

```tsx
{hiddenByInactive ? (
  <p className="text-xs text-muted-foreground">
    {locale === "ar" ? "مخفي — العنصر غير مُفعّل" : "Hidden — item inactive"}
  </p>
) : null}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run test -- GalleryTable`
Expected: PASS.

- [ ] **Step 5: Add optimistic update and rollback**

In `src/hooks/useLandingSettings.ts`, give the media update mutation an `onMutate` that cancels
in-flight queries, snapshots the previous data, writes the new `show_in_gallery` into the cache, and
returns the snapshot; an `onError` that restores it; and an `onSettled` that invalidates.

The list query key is `["landing_media", category]` (`:178`) and the mutations already invalidate
the **prefix** `["landing_media"]` (`:208`, `:227`, `:240`). Cancel and snapshot on the prefix too —
the toggle does not know which category partition the row sits in, so keying the optimistic write to
one partition would miss it.

- [ ] **Step 6: Run the suite and report — do not commit**

---

### Task 7: Empty states for the shop and slide grids

**Files:**
- Create: `src/components/ui/empty-state.tsx`
- Create: `src/components/ui/empty-state.test.tsx`
- Modify: `src/components/admin/landing-page/ShopsTable.tsx:44-56`
- Modify: `src/components/admin/landing-page/SlidesTable.tsx:31-42`
- Modify: `src/components/admin/landing-page/GalleryTable.tsx:27-35`

**Interfaces:**
- Consumes: nothing.
- Produces: `<EmptyState icon={LucideIcon} title={string} description?={string}>{action?}</EmptyState>`.

**Context you need.** Both grids render `x?.map(...)` with no empty branch, so they show blank space.
**The trap:** they take `T[] | undefined`, where `undefined` means *loading* and `[]` means *empty*.
Gating on falsy-or-empty flashes "No shops yet" on every page load. Gate on
`Array.isArray(x) && x.length === 0` and render nothing while `undefined`.

- [ ] **Step 1: Write the failing tests**

Create `src/components/ui/empty-state.test.tsx` (renders title, description, and action). Add to (or
create) tests for the two tables asserting: `undefined` renders neither the empty state nor a card;
`[]` renders the empty state; a populated array renders cards and no empty state.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun run test -- empty-state ShopsTable SlidesTable`
Expected: FAIL — module not found; tables render nothing for `[]`.

- [ ] **Step 3: Build the component**

```tsx
/**
 * حالة فارغة موحّدة: أيقونة وعنوان ووصف وإجراء اختياري.
 *
 * The three landing-page grids each rendered emptiness differently — two as
 * blank space, one as a bare paragraph. One component so they cannot drift.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center">
      <Icon className="size-10 text-muted-foreground" aria-hidden />
      <p className="mt-4 text-sm font-medium">{title}</p>
      {description ? (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      ) : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}
```

- [ ] **Step 4: Use it in all three tables**

In `ShopsTable`, before the grid:

```tsx
if (Array.isArray(brands) && brands.length === 0) {
  return (
    <EmptyState
      icon={Building}
      title={locale === "ar" ? "لا توجد محلات بعد" : "No shops yet"}
      description={
        locale === "ar"
          ? "اضغط «إضافة محل» لعرض أول محل على الصفحة الرئيسية."
          : "Click “Add Shop” to show the first shop on the landing page."
      }
    />
  );
}
```

`ShopsTable.tsx` already imports `useI18n` (`:9`) and calls it inside `ShopCard` (`:74`) — the
outer `ShopsTable` function needs its own `const { locale } = useI18n();`. Do the same in
`SlidesTable` with the `ImageIcon` icon and `لا توجد شرائح بعد` / `No slides yet`, and replace
`GalleryTable`'s existing `<p>` block (lines 27–35) with an `EmptyState` carrying its current copy
verbatim.

- [ ] **Step 5: Run them to verify they pass, then report — do not commit**

---

### Task 8: Bilingual tenant names in scheduled and emailed reports

**Files:**
- Create: `db/migrations/143_bilingual_report_names.sql`
- Test: `src/db/bilingualReportNames.sqltest.ts`

**Interfaces:**
- Consumes: Task 1's migration number (this one is **143**, after it).
- Produces: `public.tenant_display_name(public.tenants, boolean)`.

**Context you need — read this carefully, it is the whole risk.** Four migrations define
`build_scheduled_report_html` (07, 31, 44, 106). `create or replace` means **the highest-numbered
body is live: migration 106**, lines 244–806. Migration 44 is *stale* — do not copy from it. The two
tenant-name sites are `106:366` (payment rows) and `106:390` (overdue rows), both
`coalesce(t.name, '—')`.

`create or replace function` cannot patch a body, so this migration re-issues the **entire ~560-line
function** from migration 106 to change two expressions. **The failure mode is transcription, not
logic.** Copy the body mechanically; do not reformat, reorder, or "improve" anything you are not
explicitly told to change.

**The ordering constraint, and it is smaller than it looks.** `v_is_ar` is assigned at `106:411`,
after both row queries at `:366` and `:390`, so it must move. This is a **one-line move, not a
restructure**: `v_schedule` is already populated at `106:308` — 58 lines before the first row query
— and nothing between 308 and 411 reassigns it. Move the single line
`v_is_ar := v_schedule.locale = 'ar';` to immediately after `:308` and delete it from `:411`.
Change nothing else about the ordering. Reorganising anything inside a verbatim copy is the most
dangerous thing you can do in this task.

- [ ] **Step 1: Write the failing test**

Create `src/db/bilingualReportNames.sqltest.ts`. Seed a company, a schedule with `locale = 'ar'` and
another with `locale = 'en'`, a tenant with `commercial_name_ar = 'شركة الاختبار'`,
`commercial_name_en = 'Test Trading Co'`, `name = 'عبد الله'`, and a confirmed payment in the
period.

`report_schedules` has four required columns with no default — `code`, `name_ar`, `frequency` and
`recipients` (jsonb) — plus `locale`, which is the enum `locale_code` and defaults to `'ar'`, so the
English schedule must set it explicitly. `frequency` accepts `daily | weekly | monthly | yearly`
(see the `v_start` case at `106:312`). A minimal insert:

```sql
insert into public.report_schedules (id, code, name_ar, name_en, frequency, recipients, locale)
values ($1, $2, 'تقرير اختبار', 'Test report', 'monthly', '[]'::jsonb, $3)
```

`tenants` requires only `name`; `contracts` requires `tenant_id`, `start_date` and `end_date`.

Then assert on the **rendered HTML**:

```ts
test("an Arabic schedule prints the Arabic trade name", async () => {
  await withRollback(async (client) => {
    const { arScheduleId } = await seed(client);
    const { rows } = await client.query(
      `select public.build_scheduled_report_html($1, current_date) as html`,
      [arScheduleId],
    );
    expect(rows[0].html).toContain("شركة الاختبار");
    expect(rows[0].html).not.toContain("Test Trading Co");
  });
});

test("an English schedule prints the English trade name", async () => { /* mirror */ });

test("an English schedule with no English trade name keeps the Arabic one", async () => {
  // A commercial party stays a commercial party: falling back to the tenant's
  // personal name would print a different legal entity on the report.
});
```

Asserting on rendered HTML rather than on the function existing is deliberate — it is the only thing
that catches a bad copy of the 560 lines.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test:sql -- bilingualReportNames`
Expected: FAIL — the HTML contains `عبد الله`, the personal name.

- [ ] **Step 3: Write migration 143**

Add the helper, then re-issue `build_scheduled_report_html` from migration 106 verbatim with exactly
three changes: the hoisted `v_is_ar`, and the two name expressions becoming
`public.tenant_display_name(t.*, v_is_ar)`.

```sql
-- ---------------------------------------------------------------------------
-- يختار اسم الطرف بلغة التقرير: الاسم التجاري أولاً، ثم اسم المستأجر.
--
-- Mirrors resolvePartyName in src/lib/partyName.ts, which does this for print,
-- download and email. The SQL report builder never got migration 140's split
-- and printed the Arabic name on English reports.
-- ---------------------------------------------------------------------------
create or replace function public.tenant_display_name(t public.tenants, p_is_ar boolean)
returns text
language sql
immutable
as $$
  select case when p_is_ar
    then coalesce(nullif(btrim(t.commercial_name_ar), ''),
                  nullif(btrim(t.commercial_name_en), ''),
                  nullif(btrim(t.commercial_name),    ''),
                  nullif(btrim(t.name),               ''),
                  nullif(btrim(t.name_en),            ''))
    else coalesce(nullif(btrim(t.commercial_name_en), ''),
                  nullif(btrim(t.commercial_name_ar), ''),
                  nullif(btrim(t.commercial_name),    ''),
                  nullif(btrim(t.name_en),            ''),
                  nullif(btrim(t.name),               ''))
  end;
$$;
```

Keep the existing HTML escaping around the name — the `replace(replace(replace(…)))` chain stays,
wrapping the helper call instead of `coalesce(t.name, '—')`, and keep `'—'` as the final fallback for
a null tenant. Close with the same `revoke`/`grant` lines migration 106 carries and
`notify pgrst, 'reload schema';`.

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run test:sql -- bilingualReportNames`
Expected: PASS, all three.

- [ ] **Step 5: Prove the copy is faithful**

Run: `bun run test:sql`
Expected: PASS. Any pre-existing report test that breaks means the 560-line copy drifted — find the
drift, do not adjust the test.

- [ ] **Step 6: Report — do not commit**

---

## Verification before hand-back

Run all four gates from a clean tree and paste the actual output:

```bash
bun run lint && bun run typecheck && bun run test && bun run test:sql && bun run test:db
```

Then confirm each spec requirement has a task: deactivation blocks login (2, 3, 4), sessions die
(5), portal toggle stays separate (1), gallery toggle works on inactive rows (6), empty states (7),
bilingual reports (8).
