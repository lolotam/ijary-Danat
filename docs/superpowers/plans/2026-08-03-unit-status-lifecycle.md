# Unit Status Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `units.status` a trigger-maintained projection of active contracts, so a unit reads `occupied` exactly when a live contract exists and `vacant` otherwise, while leaving `under_maintenance` and `archived` under operator control.

**Architecture:** Enforcement lives entirely in Postgres, mirroring the existing precedent in `db/migrations/54_tenant_lifecycle_and_unit_names.sql`, which derives `tenants.lifecycle` from the same table. A trigger on `contracts` recomputes both the old and the new `unit_id`; a `BEFORE` trigger on `units` normalizes retired values and refuses an update that would contradict a live contract. The application layer only narrows what the status dropdown offers.

**Tech Stack:** Postgres 17 (self-hosted Supabase), plpgsql triggers, Vitest SQL integration suite (`bun run test:sql` / `bun run test:db`), React 19 + TanStack Start, react-hook-form + Zod, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-08-03-unit-status-lifecycle-design.md`

## Global Constraints

- Branch is `fix/unit-status-derived-from-contracts`, created off `36abde0` (`main`, which includes the merged PR #66). Do **not** commit anything outside the files each task names. Always `git add` by explicit path, never `git add -A` or `git add .` — the working tree carries unrelated modified files (`graphify-out/`, several `docs/` and `stitch_*/` files) that belong to other work.
- **Other agents are committing in this repository concurrently.** PR #66 (`feat/unified-workflows-recipient-targets`) landed `db/migrations/75_unified_workflow_recipient_targets.sql` while this was being planned, which is why this work takes **76** and every reference below says 76. That migration is already applied to the live database — `select count(*) from information_schema.columns where table_name='cron_jobs' and column_name='recipient_targets'` returns 1 — despite its commit message claiming otherwise.
- **Re-check the migration number before creating the file:** `git fetch origin main && git ls-tree -r --name-only origin/main -- db/migrations | tail -3`. If 76 has been taken by the time you run, renumber consistently across the migration, the tests and Task 6 rather than reusing a number. Rebase on `origin/main` before opening the PR for the same reason.
- No file overlap is expected with the concurrent work: PR #66 touched `cron_jobs`, `src/fns/*` and four added lines in `database.types.ts`; this touches `units`, `contracts`, the two unit-editing routes, `bulkImportSchemas.ts`, `dictionary.ts` and `Phase2FormFields.tsx`. `database.types.ts` needs no change here — `UnitStatus` keeps all six values.
- **Never edit an already-applied migration in place.** Migrations 04, 08, 13, 15 and 16 have run in production; an in-place edit passes `bun run test:db` and changes nothing on the live database. All new SQL goes in `db/migrations/76_unit_status_lifecycle.sql`.
- Migration 76 must be **idempotent** — `create or replace function`, `drop trigger if exists` before `create trigger`, and guarded `update … where … is distinct from …`.
- All new SQL functions are `security definer` with `set search_path = public`, matching the house style in migration 54. This is load-bearing, not defensive: RLS updates zero rows _silently_ rather than raising, so a missing definer would stop the sync for some users while every test still passed.
- The occupancy predicate is exactly `state = 'active' and archived_at is null`. Not date-based.
- `public.unit_status` keeps all six enum values. Postgres cannot drop an enum value; `available` and `reserved` simply become unreachable.
- Any new i18n key must be added to **both** the `ar` and `en` blocks of `src/i18n/dictionary.ts`. The dictionary is `Record<string, string>` per locale with no parity check, so a key present in one locale ships as raw key text and `bun run typecheck` will not catch it.
- Gates before the PR: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:db`. `bun run test:db` needs Docker.
- Do not apply anything to production until Task 6.

---

### Task 1: Migration 76 — the derived-status mechanism

Creates the four SQL functions and two triggers. No backfill yet; existing rows stay wrong until Task 2. On a freshly built test database the invariant already holds after this task, because migration 15's mock data inserts units before contracts, so the triggers fire during the seed.

**Files:**

- Create: `db/migrations/76_unit_status_lifecycle.sql`
- Create: `src/db/unitStatus.sqltest.ts`

**Interfaces:**

- Consumes: `seedContract(client, {startDate, endDate, state?})` from `@/db/testDb`, returning `{companyId, propertyId, unitId, tenantId, contractId}`. It inserts the unit **before** the contract, so the unit is created vacant and then flipped by the contract trigger.
- Produces:
  - `public.unit_has_active_contract(_unit uuid) returns boolean`
  - `public.compute_unit_status(_unit uuid, _current public.unit_status) returns public.unit_status`
  - `public.sync_unit_status_for(_unit uuid) returns public.unit_status`
  - trigger `trg_contract_sync_unit_status` on `public.contracts`
  - trigger `trg_unit_enforce_derived_status` on `public.units`
  - Task 2 appends to the same migration file and relies on `unit_has_active_contract` and `compute_unit_status` existing.

- [ ] **Step 1: Write the failing test file**

Create `src/db/unitStatus.sqltest.ts`:

```typescript
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { actAs, actAsSuperuser, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 76 — `units.status` is derived from `public.contracts`.
 *
 * Before this migration nothing connected the two: production carried 41 units
 * marked `occupied` with no contract behind them and 3 units holding a live
 * contract while marked `available`, most of it inherited from the mock-data
 * seed in migration 15. None of this is reachable from the mock suite — the
 * whole feature is two triggers.
 */

async function statusOf(client: PoolClient, unitId: string): Promise<string> {
  const { rows } = await client.query<{ status: string }>(
    `select status from public.units where id = $1`,
    [unitId],
  );
  return rows[0].status;
}

/** An auth user holding `role`, so has_permission resolves for it. Same shape
 *  as the helper in src/db/lifecycle.sqltest.ts:26-38. */
async function seedUserWithRole(client: PoolClient, role: string): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@example.test`],
  );
  await client.query(
    `insert into public.user_roles (user_id, role) values ($1, $2::public.app_role)`,
    [userId, role],
  );
  return userId;
}

/** A bare unit with no contract, for the cases seedContract cannot express. */
async function seedBareUnit(client: PoolClient, status?: string): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const company = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة ${tag}`, `Co ${tag}`],
  );
  const property = await client.query<{ id: string }>(
    `insert into public.properties (code, company_id, name_ar, name_en)
     values ($1, $2, $3, $4) returning id`,
    [`P-${tag}`, company.rows[0].id, `عقار ${tag}`, `Property ${tag}`],
  );
  const unit = await client.query<{ id: string }>(
    status === undefined
      ? `insert into public.units (code, property_id, name) values ($1, $2, $3) returning id`
      : `insert into public.units (code, property_id, name, status)
         values ($1, $2, $3, $4::public.unit_status) returning id`,
    status === undefined
      ? [`U-${tag}`, property.rows[0].id, `Unit ${tag}`]
      : [`U-${tag}`, property.rows[0].id, `Unit ${tag}`, status],
  );
  return unit.rows[0].id;
}

describe("occupancy follows the contract", () => {
  test("an active contract makes its unit occupied", async () => {
    await withRollback(async (client) => {
      const { unitId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      expect(await statusOf(client, unitId)).toBe("occupied");
    });
  });

  test("terminating the contract returns the unit to vacant", async () => {
    await withRollback(async (client) => {
      const { unitId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`update public.contracts set state = 'terminated' where id = $1`, [
        contractId,
      ]);
      expect(await statusOf(client, unitId)).toBe("vacant");
    });
  });

  test("archiving the contract returns the unit to vacant", async () => {
    // `useContracts` filters archived contracts out of every list, so an
    // archived contract must not go on holding a unit occupied.
    await withRollback(async (client) => {
      const { unitId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`update public.contracts set archived_at = now() where id = $1`, [
        contractId,
      ]);
      expect(await statusOf(client, unitId)).toBe("vacant");
    });
  });

  test("moving a contract between units frees the old one and takes the new one", async () => {
    // The classic omission in this pattern: recomputing only NEW.unit_id leaves
    // the origin unit stuck on 'occupied' forever.
    await withRollback(async (client) => {
      const { unitId: fromUnit, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const toUnit = await seedBareUnit(client);
      await client.query(`update public.contracts set unit_id = $1 where id = $2`, [
        toUnit,
        contractId,
      ]);
      expect(await statusOf(client, fromUnit)).toBe("vacant");
      expect(await statusOf(client, toUnit)).toBe("occupied");
    });
  });

  test("a unit whose only contract is a draft reads vacant", async () => {
    // Pins the decision that occupancy means state = 'active' only.
    await withRollback(async (client) => {
      const { unitId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "draft",
      });
      expect(await statusOf(client, unitId)).toBe("vacant");
    });
  });

  test("deleting an active contract frees the unit", async () => {
    // Seeded active, not draft: deleting a draft would start and end on
    // `vacant` and prove nothing about the DELETE branch of the trigger.
    await withRollback(async (client) => {
      const { unitId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      expect(await statusOf(client, unitId)).toBe("occupied");
      await client.query(`delete from public.contracts where id = $1`, [contractId]);
      expect(await statusOf(client, unitId)).toBe("vacant");
    });
  });

  test("freezing an active contract frees the unit", async () => {
    // Occupancy is state='active' only. `frozen` is in the nonTerminalStates
    // list assertUnitAvailable uses, so this pins the two apart.
    await withRollback(async (client) => {
      const { unitId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`update public.contracts set state = 'frozen' where id = $1`, [
        contractId,
      ]);
      expect(await statusOf(client, unitId)).toBe("vacant");
    });
  });

  test("un-archiving a still-active contract re-occupies the unit", async () => {
    await withRollback(async (client) => {
      const { unitId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`update public.contracts set archived_at = now() where id = $1`, [
        contractId,
      ]);
      expect(await statusOf(client, unitId)).toBe("vacant");
      await client.query(`update public.contracts set archived_at = null where id = $1`, [
        contractId,
      ]);
      expect(await statusOf(client, unitId)).toBe("occupied");
    });
  });
});

describe("manual statuses stay under operator control", () => {
  test("under_maintenance survives a contract write on the SAME unit", async () => {
    // The version of this test that writes a contract on a *different* unit
    // proves only that no global update ran — it never fires the trigger for
    // the unit being asserted on. Editing a draft contract that points at the
    // maintained unit does fire it, through the branch that must preserve the
    // operator's flag.
    await withRollback(async (client) => {
      const { unitId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "draft",
      });
      await client.query(`update public.units set status = 'under_maintenance' where id = $1`, [
        unitId,
      ]);
      await client.query(`update public.contracts set archived_at = null where id = $1`, [
        contractId,
      ]);
      expect(await statusOf(client, unitId)).toBe("under_maintenance");
    });
  });

  test("a maintenance flag does not survive a tenancy", async () => {
    // Decision 3 in the spec, asserted rather than assumed: the unit was let,
    // so the maintenance is presumed resolved and does not come back.
    await withRollback(async (client) => {
      const { unitId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "draft",
      });
      await client.query(`update public.units set status = 'under_maintenance' where id = $1`, [
        unitId,
      ]);
      await client.query(`update public.contracts set state = 'active' where id = $1`, [
        contractId,
      ]);
      expect(await statusOf(client, unitId)).toBe("occupied");
      await client.query(`update public.contracts set state = 'terminated' where id = $1`, [
        contractId,
      ]);
      expect(await statusOf(client, unitId)).toBe("vacant");
    });
  });

  test("archived survives a contract write on the SAME unit", async () => {
    await withRollback(async (client) => {
      const { unitId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "draft",
      });
      await client.query(`update public.units set status = 'archived' where id = $1`, [unitId]);
      await client.query(`update public.contracts set archived_at = null where id = $1`, [
        contractId,
      ]);
      expect(await statusOf(client, unitId)).toBe("archived");
    });
  });
});

describe("the sync survives a caller who cannot write units", () => {
  test("an accountant's contract edit still moves the unit", async () => {
    // The single test that would catch `security definer` being dropped from
    // sync_unit_status_for. RLS refuses by matching ZERO ROWS rather than
    // raising, so without definer rights the sync would silently stop for
    // non-admin users and every other test here would still pass — they all
    // run as the owner. src/db/lifecycle.sqltest.ts:206-249 drives exactly this
    // scenario for tenants but never asserts on the unit afterwards.
    await withRollback(async (client) => {
      const { unitId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "draft",
      });
      const accountant = await seedUserWithRole(client, "accountant");
      // actAs takes the POSTGRES role, with the app role carried by the seeded
      // user's user_roles row — not the app role directly.
      await actAs(client, "authenticated", accountant);
      await client.query(`update public.contracts set state = 'active' where id = $1`, [
        contractId,
      ]);
      await actAsSuperuser(client);
      expect(await statusOf(client, unitId)).toBe("occupied");
    });
  });
});

describe("the units guard normalises what callers ask for", () => {
  test("inserting a unit as available lands it vacant", async () => {
    await withRollback(async (client) => {
      const unitId = await seedBareUnit(client, "available");
      expect(await statusOf(client, unitId)).toBe("vacant");
    });
  });

  test("inserting a unit as reserved lands it vacant", async () => {
    await withRollback(async (client) => {
      const unitId = await seedBareUnit(client, "reserved");
      expect(await statusOf(client, unitId)).toBe("vacant");
    });
  });

  test("claiming occupied without a contract lands vacant", async () => {
    await withRollback(async (client) => {
      const unitId = await seedBareUnit(client, "occupied");
      expect(await statusOf(client, unitId)).toBe("vacant");
    });
  });

  test("a new unit defaults to vacant", async () => {
    await withRollback(async (client) => {
      const unitId = await seedBareUnit(client);
      expect(await statusOf(client, unitId)).toBe("vacant");
    });
  });

  test("overriding an occupied unit raises instead of snapping back", async () => {
    // Silence here would be the worse failure: the admin sets 'under
    // maintenance', the row reloads as 'occupied', and nothing explains why.
    await withRollback(async (client) => {
      const { unitId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await expect(
        client.query(`update public.units set status = 'under_maintenance' where id = $1`, [
          unitId,
        ]),
      ).rejects.toThrow(/active contract/i);
    });
  });

  test("editing an occupied unit's other columns still works", async () => {
    // The guard fires on every unit update, not only status changes; a rename
    // must not trip it.
    await withRollback(async (client) => {
      const { unitId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`update public.units set name = 'Renamed' where id = $1`, [unitId]);
      expect(await statusOf(client, unitId)).toBe("occupied");
    });
  });
});

describe("bulk import lands on the derived default", () => {
  test("an imported unit with a blank status is vacant, not available", async () => {
    // bulk_import_phase6 still hardcodes 'available' (migration 16:169). The
    // BEFORE INSERT guard is what makes that harmless, which is why that
    // ~120-line function is deliberately not re-issued.
    await withRollback(async (client) => {
      const tag = randomUUID().slice(0, 8);
      const company = await client.query<{ id: string }>(
        `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
        [`شركة ${tag}`, `Co ${tag}`],
      );
      const property = await client.query<{ id: string }>(
        `insert into public.properties (code, company_id, name_ar, name_en)
         values ($1, $2, $3, $4) returning id`,
        [`P-${tag}`, company.rows[0].id, `عقار ${tag}`, `Property ${tag}`],
      );
      await client.query(`select public.bulk_import_phase6('units', $1::jsonb)`, [
        JSON.stringify([
          { code: `U-${tag}`, property_id: property.rows[0].id, name: `Unit ${tag}`, status: "" },
        ]),
      ]);
      const { rows } = await client.query<{ status: string }>(
        `select status from public.units where code = $1`,
        [`U-${tag}`],
      );
      expect(rows[0].status).toBe("vacant");
    });
  });
});
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `bun run test:db`

Expected: FAIL. `an active contract makes its unit occupied` reports `expected 'available' to be 'occupied'` — nothing syncs the column yet. Several other cases fail the same way. If instead the run errors before any test executes, the Docker container is not up; `bun run test:db` provisions it and can take ~100s on a cold checkout.

- [ ] **Step 3: Write the migration mechanism**

Create `db/migrations/76_unit_status_lifecycle.sql`:

```sql
-- 76_unit_status_lifecycle.sql
--
-- Make units.status a derived projection of active contracts.
--
-- Background: nothing has ever connected the two. There is no trigger, no
-- function and no server-fn write anywhere in db/migrations or src/fns that
-- touches a unit's status when a contract is created, activated, moved, ended
-- or deleted. The column was a free-standing manual field, and most of its
-- production values came from the mock-data seed in migration 15, which assigns
-- statuses at random.
--
-- Measured in production on 2026-08-03 (70 units, 10 contracts, all active):
-- 41 units marked `occupied` with no contract behind them, and 3 units holding a
-- live contract while marked `available`. The dashboard occupancy tile
-- (src/routes/admin.index.tsx:103) counts status = 'occupied' and reported 48.
--
-- The rule, applied to one unit:
--   active contract exists                     -> 'occupied'
--   else current is under_maintenance/archived -> keep it
--   else                                       -> 'vacant'
--
-- The middle branch is the whole reason this is a three-way decision rather
-- than a boolean: a naive `else 'vacant'` would wipe an operator's maintenance
-- flag every time an unrelated contract on that unit was touched.
--
-- `available` and `reserved` are retired into `vacant`. They stay in the
-- public.unit_status enum because Postgres cannot drop an enum value; nothing
-- writes them any more.
--
-- Shaped after migration 54, which derives tenants.lifecycle from the same
-- table. Idempotent throughout.

-- ---------------------------------------------------------------------------
-- 1. The occupancy predicate, in exactly one place
-- ---------------------------------------------------------------------------

-- State-based, not date-based, and that is deliberate. Nothing in this codebase
-- transitions a contract to 'expired' — contractExpiryJob only sends reminders
-- — so every input to occupancy is a write to `contracts`, which makes an AFTER
-- trigger on that table sufficient and a scheduled recompute unnecessary.
--
-- `archived_at is null` is part of the predicate because useContracts filters
-- archived contracts out of every list in the application; an archived contract
-- must not go on holding a unit occupied.
create or replace function public.unit_has_active_contract(_unit uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.contracts c
     where c.unit_id = _unit
       and c.state = 'active'
       and c.archived_at is null
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. The rule, as a pure function of (unit, current status)
-- ---------------------------------------------------------------------------

create or replace function public.compute_unit_status(
  _unit uuid,
  _current public.unit_status
)
returns public.unit_status
language sql
stable
security definer
set search_path = public
as $$
  select case
           when public.unit_has_active_contract(_unit) then 'occupied'::public.unit_status
           when _current in ('under_maintenance', 'archived') then _current
           else 'vacant'::public.unit_status
         end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Recompute one unit
-- ---------------------------------------------------------------------------

-- `security definer` is load-bearing. This runs from a trigger on `contracts`
-- and writes `public.units`. Without definer rights an accountant holding
-- contracts.update but not units.update would be stopped by RLS — and RLS
-- updates zero rows *silently* rather than raising, so occupancy would stop
-- syncing for some users while every test still passed.
create or replace function public.sync_unit_status_for(_unit uuid)
returns public.unit_status
language plpgsql
security definer
set search_path = public
as $$
declare
  _current public.unit_status;
  _next public.unit_status;
begin
  if _unit is null then
    return null;
  end if;

  -- `for update` so two concurrent contract writes touching the same unit
  -- cannot interleave into a stale value.
  select status into _current
    from public.units
   where id = _unit
     for update;

  -- Defensive only. `contracts.unit_id` is ON DELETE RESTRICT (migration
  -- 04:138-142), so a unit cannot vanish while a contract still points at it —
  -- but sync_unit_status_for is also called from the backfill and could be
  -- called by hand, and a null return beats an unhandled no-data error.
  if not found then
    return null;
  end if;

  _next := public.compute_unit_status(_unit, _current);

  -- Guarded so a no-op contract save does not bump units.updated_at.
  update public.units
     set status = _next
   where id = _unit
     and status is distinct from _next;

  return _next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Keep it in sync with contracts
-- ---------------------------------------------------------------------------

create or replace function public.tg_contract_sync_unit_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _units uuid[] := '{}';
  _unit uuid;
begin
  -- A contract moving between units leaves *two* units stale. Recomputing only
  -- new.unit_id would leave the origin unit claiming a tenancy it no longer has
  -- — permanently, because nothing would ever revisit it.
  --
  -- Collected explicitly rather than with a CASE over tg_op: PL/pgSQL leaves
  -- OLD unassigned on INSERT and NEW unassigned on DELETE, and referencing
  -- either raises rather than yielding null.
  if tg_op <> 'INSERT' then
    _units := _units || old.unit_id;
  end if;

  if tg_op <> 'DELETE' then
    _units := _units || new.unit_id;
  end if;

  -- Lock every affected unit up front, in ascending uuid order, BEFORE
  -- recomputing any of them. Recomputing old-then-new without this deadlocks:
  -- `one_active_contract_per_unit` (migration 04:179-180) is a PARTIAL unique
  -- index covering only draft/active/frozen/suspended, so two *terminal*
  -- contracts may legally move A->B and B->A concurrently. One transaction
  -- would hold A and wait for B while the other holds B and waits for A.
  -- trg_contract_sync_tenant_lifecycle fires first by name order and imposes a
  -- tenant->unit ordering, but that does not help when the two contracts belong
  -- to different tenants.
  for _unit in
    select distinct x
      from unnest(_units) as t(x)
     where x is not null
     order by 1
  loop
    perform 1 from public.units where id = _unit for update;
  end loop;

  if tg_op <> 'INSERT' then
    perform public.sync_unit_status_for(old.unit_id);
  end if;

  if tg_op <> 'DELETE' then
    perform public.sync_unit_status_for(new.unit_id);
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_contract_sync_unit_status on public.contracts;
-- The `update of` column list is deliberate and differs from migration 54,
-- which uses none. Occupancy depends on exactly these three columns, and every
-- firing now takes a row lock on the unit — so letting a note or amount edit
-- fire it would widen the lock exposure the ordering above exists to bound.
-- If a column that affects occupancy is ever added, it MUST be added here too.
create trigger trg_contract_sync_unit_status
  after insert or delete or update of unit_id, state, archived_at
  on public.contracts
  for each row
  execute function public.tg_contract_sync_unit_status();

-- ---------------------------------------------------------------------------
-- 5. Stop callers writing a status the contracts do not support
-- ---------------------------------------------------------------------------

-- This is what makes the fix hold for *every* writer rather than for the paths
-- someone remembered. In particular it is why `bulk_import_phase6` is NOT
-- re-issued here: that function hardcodes
-- `coalesce(nullif(status, ''), 'available')` at migration 08:219 and again at
-- its superseding definition in 16:169, and branch 1 below normalises the value
-- on the way in. Do not "fix" the import RPC later expecting a behaviour change.
create or replace function public.tg_unit_enforce_derived_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 1. Retired values fold into their modern equivalent, silently.
  if new.status in ('available', 'reserved') then
    new.status := 'vacant';
  end if;

  if public.unit_has_active_contract(new.id) then
    -- 2. Contradicting a live contract is an operator mistake worth naming.
    --    Snapping the value back silently would leave them staring at a row
    --    that refuses to change with no explanation. Unreachable on INSERT: a
    --    brand-new unit id cannot yet be referenced by any contract, which is
    --    what keeps bulk import working.
    if new.status <> 'occupied' then
      raise exception
        'Unit % has an active contract, so its status is maintained automatically and stays occupied.',
        coalesce(new.code, new.id::text)
        using errcode = 'check_violation';
    end if;
  elsif new.status = 'occupied' then
    -- 3. Occupancy is derived, never asserted by a caller.
    new.status := 'vacant';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_unit_enforce_derived_status on public.units;
create trigger trg_unit_enforce_derived_status
  before insert or update on public.units
  for each row
  execute function public.tg_unit_enforce_derived_status();

-- Postgres grants EXECUTE on a new function to PUBLIC by default, and all three
-- of these are `security definer`. Left alone, `anon` could call the two read
-- helpers to probe which units carry contracts while bypassing contracts RLS,
-- and could call the mutator outright. Nothing in the application calls any of
-- them through the typed client; the triggers reach them through the definer
-- chain as the owner, who always holds EXECUTE. So revoking costs nothing.
revoke all on function public.unit_has_active_contract(uuid) from public;
revoke all on function public.compute_unit_status(uuid, public.unit_status) from public;
revoke all on function public.sync_unit_status_for(uuid) from public;
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `bun run test:db`

Expected: PASS — all cases in `src/db/unitStatus.sqltest.ts`, and no regression in the other `src/db/*.sqltest.ts` suites. Pay attention to `lifecycle.sqltest.ts` and `invoiceRegeneration.sqltest.ts`: both drive contract state changes through `seedContract`, and the new trigger now fires on those writes.

If `overriding an occupied unit raises instead of snapping back` fails with a timeout rather than an assertion, the `for update` in `sync_unit_status_for` has deadlocked — check that `tg_unit_enforce_derived_status` is `BEFORE` and does not write.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/76_unit_status_lifecycle.sql src/db/unitStatus.sqltest.ts
git commit -m "feat(db): derive unit status from active contracts

units.status has never been connected to contracts — no trigger, no
function, no write path touched it. A trigger on contracts now recomputes
both the old and the new unit_id, and a BEFORE trigger on units normalises
retired values and refuses an update that contradicts a live contract.

under_maintenance and archived stay operator-owned: the recompute keeps
them rather than folding everything without a contract into vacant.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Migration 76 — default, catalog, backfill and the invariant

Appends to the same migration file. Task 1 made new and changed rows correct; this makes the 70 rows already sitting in production correct, and pins the catalog state that currently exists only as an undocumented manual edit someone made in the admin UI.

**Files:**

- Modify: `db/migrations/76_unit_status_lifecycle.sql` (append)
- Modify: `src/db/unitStatus.sqltest.ts` (append two describe blocks)

**Interfaces:**

- Consumes: `public.unit_has_active_contract(uuid)` and `public.compute_unit_status(uuid, public.unit_status)` from Task 1.
- Produces: nothing new that later tasks call. Task 6 re-runs the invariant query from step 5 against production.

- [ ] **Step 1: Write the failing tests**

Append to `src/db/unitStatus.sqltest.ts`:

```typescript
describe("the catalog matches the statuses that survive", () => {
  test("available and reserved are inactive, the other four are active", async () => {
    // In production these two were switched off by hand through the admin UI,
    // which is why the units form could not offer `available` while 14 units
    // still displayed it. Pinning it here makes the intent version-controlled.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ value: string; is_active: boolean }>(
        `select i.value, i.is_active
           from public.option_list_items i
           join public.option_lists l on l.id = i.list_id
          where l.code = 'unit_statuses'
          order by i.sort_order`,
      );
      const byValue = new Map(rows.map((row) => [row.value, row.is_active]));
      expect(byValue.get("available")).toBe(false);
      expect(byValue.get("reserved")).toBe(false);
      expect(byValue.get("occupied")).toBe(true);
      expect(byValue.get("vacant")).toBe(true);
      expect(byValue.get("under_maintenance")).toBe(true);
      expect(byValue.get("archived")).toBe(true);
    });
  });
});

describe("the invariant holds across the whole table", () => {
  // These three assert on the WHOLE table, which the harness note at
  // src/db/testDb.ts:31-38 warns against — the database is not empty at rest
  // and assertions are normally scoped to the fixtures a test created. The
  // exception is deliberate: their entire purpose is to check the backfill
  // against rows migrations 11, 15 and 19 seeded long before migration 76
  // existed, which a fixture-scoped test cannot see. The suite is
  // single-threaded (vitest.sql.config.ts:10-22) and every other test rolls
  // back, so no concurrent fixture can perturb them.
  test("no unit disagrees with its contracts", async () => {
    // The cheapest possible proof that the backfill and both triggers agree.
    // Data-independent, so it holds on production and on the mock-seeded test
    // database alike.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ bad: string }>(
        `select count(*)::text as bad
           from public.units u
          where (u.status = 'occupied') is distinct from public.unit_has_active_contract(u.id)`,
      );
      expect(rows[0].bad).toBe("0");
    });
  });

  test("no unit is left on a retired status", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ bad: string }>(
        `select count(*)::text as bad
           from public.units
          where status in ('available', 'reserved')`,
      );
      expect(rows[0].bad).toBe("0");
    });
  });

  test("the column default is vacant", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ column_default: string }>(
        `select column_default
           from information_schema.columns
          where table_schema = 'public' and table_name = 'units' and column_name = 'status'`,
      );
      expect(rows[0].column_default).toContain("vacant");
    });
  });

  test("custom catalog rows are left alone", async () => {
    // The catalog update targets the six enum values by name. A blanket
    // `is_active = (value not in ('available','reserved'))` would also switch ON
    // every custom row an admin had deliberately switched off.
    await withRollback(async (client) => {
      const { rows: list } = await client.query<{ id: string }>(
        `select id from public.option_lists where code = 'unit_statuses'`,
      );
      await client.query(
        `insert into public.option_list_items (list_id, value, label_ar, label_en, is_active)
         values ($1, 'custom_probe', 'اختبار', 'Probe', false)`,
        [list[0].id],
      );
      // Re-run only the catalog statement the migration uses.
      await client.query(
        `update public.option_list_items i
            set is_active = (i.value in ('occupied','vacant','under_maintenance','archived'))
           from public.option_lists l
          where l.id = i.list_id
            and l.code = 'unit_statuses'
            and i.value in ('available','reserved','occupied','vacant','under_maintenance','archived')
            and i.is_active is distinct from
                (i.value in ('occupied','vacant','under_maintenance','archived'))`,
      );
      const { rows } = await client.query<{ is_active: boolean }>(
        `select is_active from public.option_list_items where value = 'custom_probe'`,
      );
      expect(rows[0].is_active).toBe(false);
    });
  });
});

describe("the migration is safe to re-run", () => {
  test("applying it a second time changes nothing and raises nothing", async () => {
    // Asserted, not assumed. The whole file is create-or-replace, drop-trigger-
    // if-exists and guarded updates, but "should be idempotent" and "is" differ.
    // Reads the file from disk so it cannot drift from what ships.
    await withRollback(async (client) => {
      const sql = await readFile("db/migrations/76_unit_status_lifecycle.sql", "utf8");
      // The LOCK TABLE statements at the top are fine inside this transaction.
      await client.query(sql);
      const { rows } = await client.query<{ bad: string }>(
        `select count(*)::text as bad
           from public.units u
          where (u.status = 'occupied') is distinct from public.unit_has_active_contract(u.id)`,
      );
      expect(rows[0].bad).toBe("0");
    });
  });
});
```

Add `readFile` to the imports at the top of the file:

```typescript
import { readFile } from "node:fs/promises";
```

- [ ] **Step 2: Run the suite to verify the new tests fail**

Run: `bun run test:db`

Expected: FAIL on `the column default is vacant` (`expected "'available'::unit_status" to contain "vacant"`) and on `available and reserved are inactive` (`expected true to be false` — migration 13 seeds all six active).

`no unit disagrees with its contracts` and `no unit is left on a retired status` **also fail**, and must. Every seeding migration runs long before this one, so none of their inserts could fire a trigger that did not yet exist:

| migration                       | seeds                                                                                                                  | leaves behind                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `11_mock_data.sql:61-82`        | 4 units (no status → default `available`), then 2 **`active`** contracts on units 1 and 3                              | 2 units active-but-`available`, 2 `available` with no contract |
| `15_mock_kuwait_data.sql:42-49` | 10 units per property on a fixed 7 `occupied` / 2 `available` / 1 `under_maintenance` pattern, **no contracts at all** | every `occupied` row contractless                              |
| `19_landing_page.sql:314-332`   | 5 units hardcoded `'occupied'`, no contracts                                                                           | 5 more contractless `occupied` rows                            |

An earlier draft of this plan claimed these two tests would already pass because "migration 15 inserts units before contracts". That is wrong twice over: migration 15 seeds no contracts, and the seeding migration that does (11) still runs before this one. **The backfill in step 3 is what makes a from-scratch build correct, exactly as it is for production** — it is not a production-only concern.

- [ ] **Step 3: Append the remainder of the migration**

Append to `db/migrations/76_unit_status_lifecycle.sql`:

```sql
-- ---------------------------------------------------------------------------
-- 6. A unit with no contract starts vacant, not available
-- ---------------------------------------------------------------------------

alter table public.units alter column status set default 'vacant';

-- ---------------------------------------------------------------------------
-- 7. Bring the rows that predate the triggers into line
-- ---------------------------------------------------------------------------

-- Needed on EVERY database, not only production. Every seeding migration runs
-- before this one, so none of their inserts could fire the triggers above:
-- migration 11 seeds 4 units and 2 active contracts, migration 15 stamps a fixed
-- 7-occupied/2-available/1-maintenance pattern with no contracts at all, and
-- migration 19 hardcodes 5 more contractless `occupied` units. A from-scratch
-- build is exactly as wrong as production until this statement runs.
--
-- Expected production result: occupied 10, vacant 54, under_maintenance 6.
with target as (
  select u.id,
         public.compute_unit_status(u.id, u.status) as next_status
    from public.units u
)
update public.units u
   set status = t.next_status
  from target t
 where t.id = u.id
   and u.status is distinct from t.next_status;

-- ---------------------------------------------------------------------------
-- 8. The catalog stops offering statuses nothing can hold
-- ---------------------------------------------------------------------------

-- In production `available` and `reserved` were already switched off by hand
-- through Settings > Lists. useOptionListItemsByCode filters on is_active, so
-- the units form could not offer `available` while 14 units still displayed it
-- — a status you could see but not select. Stating it here makes the intended
-- state auditable instead of resting on an unrecorded manual edit.
--
-- Scoped to the six known enum values. `is_active = (value not in (...))` over
-- the whole list would also switch ON every custom row an admin had added and
-- deliberately switched off — a silent, unrelated behaviour change in someone
-- else's data.
update public.option_list_items i
   set is_active = (i.value in ('occupied', 'vacant', 'under_maintenance', 'archived'))
  from public.option_lists l
 where l.id = i.list_id
   and l.code = 'unit_statuses'
   and i.value in ('available', 'reserved', 'occupied', 'vacant', 'under_maintenance', 'archived')
   and i.is_active
       is distinct from (i.value in ('occupied', 'vacant', 'under_maintenance', 'archived'));

-- ---------------------------------------------------------------------------
-- 9. Prove it
-- ---------------------------------------------------------------------------

-- Data-independent, so it holds on production and on the mock-seeded test
-- database alike. A count assertion would not: the two carry different rows.
do $$
declare
  _bad integer;
begin
  select count(*) into _bad
    from public.units u
   where (u.status = 'occupied') is distinct from public.unit_has_active_contract(u.id);
  if _bad > 0 then
    raise exception 'unit status invariant violated for % unit(s)', _bad;
  end if;

  select count(*) into _bad
    from public.units
   where status in ('available', 'reserved');
  if _bad > 0 then
    raise exception '% unit(s) left on a retired status', _bad;
  end if;
end;
$$;
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `bun run test:db`

Expected: PASS, whole suite. If the migration itself aborts with `unit status invariant violated for N unit(s)`, the backfill and `compute_unit_status` disagree — most likely the `under_maintenance`/`archived` branch is being reached for a unit that does have an active contract, which would mean the branch order in `compute_unit_status` was inverted.

- [ ] **Step 5: Record the production dry-run query**

This query is what Task 6 runs before and after applying the migration. Confirm it returns rows now, against the test database, so Task 6 is not the first time it is executed:

```bash
docker exec danat-test-db psql -U postgres -d postgres -tAc \
  "select u.status, public.unit_has_active_contract(u.id) as has_active, count(*) \
     from public.units u group by 1,2 order by 1,2;"
```

If the container name differs, read it from `scripts/test-db.sh`. Expected: every row has `status = 'occupied'` exactly where `has_active` is `t`.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/76_unit_status_lifecycle.sql src/db/unitStatus.sqltest.ts
git commit -m "feat(db): backfill unit status and pin the catalog

The triggers only fix rows written after them; production carries 70 rows
that predate them. Backfills through the same compute function, moves the
column default off 'available', records the available/reserved retirement
that until now existed only as a manual edit in Settings > Lists, and ends
with a data-independent invariant assertion.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Split the status list into filterable and editable

`occupied` must stay filterable — you need to find occupied units — but must not be offerable in the form. Today one list serves both.

**Files:**

- Modify: `src/routes/admin.units.index.tsx:78`, `:91`, `:106-113`, `:158`, `:314`, `:481-486`
- Modify: `src/routes/admin.properties.$id.tsx:53`, `:64`, `:96-107`, `:403-407`
- Modify: `src/lib/bulkImportSchemas.ts:160-165`
- Modify: `src/i18n/dictionary.ts` (both locale blocks)
- Modify: `src/components/admin/Phase2FormFields.tsx:108-145`

**Interfaces:**

- Consumes: `useListDrivenOptions(code, allowedValues, translatePrefix)` from `@/hooks/useOptionLists`, which returns `Array<{value: string; label: string}>` and already filters to `is_active` items intersected with `allowedValues`.
- Produces: `FormSelectField` gains two optional props — `disabled?: boolean` and `description?: string` — used by both routes. Its existing five props are unchanged, so no other call site needs touching.

- [ ] **Step 1: Add `disabled` and `description` to FormSelectField**

In `src/components/admin/Phase2FormFields.tsx`, add `FormDescription` to the existing import from `@/components/ui/form`:

```typescript
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
```

Then replace the whole `FormSelectField` function (currently lines 108-145) with:

```typescript
export function FormSelectField<TValues extends FieldValues>({
  control,
  name,
  label,
  options,
  placeholder,
  disabled = false,
  description,
}: {
  control: Control<TValues>;
  name: FieldPath<TValues>;
  label: string;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  description?: string;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <Select
            value={String(field.value ?? "")}
            onValueChange={field.onChange}
            disabled={disabled}
          >
            <FormControl>
              <SelectTrigger>
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
```

- [ ] **Step 2: Add the hint copy to both locales**

In `src/i18n/dictionary.ts`, add to the **Arabic** block immediately after `"unitStatus.archived": "مؤرشف",` (line 681):

```typescript
    "units.statusDerived": "الحالة تتبع العقد النشط تلقائيًا ولا يمكن تعديلها يدويًا.",
    "units.statusManualOnly": "يمكن تعيين «تحت الصيانة» أو «مؤرشفة» للوحدات الشاغرة فقط.",
```

And to the **English** block immediately after `"unitStatus.archived": "Archived",` (line 2041):

```typescript
    "units.statusDerived": "Status follows the active contract automatically and cannot be changed by hand.",
    "units.statusManualOnly": "Under maintenance and archived can only be set on a vacant unit.",
```

Both blocks. `dictionary.ts` is `Record<string, string>` per locale with no parity check — a key added to only one locale renders as the raw key string and `bun run typecheck` will not catch it.

- [ ] **Step 3: Split the lists on the units page**

In `src/routes/admin.units.index.tsx`:

Narrow the form schema at line 78 by dropping **only the two retired values** — `occupied` stays:

```typescript
  status: z.enum(["occupied", "vacant", "under_maintenance", "archived"]),
```

`occupied` must remain in the schema even though nobody may select it. `FormSelectField` renders whatever the form currently holds (`src/components/admin/Phase2FormFields.tsx:128-141`), so a schema that excluded `occupied` would force the edit dialog to seed the field with some other value — and the disabled control would then read **"Vacant" on a unit that is occupied**. Disabling a control is not a licence to display a falsehood in it. The lock is enforced by narrowing the _options_ offered (step 3b) and by omitting `status` from the payload (step 4), not by lying about the current value.

Change the form default at line 91:

```typescript
  status: "vacant",
```

Replace the `unitStatusValues` block (lines 106-113) with two lists:

```typescript
/**
 * `occupied` is filterable but not settable: it is derived from the unit's
 * active contract by migration 76's triggers, and the database rejects any
 * attempt to write a different status while that contract is live. The two
 * retired values (`available`, `reserved`) survive only in the enum — nothing
 * writes them, and the catalog keeps them inactive.
 */
const unitStatusFilterValues: UnitStatus[] = [
  "occupied",
  "vacant",
  "under_maintenance",
  "archived",
];
const unitStatusEditableValues: UnitStatus[] = ["vacant", "under_maintenance", "archived"];
```

Replace line 158 with two derived option lists:

```typescript
const unitStatusFilterOptions = useListDrivenOptions(
  "unit_statuses",
  unitStatusFilterValues,
  "unitStatus",
);
const unitStatusEditableOptions = useListDrivenOptions(
  "unit_statuses",
  unitStatusEditableValues,
  "unitStatus",
);
```

Point the filter select (line 314) at the filter list:

```typescript
options = { unitStatusFilterOptions };
```

- [ ] **Step 3b: Lock the field by narrowing its options, not its value**

Still in `src/routes/admin.units.index.tsx`, add this next to the option lists (after line 993):

```typescript
// An occupied unit shows its real status in a locked control: the only option
// offered is `occupied` itself, so the select displays the truth and cannot
// be moved off it. Every other unit gets the three settable statuses.
const unitIsOccupied = editing?.status === "occupied";
const unitStatusFieldOptions = unitIsOccupied
  ? unitStatusFilterOptions.filter((option) => option.value === "occupied")
  : unitStatusEditableOptions;
```

Then replace the form's status field (lines 481-486) with:

```typescript
              <FormSelectField
                control={form.control}
                name="status"
                label={t("common.status")}
                options={unitStatusFieldOptions}
                disabled={unitIsOccupied}
                description={
                  unitIsOccupied ? t("units.statusDerived") : t("units.statusManualOnly")
                }
              />
```

`editing` is the unit currently open in the dialog, already in scope at line 170 where the form is reset from it.

- [ ] **Step 4: Keep the reset honest and omit status from an occupied payload**

The reset at line 170 copies `editing.status` straight into the form, which is now correct for `occupied` and needs changing only for the two retired values — no production row should still hold one after Task 2's backfill, but a stale client or an old import could:

```typescript
              status:
                editing.status === "available" || editing.status === "reserved"
                  ? "vacant"
                  : editing.status,
```

Displaying the right value is not enough on its own: `save()` sends the whole form, so saving an unrelated field on an occupied unit would submit `status: "occupied"` — which the trigger accepts, but only by luck of it matching. Worse, if the contract were terminated in another tab between load and save, that same submission would post `occupied` against a unit with no contract and be silently coerced to `vacant`. Omit the field instead of reasoning about which stale value happens to be survivable.

Add `TablesUpdate` to the existing type import at lines 55-59:

```typescript
import type {
  ElectricityMeterOwnership,
  TablesUpdate,
  UnitStatus,
  UnitType,
} from "@/integrations/supabase/database.types";
```

Then replace the body of `save()` (lines 180-197) with:

```typescript
async function save(values: Values) {
  const payload = {
    ...values,
    // Nullable, mirroring properties.name_en: an empty box means "no English
    // name", which the CSV and the UI fall back from, not an empty string.
    name_en: values.name_en.trim() || null,
    description_ar: values.description_ar.trim() || null,
    description_en: values.description_en.trim() || null,
  };
  // An occupied unit's status belongs to its contract, so it is never sent.
  // The disabled field still submits a value, and that value is only correct
  // for as long as the contract it was loaded against is still active.
  const updates: TablesUpdate<"units"> = { ...payload };
  if (unitIsOccupied) delete updates.status;
  try {
    if (editing) await update.mutateAsync({ id: editing.id, updates });
    else await create.mutateAsync(payload);
    toast.success(t("phase2.saved"));
    setDialog(false);
  } catch (error) {
    showError(t("phase2.saveError"), error);
  }
}
```

Two details matter here. `delete` is only legal because `database.types.ts` defines `Update: Partial<Row>` (`TableDefinition`, line 107-112) — that file is hand-maintained and does not follow the Supabase generator's output shape, so this was checked rather than assumed. And the copy is deliberate: annotating `payload` itself as `TablesUpdate<"units">` would make every field optional and break `create.mutateAsync(payload)`, which needs `property_id` and `name`.

- [ ] **Step 5: Split the lists on the property detail page**

In `src/routes/admin.properties.$id.tsx`:

Narrow the unit schema at line 53 by dropping only the retired pair, for the same reason as the units page — the locked control must be able to display `occupied`:

```typescript
  status: z.enum(["occupied", "vacant", "under_maintenance", "archived"]),
```

Change the default at line 64:

```typescript
  status: "vacant",
```

Replace the `unitStatusOptions` block (lines 96-107) with:

```typescript
// `occupied` is derived from the unit's active contract (migration 76). It is
// offered as the sole option on an occupied unit so the locked control shows
// the truth, and withheld entirely otherwise.
const unitIsOccupied = editingUnit?.status === "occupied";
const unitStatusOptions = useListDrivenOptions(
  "unit_statuses",
  (unitIsOccupied ? ["occupied"] : ["vacant", "under_maintenance", "archived"]) as UnitStatus[],
  "unitStatus",
);
```

Apply the same reset guard at line 117 — only the retired values need remapping:

```typescript
              status:
                editingUnit.status === "available" || editingUnit.status === "reserved"
                  ? "vacant"
                  : editingUnit.status,
```

Add `TablesUpdate` to the type import at line 40:

```typescript
import type { TablesUpdate, UnitStatus, UnitType } from "@/integrations/supabase/database.types";
```

Apply the same payload omission in `saveUnit()` — replace lines 137-153 (from the `// The unit is created inside this property page` comment down to the closing brace of the `try`/`catch`) with:

```typescript
// The unit is created inside this property page, so the property is
// implied — no property (or building) dropdown is offered.
const payload = {
  ...values,
  property_id: id,
  description_ar: values.description_ar.trim() || null,
  description_en: values.description_en.trim() || null,
};
// See the matching guard in admin.units.index.tsx: an occupied unit's
// status belongs to its contract and is never sent from here.
const updates: TablesUpdate<"units"> = { ...payload };
if (unitIsOccupied) delete updates.status;
try {
  if (editingUnit) await updateUnit.mutateAsync({ id: editingUnit.id, updates });
  else await createUnit.mutateAsync(payload);
  toast.success(t("phase2.saved"));
  setUnitDialog(false);
  setEditingUnit(null);
} catch (error) {
  toast.error(t("phase2.saveError"), {
    description: error instanceof Error ? error.message : undefined,
  });
}
```

And the disabled field at lines 402-407:

```typescript
              <FormSelectField
                control={unitForm.control}
                name="status"
                label={t("common.status")}
                options={unitStatusOptions}
                disabled={unitIsOccupied}
                description={
                  unitIsOccupied ? t("units.statusDerived") : t("units.statusManualOnly")
                }
              />
```

Note the form variable on this page is `unitForm`, not `form` — the page also hosts a property form.

- [ ] **Step 6: Move the bulk-import default off the retired value**

In `src/lib/bulkImportSchemas.ts`, lines 160-165. The enum keeps all six values so existing import files keep validating — the database trigger normalizes the retired ones on the way in — and only the default changes:

```typescript
    status: z.preprocess(
      emptyToUndefined,
      z
        // All six stay accepted so older import files still validate; migration
        // 76's units trigger folds `available`/`reserved` into `vacant` on
        // insert, and — since a brand-new unit cannot yet have a contract —
        // silently folds an imported `occupied` into `vacant` as well.
        .enum(["available", "reserved", "occupied", "vacant", "under_maintenance", "archived"])
        .default("vacant"),
    ),
```

- [ ] **Step 7: Make the occupant column agree with the status column**

`src/hooks/useUnits.ts:96-103` derives each unit's occupant from contracts with `state = 'active'` and **no archived filter**. The database predicate excludes archived contracts, so without this change archiving an active contract would leave the unit reading `vacant` in the status column while the same table still named a tenant in the occupant column — and the property page's summary counts occupancy from `u.occupant`, not `u.status` (`src/routes/admin.properties.$id.tsx:127-134`), so it would disagree too.

Add the filter so the hook matches the trigger exactly:

```typescript
const { data: activeContracts, error: contractError } = await supabase
  .from("contracts")
  .select("unit_id,tenant_id")
  .eq("state", "active")
  // Matches migration 76's occupancy predicate. Without it the occupant
  // column and the status column disagree the moment a contract is
  // archived.
  .is("archived_at", null)
  .in(
    "unit_id",
    units.map((unit) => unit.id),
  );
```

- [ ] **Step 8: Invalidate the units cache on every contract path that moves occupancy**

`useUpdateContract` already invalidates `["units"]` (`src/hooks/useContracts.ts:246-250`). Two paths that also change occupancy do not, so the units list would keep showing a stale status until a manual refresh.

In `src/hooks/useContracts.ts`, `useCreateContract`'s `onSuccess` (lines 202-205) — a contract may be created directly in the `active` state, which flips the unit immediately:

```typescript
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      queryClient.invalidateQueries({ queryKey: ["units"] });
    },
```

In `src/hooks/useRefunds.ts` (lines 183-186) — that path stamps `archived_at` on a contract and sets `state = 'frozen'` (`:47-75`), both of which now free the unit:

```typescript
queryClient.invalidateQueries({ queryKey: ["units"] });
```

Read both `onSuccess` bodies before editing and add the line alongside the existing invalidations rather than replacing them.

- [ ] **Step 9: Run the gates**

Run: `bun run lint && bun run typecheck && bun run test`

Expected: all pass. A `typecheck` failure naming `Type '"available"' is not assignable` means a `Values` object still carries a retired value — the narrowed Zod enum is the source of `Values`, so follow the error to the remaining assignment.

- [ ] **Step 10: Commit**

```bash
git add src/routes/admin.units.index.tsx src/routes/admin.properties.\$id.tsx src/lib/bulkImportSchemas.ts src/i18n/dictionary.ts src/components/admin/Phase2FormFields.tsx src/hooks/useUnits.ts src/hooks/useContracts.ts src/hooks/useRefunds.ts
git commit -m "feat(ui): stop offering a unit status the contracts decide

occupied is now derived, so the form must not offer it while the filter
still must. The form keeps occupied in its schema so a locked control can
display the truth rather than a placeholder, and omits status from the
payload entirely rather than sending a value that was only correct at load.

useUnits derived occupants without filtering archived_at, so an archived
contract would have shown a named occupant beside a vacant status. Two
contract paths that move occupancy did not invalidate the units cache.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Guard passes and full gates

**Files:** none created or modified unless a guard finds something.

- [ ] **Step 1: Run clean-code-guard on the production code**

Invoke the `clean-code-guard` skill against the diff for `src/routes/admin.units.index.tsx`, `src/routes/admin.properties.$id.tsx`, `src/lib/bulkImportSchemas.ts`, `src/components/admin/Phase2FormFields.tsx`. This is required by the global CLAUDE.md guard workflow after any implementation pass.

- [ ] **Step 2: Run test-guard on the new SQL test**

Invoke the `test-guard` skill against `src/db/unitStatus.sqltest.ts`.

- [ ] **Step 3: Fix anything either guard flags, then re-run the full gates**

Run: `bun run lint && bun run typecheck && bun run test && bun run test:db`

Expected: all four pass. Do not proceed to the PR on a failure — report it instead.

- [ ] **Step 4: Commit any guard fixes**

```bash
git add <only the files the guards changed>
git commit -m "refactor: address guard findings on the unit status change

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

Skip this step entirely if the guards found nothing.

---

### Task 5: Open the pull request

**Files:** none.

- [ ] **Step 1: Confirm nothing unrelated is staged**

Run: `git log --stat 9bcbc2d..HEAD`

Expected: exactly **twelve** files — the spec, the plan, `db/migrations/76_unit_status_lifecycle.sql`, `src/db/unitStatus.sqltest.ts`, and the eight source files (`admin.units.index.tsx`, `admin.properties.$id.tsx`, `bulkImportSchemas.ts`, `dictionary.ts`, `Phase2FormFields.tsx`, `useUnits.ts`, `useContracts.ts`, `useRefunds.ts`). **No file under `src/fns/` may appear** — that is the concurrent workflow work. If one does, remove it from the commit before pushing.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin fix/unit-status-lifecycle
gh pr create --base main --title "fix: derive unit status from active contracts" --body "$(cat <<'EOF'
## Problem

`units.status` has never been connected to `contracts` — no trigger, no function, no write path touched it. Measured on production 2026-08-03: **41 units marked `occupied` with no contract behind them**, and **3 units holding a live contract while marked `available`**. Most of it came from the mock-data seed in migration 15, which assigns statuses at random. The dashboard occupancy tile counts `status = 'occupied'` and reported 48 against a real figure of 10.

Separately, `available` and `reserved` had been switched off by hand in Settings > Lists. `useOptionListItemsByCode` filters on `is_active`, so the units form could not offer `available` while 14 units still displayed it — a status you could see but not select.

## What changed

- **Occupancy is now derived.** A unit is `occupied` iff a contract exists with `state = 'active' and archived_at is null`. Maintained by a trigger on `contracts` that recomputes **both** `old.unit_id` and `new.unit_id`, so moving a contract between units frees the origin.
- **`under_maintenance` and `archived` stay operator-owned** and survive unrelated contract activity. A completed tenancy does return the unit to `vacant` — the maintenance flag is not remembered across a let.
- **A `BEFORE` trigger on `units`** folds the retired `available`/`reserved` into `vacant`, refuses `occupied` from a caller, and raises a named error if an update would contradict a live contract. This is why `bulk_import_phase6` is deliberately *not* re-issued: it hardcodes `'available'` in two migrations, and the trigger normalises it on the way in.
- **The form no longer offers `occupied`**; the filter still does. The field renders disabled with an explanation when the unit has a live contract.

Expected production result: **occupied 10, vacant 54, under_maintenance 6.** The migration ends with a data-independent invariant assertion rather than a count check, so it holds on the mock-seeded test database too.

## Testing

`src/db/unitStatus.sqltest.ts` against real Postgres, covering activation, termination, freezing, archival and un-archival, contract moves between units, active-contract deletion, draft-only units, maintenance and archived stickiness on the same unit, the manual-override raise, the bulk-import path, a non-owner caller (which is the only thing that would catch `security definer` being dropped), whole-table invariants, and re-running the migration. `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:db` all pass.

## Known limitations, deliberately left

- **A draft-only unit reads `vacant` but rejects a new contract.** `assertUnitAvailable` (`src/hooks/useContracts.ts:166`) blocks a second contract on any unit carrying a draft/active/frozen/suspended one. Pre-existing; narrowing it would change contract-booking behaviour.
- **Contracts never auto-expire.** Nothing transitions a contract past its `end_date`, so a lease that ended in 2025 still reads `active` and still holds its unit occupied. Separate gap; this design picks up the correction for free once something flips the state.

Spec: `docs/superpowers/specs/2026-08-03-unit-status-lifecycle-design.md`
Plan: `docs/superpowers/plans/2026-08-03-unit-status-lifecycle.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report the PR URL and stop**

Do not merge. Do not touch production. Hand the URL back and wait.

---

### Task 6: Apply migration 76 to production — after merge only

Runs only once the PR is merged and the operator says so.

**Files:** none in the repo.

- [ ] **Step 1: Capture the before-state**

```
mcp__ssh-danatfuture-mcp__exec:
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres -tAc "select u.status, (exists(select 1 from contracts c where c.unit_id=u.id and c.state='active' and c.archived_at is null)) as has_active, count(*) from units u group by 1,2 order by 1,2;"
```

Expected, unchanged from 2026-08-03: `available|f|11`, `available|t|3`, `occupied|f|41`, `occupied|t|7`, `vacant|f|2`, `under_maintenance|f|6`. If the numbers have moved, record the new ones — the post-state check below is relative to whatever is there now, not to these figures.

Then capture the **row-level** snapshot, which is the one that actually enables a reconciliation. Grouped counts prove the totals moved; only this lets anyone reconstruct what a specific unit was if a figure is disputed a week later:

```
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres -tAc "select u.id||'|'||u.code||'|'||u.status||'|'||coalesce((select string_agg(c.id||':'||c.state||':'||coalesce(c.archived_at::text,'-'), ',') from contracts c where c.unit_id=u.id),'-') from units u order by u.code;"
```

Save that output before proceeding. Also record the current state of what the migration is about to change, so a rollback has a target:

```
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres -tAc "select 'default='||coalesce(column_default,'none') from information_schema.columns where table_schema='public' and table_name='units' and column_name='status'; select 'trigger='||tgname from pg_trigger where tgrelid='public.units'::regclass and not tgisinternal; select 'catalog='||i.value||':'||i.is_active from option_list_items i join option_lists l on l.id=i.list_id where l.code='unit_statuses' order by i.sort_order;"
```

- [ ] **Step 2: Transfer the migration**

SSH `exec` caps a command at 1000 characters and migration 76 is far longer, so send it as chunked base64 and verify the round trip before running anything:

```bash
# locally
base64 -w0 db/migrations/76_unit_status_lifecycle.sql > /tmp/76.b64
md5sum db/migrations/76_unit_status_lifecycle.sql
split -b 800 /tmp/76.b64 /tmp/76.part.
```

Then per chunk, in order: `printf '%s' '<chunk>' >> /tmp/76.b64` on the host. Finally `base64 -d /tmp/76.b64 > /tmp/76.sql && md5sum /tmp/76.sql` and confirm the md5 matches the local one **before** proceeding. A truncated migration that still parses is the failure mode this check exists to catch.

- [ ] **Step 3: Apply it, and only it**

```
docker cp /tmp/76.sql danatfuture-supabase-ozoxsa-db-1:/tmp/76.sql
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres \
  -v ON_ERROR_STOP=1 --single-transaction -f /tmp/76.sql
```

**`--single-transaction` is not optional.** `psql -f` otherwise autocommits each statement, so a failure in the closing invariant `do` block would roll back only that block, leaving the functions, triggers, column default, backfill and catalog change committed. That is the worst possible half-state and the one an operator is least equipped to unpick under time pressure.

The migration takes its own write locks in its first statements — before creating anything — because there is a genuine live-traffic window otherwise. Between the units guard being installed and the backfill running, an ordinary edit to one of the 3 production units that is `available` _with_ a live contract would hit the guard's raise branch, surfacing to a user as an error on an unrelated save. Add this at the very top of the migration file (Task 1 step 3), immediately after the header comment:

```sql
-- Locked in contract -> unit order, matching the trigger firing order so this
-- cannot invert against normal traffic. Held only for the few seconds the
-- migration runs, and only meaningful under --single-transaction.
lock table public.contracts in share row exclusive mode;
lock table public.units    in share row exclusive mode;
```

`share row exclusive` blocks concurrent writes and other DDL but still permits reads, so the app keeps serving pages while this runs.

Apply **only** migration 76. Replaying the full set fails — `identify_contract_expiry_reminders` changes its OUT-parameter row type across migrations 07/31/33 and `create or replace function` cannot do that.

Expected: no output beyond the `LOCK TABLE` / `CREATE FUNCTION` / `CREATE TRIGGER` / `UPDATE n` lines, and no exception from the closing `do` block. If it raises `unit status invariant violated`, the **whole** migration has rolled back and production is untouched — report it and stop.

- [ ] **Step 4: Verify the after-state**

Re-run the step 1 query. Expected: `occupied|t|10`, `vacant|f|54`, `under_maintenance|f|6` — three rows, and `status = 'occupied'` appearing only where `has_active` is `t`.

Then run the invariant as an explicit zero-count rather than inferring it from the grouped output — reading three rows and concluding "looks right" is exactly how a stray row gets missed:

```
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres -tAc "select count(*) from public.units u where (u.status='occupied') is distinct from public.unit_has_active_contract(u.id);"
```

Expected: `0`. Anything else means the migration committed a state its own assertion should have caught, and is a stop-and-report.

Then confirm the catalog:

```
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres -tAc "select i.value||' active='||i.is_active from option_list_items i join option_lists l on l.id=i.list_id where l.code='unit_statuses' order by i.sort_order;"
```

Expected: `available active=false`, `reserved active=false`, the other four `true`.

- [ ] **Step 5: Confirm the live app agrees**

Open https://danat-future.com admin units list. The status filter offers Occupied / Vacant / Under maintenance / Archived. Editing a vacant unit offers three statuses with the "only on a vacant unit" hint; editing an occupied unit shows the field disabled with the "follows the active contract" hint. The dashboard occupancy tile reads 10, not 48.

- [ ] **Step 6: Report**

State the before and after distributions and confirm the invariant query returned zero.

Run `graphify update .` as `AGENTS.md:23-26` requires. An earlier draft of this plan told the implementer to skip it because `graphify-out/` was already dirty; that is explicitly not a valid reason — "dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it." Commit the graph update separately from the code so the diff stays readable.

---

## External review

This plan was reviewed by the OpenAI Codex CLI (0.144.1) in a read-only sandbox before any code was written. It returned **SHIP WITH THE BLOCKING FIXES**. Every finding below was independently verified against the source before being accepted; all are now folded into the plan above.

**Four blocking findings, all accepted:**

1. **Deadlock on concurrent contract moves.** `one_active_contract_per_unit` is a _partial_ unique index covering only draft/active/frozen/suspended (`db/migrations/04_...:179-180`), so two terminal contracts may legally move A→B and B→A at once. Locking old-then-new would have one transaction holding A waiting for B and vice versa. Now both units are locked in ascending UUID order first. I had independently found a related but weaker hazard — the FK's `FOR KEY SHARE` upgrading to `FOR UPDATE` — which turns out to be largely blocked by that same unique index; Codex's version is the one that actually bites.
2. **Non-atomic production apply.** `psql -f` autocommits per statement, so a failing invariant would roll back only the closing `do` block and leave everything else committed. Now `--single-transaction`, plus table locks for the live-traffic window between installing the units guard and running the backfill.
3. **`useUnits` would contradict the new status.** It derives occupants from `state = 'active'` with no `archived_at` filter (`src/hooks/useUnits.ts:96-103`), so archiving a contract would show a named occupant beside a `vacant` status — and the property summary counts from `u.occupant`, not `u.status`. I missed this entirely.
4. **The disabled field would have displayed a falsehood.** Narrowing the form enum to three forced the dialog to seed an occupied unit's field with `vacant`, and `FormSelectField` renders the form value — so the locked control would read "Vacant" on an occupied unit. The enum now keeps `occupied` and the lock comes from the options list.

**Non-blocking findings accepted:** vacuous tests replaced (draft-deletion, and the two "different unit" stickiness tests that never fired the trigger for the unit under assertion); a non-owner test added, without which `security definer` could be removed silently; `PUBLIC` execute revoked from all three functions rather than one; the catalog update scoped to the six enum values so custom rows are not switched on; an idempotence test added; the Task 6 preflight extended to a row-level snapshot; and the graphify instruction corrected — `AGENTS.md:23-26` says dirty graph files are explicitly _not_ a reason to skip `graphify update`.

**Where I did not simply defer.** Codex framed the missing `UPDATE OF` column list as "restore the approved design". The deeper reason to restore it is the one it implied but did not state: now that every firing takes a row lock, letting an unrelated note edit fire the trigger widens exactly the lock exposure finding 1 exists to bound. The trigger carries a comment requiring future occupancy-affecting columns to be added to that list, which is the cost of the choice.

## Self-review notes

**Spec coverage.** Occupancy predicate → Task 1 step 3 §1. Sticky manual statuses → §2, tested in Task 1 step 1. Both-sides recompute → §4, tested. Units guard and the bulk-import argument → §5, tested. Column default → Task 2 §6. Backfill → §7. Catalog → §8. Invariant → §9. UI split, disabled field, both-locale i18n, `bulkImportSchemas` default → Task 3. Gates and guards → Task 4. PR → Task 5. Production apply → Task 6. The spec's two out-of-scope items appear in the PR body as stated limitations rather than as tasks, which is where the spec puts them.

**Naming consistency.** `unit_has_active_contract`, `compute_unit_status`, `sync_unit_status_for`, `tg_contract_sync_unit_status`, `tg_unit_enforce_derived_status`, `trg_contract_sync_unit_status`, `trg_unit_enforce_derived_status` are used identically in Tasks 1, 2 and 6. `unitStatusFilterValues` / `unitStatusEditableValues` / `unitStatusFilterOptions` / `unitStatusEditableOptions` are used identically in Task 3 steps 3 and the field wiring. `units.statusDerived` / `units.statusManualOnly` are defined in Task 3 step 2 and consumed in steps 3 and 5.

**Placeholder scan.** One was found and fixed: Task 3 steps 4 and 5 originally told the implementer to "read the surrounding code" for the `save()` / `saveUnit()` payload objects rather than quoting them. Both are now quoted verbatim from `admin.units.index.tsx:181-188` and `admin.properties.$id.tsx:140-145`.

**Design detail worth stating, since it is easy to get wrong.** Disabling the status field is not sufficient on its own. `save()` submits the whole form, so an occupied unit would post `status: "vacant"` on any unrelated edit and the units trigger would raise — turning a rename into a save failure with a confusing message. Both pages therefore build a separate `updates` object and `delete updates.status` when the unit is occupied.

An earlier draft of this plan used a conditional spread of `{ status: undefined }` and claimed `supabase-js` drops it on serialisation. That was replaced: it rested on an unverified serialisation detail, and the typing was not obviously sound given that `database.types.ts` here is hand-maintained with a custom `TableDefinition` shape rather than generator output. `Update: Partial<Row>` was then checked directly (line 107-112), which is what makes the explicit `delete` legal. The failure mode this avoids is specific — an implementer who hits a type error on the payload is likely to drop the omission entirely and lean on the `disabled` attribute, which reintroduces exactly the raise-on-rename bug.

Task 1's test `editing an occupied unit's other columns still works` covers the database half of this. The client half has no test, and that is a gap this plan accepts rather than introducing a component test harness the repo does not currently have.
