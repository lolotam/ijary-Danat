# Multi-Unit Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one contract hold several units across several properties, each with its own rent, billed on a single consolidated invoice.

**Architecture:** The unit is promoted from a column on `contracts` to a `contract_units` join table. `contracts.monthly_amount` survives as a trigger-maintained total so existing displays keep working. The invoice generator emits one `invoice_items` rent line per unit instead of one per contract; the invoice itself is unchanged, because `unique (contract_id, period_year, period_month)` already made it consolidated. Payments need no change at all — they were already tenant-level.

**Tech Stack:** TanStack Start (React 19) + Nitro on Bun · self-hosted Supabase (Postgres 17, PostgREST, GoTrue behind Kong) · manual SQL migrations in `db/migrations/` · Vitest (node environment) · `bun run test:sql` runs SQL integration tests against a real Postgres in Docker.

**Spec:** `docs/superpowers/specs/2026-08-07-multi-unit-contracts-design.md`

## Global Constraints

- All new SQL goes in **one file**: `db/migrations/110_multi_unit_contracts.sql`. Tasks append sections to it in order.
- **Migrations supersede by number.** Never edit an applied migration. The live definition of a function is the one in the highest-numbered file. Re-issue functions in 110, do not patch 82 or 87.
- **`database.types.ts` is hand-maintained** despite looking generated. Add entries by hand. `bun run gen:types` writes a _reference_ file — never overwrite the real one.
- **`src/routeTree.gen.ts` is generated** — never edit.
- The repo is Lovable-connected: **never force-push, rebase, amend, or squash commits already pushed to `main`.**
- All units on a contract share the contract's start and end date. There are **no per-unit dates** (spec decision 4).
- The consolidated invoice carries **one rent line per unit** (spec decision 3).
- `invoices.unit_id` is set only when the contract has exactly one unit, otherwise null (spec decision 5).
- `contracts.monthly_amount` is **never written by application code** after this change (spec decision 6).
- Bulk import stays single-unit; the CSV format does not change (spec decision 7).
- Gates before every commit: `bun run lint`, `bun run typecheck`, `bun run test`. Tasks touching SQL also run `bun run test:sql`.

---

## File Structure

**Created**

| File                                               | Responsibility                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `db/migrations/110_multi_unit_contracts.sql`       | The entire schema change: table, backfill, constraints, triggers, re-issued functions, RLS, and the final column drop |
| `src/db/multiUnitContracts.sqltest.ts`             | SQL integration tests for the join table, consolidated invoicing and the constraints                                  |
| `src/components/admin/ContractUnitsField.tsx`      | The multi-property / multi-unit picker and its per-unit rent sections                                                 |
| `src/components/admin/ContractUnitsField.test.tsx` | Unit tests for the selection → rent-section mapping                                                                   |
| `src/lib/contractUnits.ts`                         | Pure helpers: aggregate units across properties, total the rents, map form values to the save payload                 |
| `src/lib/contractUnits.test.ts`                    | Unit tests for those helpers                                                                                          |

**Modified**

| File                                                                                                | Change                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/db/testDb.ts:199-217`                                                                          | `seedContract` stops writing `contracts.unit_id`; gains an optional `units` list                                                                                    |
| `src/integrations/supabase/database.types.ts`                                                       | Add `ContractUnitRow` + table entry; drop `ContractRow.unit_id`; make `InvoiceRow.unit_id` and `ContractCloseoutRow.unit_id` nullable; add `InvoiceItemRow.unit_id` |
| `src/hooks/useContracts.ts:120-209, 360-390`                                                        | Load units through `contract_units`; `unit` becomes `units`                                                                                                         |
| `src/lib/tenantLocations.ts`                                                                        | Selectors fan out over a contract's units                                                                                                                           |
| `src/routes/admin.contracts.tsx`                                                                    | Form uses `ContractUnitsField`; save goes through the new RPC                                                                                                       |
| `src/components/admin/tenant-detail/ContractTabPanel.tsx:48`                                        | Render all units, not one                                                                                                                                           |
| `src/fns/contractExpiryJob.ts:86`, `src/fns/notifyContractLifecycle.ts:54`                          | Resolve unit names through `contract_units`                                                                                                                         |
| `src/routes/admin.tenants.$id.index.tsx`, `admin.units.$id.tsx`, `admin.contracts.$id.closeout.tsx` | Read units from the new shape                                                                                                                                       |

---

## Task 1: `contract_units` table, backfill and totals

**Files:**

- Create: `db/migrations/110_multi_unit_contracts.sql`
- Create: `src/db/multiUnitContracts.sqltest.ts`
- Modify: `src/db/testDb.ts:154-220`
- Modify: `src/integrations/supabase/database.types.ts`

**Interfaces:**

- Produces: table `public.contract_units (id, contract_id, unit_id, monthly_amount, line_order, occupies_unit, created_at, updated_at)`; unique index `one_active_contract_per_unit` on `contract_units (unit_id) where occupies_unit`; TS type `ContractUnitRow`; `seedContract(client, options)` where `options.units?: Array<{ monthlyAmount: number }>`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `src/db/multiUnitContracts.sqltest.ts`:

```ts
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { captureRaise, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

describe("contract_units", () => {
  it("carries one row per unit and totals onto the contract", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });

      const rows = await client.query(
        `select unit_id, monthly_amount, line_order from public.contract_units
          where contract_id = $1 order by line_order`,
        [fixture.contractId],
      );
      expect(rows.rowCount).toBe(3);
      expect(rows.rows.map((r) => Number(r.monthly_amount))).toEqual([400, 400, 400]);

      const total = await client.query(
        `select monthly_amount from public.contracts where id = $1`,
        [fixture.contractId],
      );
      expect(Number(total.rows[0].monthly_amount)).toBe(1200);
    });
  });

  it("keeps the contract total in step when a unit rent changes or is removed", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });

      await client.query(
        `update public.contract_units set monthly_amount = 550
          where contract_id = $1 and line_order = 1`,
        [fixture.contractId],
      );
      let total = await client.query(`select monthly_amount from public.contracts where id = $1`, [
        fixture.contractId,
      ]);
      expect(Number(total.rows[0].monthly_amount)).toBe(950);

      await client.query(
        `delete from public.contract_units where contract_id = $1 and line_order = 2`,
        [fixture.contractId],
      );
      total = await client.query(`select monthly_amount from public.contracts where id = $1`, [
        fixture.contractId,
      ]);
      expect(Number(total.rows[0].monthly_amount)).toBe(550);
    });
  });

  it("refuses the same unit twice on one contract", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const existing = await client.query(
        `select unit_id from public.contract_units where contract_id = $1`,
        [fixture.contractId],
      );
      // captureRaise, not `rejects.toThrow`: Postgres aborts the whole
      // transaction on any error, and withRollback's later statements would
      // then fail with "current transaction is aborted". See testDb.ts:100-106.
      const message = await captureRaise(client, () =>
        client.query(
          `insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
           values ($1, $2, 100, 2)`,
          [fixture.contractId, existing.rows[0].unit_id],
        ),
      );
      expect(message).toMatch(/contract_units_contract_id_unit_id_key/);
    });
  });

  it("refuses a unit already held by another live contract", async () => {
    await withRollback(async (client: PoolClient) => {
      const first = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
      });
      const held = await client.query(
        `select unit_id from public.contract_units where contract_id = $1`,
        [first.contractId],
      );
      const second = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
      });
      const message = await captureRaise(client, () =>
        client.query(
          `insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
           values ($1, $2, 100, 2)`,
          [second.contractId, held.rows[0].unit_id],
        ),
      );
      expect(message).toMatch(/one_active_contract_per_unit/);
    });
  });

  it("releases the unit for uniqueness when the contract reaches a terminal state", async () => {
    await withRollback(async (client: PoolClient) => {
      const first = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
      });
      const held = await client.query(
        `select unit_id from public.contract_units where contract_id = $1`,
        [first.contractId],
      );
      await client.query(`update public.contracts set state = 'terminated' where id = $1`, [
        first.contractId,
      ]);
      const second = await seedContract(client, {
        startDate: "2027-01-01",
        endDate: "2027-12-31",
        state: "active",
      });
      // Must not raise.
      await client.query(
        `insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
         values ($1, $2, 100, 2)`,
        [second.contractId, held.rows[0].unit_id],
      );
      const count = await client.query(
        `select count(*)::int n from public.contract_units where contract_id = $1`,
        [second.contractId],
      );
      expect(count.rows[0].n).toBe(2);
    });
  });

  it("gave every contract seeded by migration 11 exactly one unit", async () => {
    await withRollback(async (client: PoolClient) => {
      const orphans = await client.query(
        `select c.id from public.contracts c
          where not exists (select 1 from public.contract_units cu where cu.contract_id = c.id)`,
      );
      expect(orphans.rowCount).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:sql -- multiUnitContracts`
Expected: FAIL with `relation "public.contract_units" does not exist`.

- [ ] **Step 3: Write the migration**

Create `db/migrations/110_multi_unit_contracts.sql`:

```sql
-- 110_multi_unit_contracts.sql
--
-- Promote the unit from a column on `contracts` to a join table, so one
-- contract can hold several units across several properties.
--
-- Why a new file, not an edit of 04/76/82/87: supersede-by-number. SQL
-- functions are `create or replace` and the LIVE definition of any function is
-- the one in the HIGHEST-numbered migration file. Patching an old file would
-- leave the suite asserting against text that never re-applies.
--
-- Section 1 (this task): table, backfill, constraints, totals.

create table if not exists public.contract_units (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete restrict,
  monthly_amount numeric(14,3) not null check (monthly_amount >= 0),
  line_order integer not null default 1,
  -- NOT a business field. It exists only to carry the double-booking
  -- constraint, which cannot follow `unit_id` to this table: a Postgres index
  -- predicate cannot reference `contracts.state` in another table.
  occupies_unit boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contract_id, unit_id)
);

create index if not exists contract_units_contract_id_idx on public.contract_units (contract_id);
create index if not exists contract_units_unit_id_idx on public.contract_units (unit_id);

drop trigger if exists set_updated_at on public.contract_units;
create trigger set_updated_at before update on public.contract_units
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- Backfill. Must run BEFORE the unique index below, or the index is built
-- against an empty table and enforces nothing on existing rows.
-- ---------------------------------------------------------------------------
insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order, occupies_unit)
select c.id, c.unit_id, c.monthly_amount, 1,
       c.state in ('draft', 'active', 'frozen', 'suspended')
  from public.contracts c
 where not exists (select 1 from public.contract_units cu where cu.contract_id = c.id);

-- ---------------------------------------------------------------------------
-- occupies_unit mirrors the UNIQUENESS predicate from 04:179-180 exactly:
--   state in ('draft','active','frozen','suspended')
--
-- `archived_at` is DELIBERATELY absent, and must stay absent. It looks like an
-- omission; it is not. The uniqueness index has never considered archived_at,
-- and adding it here would let a second live contract be created on a unit an
-- archived contract still holds. Occupancy (units.status, migration 76) uses a
-- DIFFERENT predicate that does consider archived_at. The two differ on
-- purpose. Do not "make them consistent".
-- ---------------------------------------------------------------------------
create or replace function public.tg_contract_units_seed_occupies()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select c.state in ('draft', 'active', 'frozen', 'suspended')
    into new.occupies_unit
    from public.contracts c
   where c.id = new.contract_id;
  return new;
end;
$$;

drop trigger if exists trg_contract_units_seed_occupies on public.contract_units;
create trigger trg_contract_units_seed_occupies
  before insert or update of contract_id on public.contract_units
  for each row execute function public.tg_contract_units_seed_occupies();

create or replace function public.tg_contract_propagate_occupies()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.contract_units
     set occupies_unit = new.state in ('draft', 'active', 'frozen', 'suspended')
   where contract_id = new.id
     and occupies_unit <> (new.state in ('draft', 'active', 'frozen', 'suspended'));
  return new;
end;
$$;

drop trigger if exists trg_contract_propagate_occupies on public.contracts;
-- `update of state` only: occupies_unit is a pure function of state.
create trigger trg_contract_propagate_occupies
  after update of state on public.contracts
  for each row execute function public.tg_contract_propagate_occupies();

update public.contract_units cu
   set occupies_unit = c.state in ('draft', 'active', 'frozen', 'suspended')
  from public.contracts c
 where c.id = cu.contract_id;

drop index if exists public.one_active_contract_per_unit;
create unique index one_active_contract_per_unit
  on public.contract_units (unit_id) where occupies_unit;

-- ---------------------------------------------------------------------------
-- contracts.monthly_amount becomes the trigger-maintained total. Application
-- code must never write it again.
-- ---------------------------------------------------------------------------
create or replace function public.tg_contract_units_sync_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _contract uuid := coalesce(new.contract_id, old.contract_id);
begin
  update public.contracts c
     set monthly_amount = coalesce(
           (select sum(cu.monthly_amount) from public.contract_units cu
             where cu.contract_id = _contract), 0)
   where c.id = _contract;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_contract_units_sync_total on public.contract_units;
create trigger trg_contract_units_sync_total
  after insert or delete or update of monthly_amount, contract_id
  on public.contract_units
  for each row execute function public.tg_contract_units_sync_total();

alter table public.contracts alter column monthly_amount set default 0;

grant select, insert, update, delete on public.contract_units to authenticated;
alter table public.contract_units enable row level security;

drop policy if exists contract_units_staff_all on public.contract_units;
create policy contract_units_staff_all on public.contract_units
  for all to authenticated
  using (public.has_permission(auth.uid(), 'contracts.read'))
  with check (public.has_permission(auth.uid(), 'contracts.update'));
```

- [ ] **Step 4: Update the shared SQL fixture**

In `src/db/testDb.ts`, replace the contract insert at lines 199-217. Add `units?: Array<{ monthlyAmount: number }>` to `ContractOptions` and `unitIds: string[]` to `ContractFixture`:

```ts
// contracts has no company_id — it reaches the company through
// tenant_id -> tenants.company_id, which is what generate_invoices reads when
// stamping invoices.company_id.
//
// monthly_amount is NOT written here: it is the trigger-maintained total of
// contract_units (migration 110). Writing it would be silently overwritten.
const contract = await client.query<{ id: string }>(
  `insert into public.contracts
       (code, tenant_id, start_date, end_date, due_day, grace_days, deposit, state)
     values ($1, $2, $3::date, $4::date, $5, $6, $7, $8::public.contract_states)
     returning id`,
  [`C-${tag}`, tenantId, startDate, endDate, dueDay, graceDays, deposit, state],
);
const contractId = contract.rows[0].id;

// Default shape is the single unit created above, so the ~30 existing
// sqltest files keep their current call signature unchanged.
const unitPlan = options.units ?? [{ monthlyAmount }];
const unitIds: string[] = [unitId];
for (let index = 1; index < unitPlan.length; index += 1) {
  const extra = await client.query<{ id: string }>(
    `insert into public.units (code, property_id, name) values ($1, $2, $3) returning id`,
    [`U-${tag}-${index}`, propertyId, `Unit ${tag}-${index}`],
  );
  unitIds.push(extra.rows[0].id);
}
for (const [index, unitRow] of unitPlan.entries()) {
  await client.query(
    `insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
       values ($1, $2, $3, $4)`,
    [contractId, unitIds[index], unitRow.monthlyAmount, index + 1],
  );
}

return { companyId, propertyId, unitId, unitIds, tenantId, contractId };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test:sql`
Expected: PASS — the new file plus all 30 existing sqltest files, which must be unaffected because `seedContract`'s default shape is unchanged.

- [ ] **Step 6: Add the TypeScript type by hand**

In `src/integrations/supabase/database.types.ts`, add beside `ContractRow`:

```ts
/** Migration 110 — a contract holds one row per rented unit. */
export type ContractUnitRow = {
  contract_id: string;
  created_at: string;
  id: string;
  line_order: number;
  monthly_amount: number;
  /** Trigger-maintained mirror of the uniqueness predicate. Never write it. */
  occupies_unit: boolean;
  unit_id: string;
  updated_at: string;
};
```

And in the `Tables` block beside `contracts`:

```ts
contract_units: TableDefinition<ContractUnitRow, "contract_id" | "unit_id" | "monthly_amount">;
```

- [ ] **Step 7: Run the gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add db/migrations/110_multi_unit_contracts.sql src/db/multiUnitContracts.sqltest.ts src/db/testDb.ts src/integrations/supabase/database.types.ts
git commit -F - <<'MSG'
feat(contracts): add contract_units, backfilled from contracts.unit_id

The double-booking guarantee could not follow unit_id to the join table --
an index predicate cannot reference contracts.state in another table -- so
the predicate is mirrored as a trigger-maintained boolean and the unique
index is rebuilt on contract_units.

archived_at is deliberately absent from that mirror; the uniqueness index
has never considered it, and adding it would let a second live contract be
created on a unit an archived one still holds.
MSG
```

---

## Task 2: Unit occupancy reads the join table

**Files:**

- Modify: `db/migrations/110_multi_unit_contracts.sql` (append section 2)
- Modify: `src/db/multiUnitContracts.sqltest.ts`

**Interfaces:**

- Consumes: `public.contract_units` from Task 1.
- Produces: `public.unit_has_active_contract(uuid) returns boolean` reading `contract_units`; triggers `trg_contract_sync_unit_status` on `contracts` (state/archived_at) and `trg_contract_units_sync_unit_status` on `contract_units` (insert/delete).

- [ ] **Step 1: Write the failing test**

Append to `src/db/multiUnitContracts.sqltest.ts`:

```ts
describe("unit occupancy from contract_units", () => {
  it("marks every unit on the contract occupied, and all of them vacant on termination", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });

      let statuses = await client.query(
        `select status from public.units where id = any($1::uuid[]) order by status`,
        [fixture.unitIds],
      );
      expect(statuses.rows.map((r) => r.status)).toEqual(["occupied", "occupied"]);

      await client.query(`update public.contracts set state = 'terminated' where id = $1`, [
        fixture.contractId,
      ]);
      statuses = await client.query(
        `select status from public.units where id = any($1::uuid[]) order by status`,
        [fixture.unitIds],
      );
      expect(statuses.rows.map((r) => r.status)).toEqual(["vacant", "vacant"]);
    });
  });

  it("frees only the removed unit when one is taken off the contract", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });
      await client.query(
        `delete from public.contract_units where contract_id = $1 and line_order = 2`,
        [fixture.contractId],
      );
      const statuses = await client.query(
        `select u.id, u.status from public.units u where u.id = any($1::uuid[])`,
        [fixture.unitIds],
      );
      const byId = new Map(statuses.rows.map((r) => [r.id, r.status]));
      expect(byId.get(fixture.unitIds[0])).toBe("occupied");
      expect(byId.get(fixture.unitIds[1])).toBe("vacant");
    });
  });

  it("treats an archived contract as releasing its units", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });
      await client.query(`update public.contracts set archived_at = now() where id = $1`, [
        fixture.contractId,
      ]);
      const statuses = await client.query(
        `select status from public.units where id = any($1::uuid[])`,
        [fixture.unitIds],
      );
      expect(statuses.rows.every((r) => r.status === "vacant")).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:sql -- multiUnitContracts`
Expected: FAIL — the second unit reports `vacant` while occupied, because `unit_has_active_contract` still reads `contracts.unit_id` and the trigger no longer sees unit changes.

- [ ] **Step 3: Append section 2 to the migration**

```sql
-- ---------------------------------------------------------------------------
-- Section 2: occupancy (supersedes migration 76).
--
-- The occupancy predicate DOES consider archived_at; the uniqueness predicate
-- in section 1 does NOT. This asymmetry is intentional and pre-dates this
-- migration -- see 76's header and 04:179-180.
-- ---------------------------------------------------------------------------
create or replace function public.unit_has_active_contract(_unit uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.contract_units cu
      join public.contracts c on c.id = cu.contract_id
     where cu.unit_id = _unit
       and c.state = 'active'
       and c.archived_at is null
  );
$$;

-- Shared body: lock every affected unit up front in ascending uuid order
-- BEFORE recomputing any of them. Migration 76 documents why -- two terminal
-- contracts may legally swap units concurrently, and recomputing one-then-the-
-- other without a stable lock order deadlocks. That reasoning survives the
-- move to the join table unchanged.
create or replace function public.sync_unit_status_many(_units uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  _unit uuid;
begin
  for _unit in
    select distinct x from unnest(_units) as t(x) where x is not null order by 1
  loop
    perform 1 from public.units where id = _unit for update;
  end loop;
  for _unit in
    select distinct x from unnest(_units) as t(x) where x is not null order by 1
  loop
    perform public.sync_unit_status_for(_unit);
  end loop;
end;
$$;

create or replace function public.tg_contract_sync_unit_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_unit_status_many(
    array(select cu.unit_id from public.contract_units cu where cu.contract_id = new.id)
  );
  return new;
end;
$$;

drop trigger if exists trg_contract_sync_unit_status on public.contracts;
-- `update of state, archived_at` only. unit_id is gone from this table; unit
-- membership changes fire the contract_units trigger below instead.
create trigger trg_contract_sync_unit_status
  after update of state, archived_at on public.contracts
  for each row execute function public.tg_contract_sync_unit_status();

create or replace function public.tg_contract_units_sync_unit_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _units uuid[] := '{}';
begin
  if tg_op <> 'INSERT' then _units := _units || old.unit_id; end if;
  if tg_op <> 'DELETE' then _units := _units || new.unit_id; end if;
  perform public.sync_unit_status_many(_units);
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_contract_units_sync_unit_status on public.contract_units;
create trigger trg_contract_units_sync_unit_status
  after insert or delete or update of unit_id on public.contract_units
  for each row execute function public.tg_contract_units_sync_unit_status();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:sql`
Expected: PASS, including `src/db/unitStatus.sqltest.ts` unchanged in substance. `unitStatus.sqltest.ts:117` moves a contract between units with `update public.contracts set unit_id = ...`; rewrite that one statement as `update public.contract_units set unit_id = $1 where contract_id = $2` — the behaviour it asserts (both origin and destination units recomputed) is unchanged.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/110_multi_unit_contracts.sql src/db/multiUnitContracts.sqltest.ts src/db/unitStatus.sqltest.ts
git commit -m "feat(units): occupancy derives from contract_units"
```

---

## Task 3: Consolidated invoice with one rent line per unit

**Files:**

- Modify: `db/migrations/110_multi_unit_contracts.sql` (append section 3)
- Modify: `src/db/multiUnitContracts.sqltest.ts`
- Modify: `src/integrations/supabase/database.types.ts`

**Interfaces:**

- Consumes: `public.contract_units` from Task 1.
- Produces: `public.generate_invoices_for_year(uuid, integer, boolean)` emitting one rent line per unit; `invoice_items.unit_id`; nullable `invoices.unit_id`.

- [ ] **Step 1: Write the failing test**

Append to `src/db/multiUnitContracts.sqltest.ts`:

```ts
describe("consolidated invoicing", () => {
  it("bills three units as one invoice with three rent lines", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-03-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });
      await client.query(`select * from public.generate_invoices_for_year($1, 2026, true)`, [
        fixture.contractId,
      ]);

      const invoices = await client.query(
        `select id, total, unit_id, period_month from public.invoices
          where contract_id = $1 order by period_month`,
        [fixture.contractId],
      );
      expect(invoices.rowCount).toBe(3);
      expect(Number(invoices.rows[0].total)).toBe(1200);
      // Several units -> the invoice belongs to no single unit.
      expect(invoices.rows[0].unit_id).toBeNull();

      const items = await client.query(
        `select unit_id, amount, line from public.invoice_items
          where invoice_id = $1 and is_concession = false order by line`,
        [invoices.rows[0].id],
      );
      expect(items.rowCount).toBe(3);
      expect(items.rows.map((r) => Number(r.amount))).toEqual([400, 400, 400]);
      expect(new Set(items.rows.map((r) => r.unit_id)).size).toBe(3);
      expect(items.rows.every((r) => r.unit_id !== null)).toBe(true);
    });
  });

  it("still stamps invoices.unit_id for a single-unit contract", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        state: "active",
        monthlyAmount: 500,
      });
      await client.query(`select * from public.generate_invoices_for_year($1, 2026, true)`, [
        fixture.contractId,
      ]);
      const invoice = await client.query(
        `select unit_id, total from public.invoices where contract_id = $1`,
        [fixture.contractId],
      );
      expect(invoice.rows[0].unit_id).toBe(fixture.unitId);
      expect(Number(invoice.rows[0].total)).toBe(500);
    });
  });

  it("is idempotent — generating twice does not duplicate lines", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });
      await client.query(`select * from public.generate_invoices_for_year($1, 2026, true)`, [
        fixture.contractId,
      ]);
      await client.query(`select * from public.generate_invoices_for_year($1, 2026, true)`, [
        fixture.contractId,
      ]);
      const counts = await client.query(
        `select (select count(*) from public.invoices where contract_id = $1)::int invoices,
                (select count(*) from public.invoice_items ii
                  join public.invoices i on i.id = ii.invoice_id
                 where i.contract_id = $1)::int items`,
        [fixture.contractId],
      );
      expect(counts.rows[0].invoices).toBe(1);
      expect(counts.rows[0].items).toBe(2);
    });
  });

  it("applies a fixed discount to the contract total once, not once per unit", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });
      await client.query(
        `insert into public.concessions
           (contract_id, type, discount_amount, start_date, end_date, status)
         values ($1, 'fixed_discount', 100, '2026-01-01', '2026-12-31', 'active')`,
        [fixture.contractId],
      );
      await client.query(`select * from public.generate_invoices_for_year($1, 2026, true)`, [
        fixture.contractId,
      ]);
      const invoice = await client.query(
        `select subtotal, discount, total from public.invoices where contract_id = $1`,
        [fixture.contractId],
      );
      expect(Number(invoice.rows[0].subtotal)).toBe(800);
      expect(Number(invoice.rows[0].discount)).toBe(100);
      expect(Number(invoice.rows[0].total)).toBe(700);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:sql -- multiUnitContracts`
Expected: FAIL — `column "unit_id" of relation "invoice_items" does not exist`.

- [ ] **Step 3: Append section 3 to the migration**

Copy the whole `generate_invoices_for_year` body from `db/migrations/82_billing_safety_archived_contracts.sql` and change only what is listed here. Signature and `returns table (...)` row type are unchanged, so plain `create or replace` is legal — this is **not** the OUT-parameter hazard `db/README.md` warns about.

```sql
-- ---------------------------------------------------------------------------
-- Section 3: consolidated invoicing.
-- ---------------------------------------------------------------------------
alter table public.invoices alter column unit_id drop not null;
alter table public.invoice_items
  add column if not exists unit_id uuid references public.units(id) on delete restrict;

-- Existing rent lines belong to their invoice's single unit.
update public.invoice_items ii
   set unit_id = i.unit_id
  from public.invoices i
 where i.id = ii.invoice_id and ii.is_concession = false and ii.unit_id is null;
```

Then re-issue `generate_invoices_for_year` with these three edits to the copied body:

1. Replace `v_subtotal := v_contract.monthly_amount;` with:

```sql
        select coalesce(sum(cu.monthly_amount), 0) into v_subtotal
          from public.contract_units cu where cu.contract_id = v_contract.id;
```

2. In the `insert into public.invoices ... select`, replace `v_contract.unit_id` with:

```sql
          (select cu.unit_id from public.contract_units cu
            where cu.contract_id = v_contract.id
              and (select count(*) from public.contract_units c2
                     where c2.contract_id = v_contract.id) = 1),
```

3. Replace the single line-1 `insert into public.invoice_items (...) values (v_invoice_id, 1, 'قيمة استثمار شهرية', ...)` with a loop, and start `v_line` after it. Declare `v_unit record;` alongside the existing declarations:

```sql
        v_line := 1;
        for v_unit in
          select cu.unit_id, cu.monthly_amount, u.code
            from public.contract_units cu
            join public.units u on u.id = cu.unit_id
           where cu.contract_id = v_contract.id
           order by cu.line_order, cu.unit_id
        loop
          insert into public.invoice_items (
            invoice_id, line, unit_id, description_ar, description_en, quantity,
            unit_price, discount_percent, amount, is_concession
          ) values (
            v_invoice_id, v_line, v_unit.unit_id,
            'قيمة استثمار شهرية — ' || v_unit.code,
            'Monthly investment value — ' || v_unit.code,
            1, v_unit.monthly_amount, 0, v_unit.monthly_amount, false
          );
          v_line := v_line + 1;
        end loop;
```

Everything else stays byte-for-byte: the archived-contract guards, the free-months skip, the concession loop (which continues from `v_line`), and the `on conflict on constraint invoices_contract_id_period_year_period_month_key do nothing`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:sql`
Expected: PASS, including `src/db/archivedBillingSafety.sqltest.ts` and `src/db/invoiceRegeneration.sqltest.ts` unchanged — the archived guards and idempotency must survive.

- [ ] **Step 5: Update the types by hand**

In `src/integrations/supabase/database.types.ts`: change `InvoiceRow.unit_id` to `string | null`, and add `unit_id: string | null;` to `InvoiceItemRow`.

- [ ] **Step 6: Run the gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all pass. `typecheck` will flag any UI that assumed `invoice.unit_id` was non-null — fix each by rendering the item-level units where the invoice has none.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/110_multi_unit_contracts.sql src/db/multiUnitContracts.sqltest.ts src/integrations/supabase/database.types.ts src/
git commit -m "feat(invoices): one rent line per unit on a consolidated invoice"
```

---

## Task 4: Electricity tenant resolution and bulk import

**Files:**

- Modify: `db/migrations/110_multi_unit_contracts.sql` (append section 4)
- Modify: `src/db/multiUnitContracts.sqltest.ts`

**Interfaces:**

- Consumes: `public.contract_units` from Task 1.
- Produces: re-issued `public.validate_electricity_charge_insert()` and `public.bulk_import_phase6(...)`, both reading `contract_units`.

- [ ] **Step 1: Write the failing test**

Append to `src/db/multiUnitContracts.sqltest.ts`:

```ts
describe("downstream readers of a contract's units", () => {
  it("attributes a tenant-owned meter charge to the multi-unit contract's tenant", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });
      const meter = await client.query<{ id: string }>(
        `insert into public.electricity_meters (code, unit_id, ownership)
         values ($1, $2, 'tenant_owned') returning id`,
        [`M-${randomUUID().slice(0, 8)}`, fixture.unitIds[1]],
      );
      const charge = await client.query(
        `insert into public.electricity_charges
           (meter_id, unit_id, period_year, period_month, consumption_kwh, amount)
         values ($1, $2, 2026, 3, 100, 25) returning tenant_id`,
        [meter.rows[0].id, fixture.unitIds[1]],
      );
      expect(charge.rows[0].tenant_id).toBe(fixture.tenantId);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:sql -- multiUnitContracts`
Expected: FAIL — `tenant_id` is null, because the trigger looked for a contract whose `contracts.unit_id` matched the meter's unit and the second unit was never on that column.

- [ ] **Step 3: Append section 4 to the migration**

Copy `validate_electricity_charge_insert` from `db/migrations/09_phase7_electricity.sql` and change only the tenant lookup:

```sql
-- ---------------------------------------------------------------------------
-- Section 4: electricity tenant resolution + bulk import.
-- ---------------------------------------------------------------------------
    select c.tenant_id into v_tenant_id
      from public.contract_units cu
      join public.contracts c on c.id = cu.contract_id
     where cu.unit_id = v_meter.unit_id and c.state = 'active'
       and c.start_date <= v_period_end and c.end_date >= v_period_start
     order by c.start_date desc, c.id
     limit 1;
```

Then copy `bulk_import_phase6` from `db/migrations/103_unit_property_types_free_text.sql` (which supersedes 78) and change the `contracts` branch so the `with new_contracts as (insert into public.contracts ...)` no longer names `unit_id` or `monthly_amount`, and follows with an insert into `contract_units` using the returned contract ids. The CSV shape is unchanged — one row still means one unit (spec decision 7).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:sql`
Expected: PASS, including `src/db/bulkImportContracts.sqltest.ts`. That file passes `unit_id` in its JSON payloads (lines 85, 93, 117, 125, 151, 177, 204, 239, 295) — the payload key stays, because the importer still receives one unit per row and now writes it to `contract_units`.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/110_multi_unit_contracts.sql src/db/multiUnitContracts.sqltest.ts
git commit -m "feat(sql): electricity and bulk import read contract_units"
```

---

## Task 5: Close-out and restore

**Files:**

- Modify: `db/migrations/110_multi_unit_contracts.sql` (append section 5)
- Modify: `src/db/multiUnitContracts.sqltest.ts`

**Interfaces:**

- Consumes: `public.contract_units` from Task 1.
- Produces: re-issued close-out / cancel / restore RPCs from `db/migrations/87_contract_closeout_rpcs.sql`, plus nullable `contract_closeouts.unit_id`.

- [ ] **Step 1: Write the failing test**

Append to `src/db/multiUnitContracts.sqltest.ts`:

```ts
describe("close-out and restore with several units", () => {
  it("raises a readable error naming the conflicting unit on restore", async () => {
    await withRollback(async (client: PoolClient) => {
      const first = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });
      await client.query(
        `update public.contracts set state = 'terminated', archived_at = now() where id = $1`,
        [first.contractId],
      );
      const second = await seedContract(client, {
        startDate: "2027-01-01",
        endDate: "2027-12-31",
        state: "active",
      });
      await client.query(
        `insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
         values ($1, $2, 300, 2)`,
        [second.contractId, first.unitIds[1]],
      );
      const message = await captureRaise(client, () =>
        client.query(`select public.restore_contract($1)`, [first.contractId]),
      );
      expect(message).toMatch(/another live contract .* holds unit/i);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:sql -- multiUnitContracts`
Expected: FAIL — either a raw `23505` unique-violation from `one_active_contract_per_unit`, or no error at all, because the pre-flight check at `87:1030-1038` still reads `c2.unit_id`.

- [ ] **Step 3: Append section 5 to the migration**

```sql
-- ---------------------------------------------------------------------------
-- Section 5: close-out and restore.
-- ---------------------------------------------------------------------------
alter table public.contract_closeouts alter column unit_id drop not null;
```

Then copy the close-out RPCs from `db/migrations/87_contract_closeout_rpcs.sql` and apply three changes:

1. **Recording the unit** (`87:477`, `:499`) — replace `v_contract.unit_id` with the single-unit-or-null expression:

```sql
      (select cu.unit_id from public.contract_units cu
        where cu.contract_id = v_contract.id
          and (select count(*) from public.contract_units c2
                 where c2.contract_id = v_contract.id) = 1)
```

2. **Resolving the building** (`87:466`, `:674`, `:1068`, `:1155`) — replace `where u.id = v_contract.unit_id` with the lowest-`line_order` unit:

```sql
     from public.units u
     join public.contract_units cu on cu.unit_id = u.id
    where cu.contract_id = v_contract.id
    order by cu.line_order, cu.unit_id
    limit 1;
```

3. **Restore's pre-flight check** (`87:1030-1038`) — fan out over all the contract's units:

```sql
  select c2.id, cu2.unit_id into v_holder, v_holder_unit
    from public.contract_units cu
    join public.contract_units cu2 on cu2.unit_id = cu.unit_id
    join public.contracts c2 on c2.id = cu2.contract_id
   where cu.contract_id = p_contract_id
     and c2.id <> p_contract_id
     and c2.archived_at is null
     and c2.state in ('draft', 'active', 'frozen', 'suspended')
   order by cu2.unit_id
   limit 1;
  if v_holder is not null then
    raise exception 'Cannot restore: another live contract (%) holds unit %',
      v_holder, v_holder_unit;
  end if;
```

Declare `v_holder_unit uuid;` alongside `v_holder`. In the audit payloads (`87:722`, `:1075`, `:1162`) add a `unit_ids` array beside the existing `unit_id` key, so a multi-unit close-out is not recorded as having no unit:

```sql
    'unit_ids', (select coalesce(jsonb_agg(cu.unit_id order by cu.line_order), '[]'::jsonb)
                   from public.contract_units cu where cu.contract_id = v_contract.id),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:sql`
Expected: PASS, including `src/db/contractCloseout.sqltest.ts` and `src/db/contractRestore.sqltest.ts`. Those two files join `public.units u on u.id = c.unit_id` (`contractRestore.sqltest.ts:102, :124`) and insert contracts naming `unit_id` (`:211`, `lifecycle.sqltest.ts:94, :177`) — rewrite those statements to go through `contract_units`.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/110_multi_unit_contracts.sql src/db/
git commit -m "feat(closeout): settle and restore contracts holding several units"
```

---

## Task 6: Portal RLS

**Files:**

- Modify: `db/migrations/110_multi_unit_contracts.sql` (append section 6)
- Modify: `src/db/multiUnitContracts.sqltest.ts`

**Interfaces:**

- Consumes: `public.contract_units` from Task 1.
- Produces: replaced policies on `public.units` and `public.properties` from `db/migrations/17_tenant_portal_units_rls.sql`.

- [ ] **Step 1: Write the failing test**

Append to `src/db/multiUnitContracts.sqltest.ts`, and add `actAs, actAsSuperuser` to the `@/db/testDb` import. Use `actAs` rather than hand-rolled `set_config` calls — this image reads `request.jwt.claim.sub`, and setting only the JSON claims leaves `auth.uid()` NULL, making every isolation assertion pass for the wrong reason:

```ts
describe("portal RLS with several units", () => {
  it("shows the tenant all their units and none belonging to anyone else", async () => {
    await withRollback(async (client: PoolClient) => {
      const mine = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });
      const theirs = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
      });
      const portalUser = randomUUID();
      await client.query(
        `insert into public.profiles (id, tenant_id, is_active) values ($1, $2, true)`,
        [portalUser, mine.tenantId],
      );

      // actAs sets all four GUCs. Do not hand-roll this: setting only
      // request.jwt.claims leaves auth.uid() NULL in this image, and every
      // isolation assertion then passes for the wrong reason. See testDb.ts:60-70.
      await actAs(client, "authenticated", portalUser);

      const visible = await client.query(`select id from public.units`);
      const ids = visible.rows.map((r) => r.id).sort();
      expect(ids).toEqual([...mine.unitIds].sort());
      expect(ids).not.toContain(theirs.unitId);

      const properties = await client.query(`select id from public.properties`);
      expect(properties.rowCount).toBe(1);
      expect(properties.rows[0].id).toBe(mine.propertyId);

      await actAsSuperuser(client);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:sql -- multiUnitContracts`
Expected: FAIL — zero units visible, because the policy still joins `c.unit_id = units.id` and that column no longer carries the tenancy.

- [ ] **Step 3: Append section 6 to the migration**

```sql
-- ---------------------------------------------------------------------------
-- Section 6: portal RLS (supersedes migration 17).
-- All-or-nothing: get this wrong and a tenant sees NO units at all.
-- ---------------------------------------------------------------------------
drop policy if exists tenant_portal_read_units on public.units;
create policy tenant_portal_read_units on public.units
  for select to authenticated
  using (
    exists (
      select 1
        from public.contract_units cu
        join public.contracts c on c.id = cu.contract_id
        join public.profiles p on p.tenant_id = c.tenant_id
       where p.id = auth.uid()
         and cu.unit_id = units.id
    )
  );

drop policy if exists tenant_portal_read_properties on public.properties;
create policy tenant_portal_read_properties on public.properties
  for select to authenticated
  using (
    exists (
      select 1
        from public.contract_units cu
        join public.units u on u.id = cu.unit_id
        join public.contracts c on c.id = cu.contract_id
        join public.profiles p on p.tenant_id = c.tenant_id
       where p.id = auth.uid()
         and u.property_id = properties.id
    )
  );
```

Confirm the exact policy names first with `grep -n "create policy" db/migrations/17_tenant_portal_units_rls.sql` and use those names, so the `drop policy` lines match.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:sql`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/110_multi_unit_contracts.sql src/db/multiUnitContracts.sqltest.ts
git commit -m "feat(portal): tenants see every unit on their contract"
```

---

## Task 7: TypeScript read layer

**Files:**

- Create: `src/lib/contractUnits.ts`, `src/lib/contractUnits.test.ts`
- Modify: `src/hooks/useContracts.ts:120-209, 360-390`
- Modify: `src/lib/tenantLocations.ts`
- Modify: `src/components/admin/tenant-detail/ContractTabPanel.tsx:48`
- Modify: `src/fns/contractExpiryJob.ts:86`, `src/fns/notifyContractLifecycle.ts:54`
- Modify: `src/routes/admin.tenants.$id.index.tsx`, `src/routes/admin.units.$id.tsx`, `src/routes/admin.contracts.$id.closeout.tsx`, `src/routes/admin.contracts.tsx`

**Interfaces:**

- Consumes: `ContractUnitRow` from Task 1.
- Produces: `ContractWithRelations.units: Array<{ unit: Tables<"units">; property: Tables<"properties"> | null; monthlyAmount: number }>`; `aggregateUnitsForProperties(units, propertyIds)`; `totalMonthlyAmount(rows)`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/contractUnits.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { aggregateUnitsForProperties, totalMonthlyAmount } from "./contractUnits";

const units = [
  { id: "u1", property_id: "p1", code: "A101", name: "Shop A" },
  { id: "u2", property_id: "p2", code: "B205", name: "Shop B" },
  { id: "u3", property_id: "p3", code: "C310", name: "Store C" },
];

describe("aggregateUnitsForProperties", () => {
  it("returns the union of units across every selected property", () => {
    expect(aggregateUnitsForProperties(units, ["p1", "p2"]).map((u) => u.id)).toEqual(["u1", "u2"]);
  });

  it("returns nothing when no property is selected, so the picker starts empty", () => {
    expect(aggregateUnitsForProperties(units, [])).toEqual([]);
  });

  it("ignores a selected property that has no units", () => {
    expect(aggregateUnitsForProperties(units, ["p1", "p9"]).map((u) => u.id)).toEqual(["u1"]);
  });
});

describe("totalMonthlyAmount", () => {
  it("sums the per-unit rents", () => {
    expect(totalMonthlyAmount([{ monthly_amount: 400 }, { monthly_amount: 350.5 }])).toBe(750.5);
  });

  it("is zero for no units, so an empty form shows no rent", () => {
    expect(totalMonthlyAmount([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test contractUnits`
Expected: FAIL with "Cannot find module './contractUnits'".

- [ ] **Step 3: Write the helpers**

Create `src/lib/contractUnits.ts`:

```ts
interface UnitLike {
  id: string;
  property_id: string;
}

/**
 * Units across every selected property, in the order the units were given.
 *
 * Empty when nothing is selected: the picker must start empty rather than
 * offering every unit in the portfolio, which is what a naive "no filter means
 * no filtering" reading would produce.
 */
export function aggregateUnitsForProperties<T extends UnitLike>(
  units: T[],
  propertyIds: string[],
): T[] {
  if (!propertyIds.length) return [];
  const selected = new Set(propertyIds);
  return units.filter((unit) => selected.has(unit.property_id));
}

/** The contract's rent — mirrors the trigger that maintains contracts.monthly_amount. */
export function totalMonthlyAmount(rows: Array<{ monthly_amount: number }>): number {
  return rows.reduce((sum, row) => sum + row.monthly_amount, 0);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test contractUnits`
Expected: PASS.

- [ ] **Step 5: Move the read layer onto `contract_units`**

In `src/hooks/useContracts.ts`, replace the unit fetch at lines 125-129 and the mapping at 152-159. Fetch `contract_units` joined to units for the page's contract ids, then group:

```ts
const contractUnitResult = await supabase
  .from("contract_units")
  .select("contract_id, unit_id, monthly_amount, line_order")
  .in(
    "contract_id",
    contracts.map((contract) => contract.id),
  )
  .order("line_order");
if (contractUnitResult.error) throw contractUnitResult.error;
const unitResult = await supabase
  .from("units")
  .select("*")
  .in("id", [...new Set(contractUnitResult.data.map((row) => row.unit_id))]);
```

Then build `unitsByContract: Map<string, ContractUnitDetail[]>` and set `units: unitsByContract.get(contract.id) ?? []` on each item. Replace `unit`/`property` singulars; keep a `primaryUnit` getter returning `units[0]?.unit ?? null` so single-unit displays stay one line of change.

Rewrite `useUnitActiveContract` (`:178-195`) and `assertUnitAvailable` (`:197-209`) to query `contract_units` joined to contracts instead of `contracts.unit_id`:

```ts
const { data, error } = await supabase
  .from("contract_units")
  .select("contract_id, contracts!inner(id, state)")
  .eq("unit_id", unitId!)
  .in("contracts.state", nonTerminalStates)
  .limit(1)
  .maybeSingle();
```

In `src/lib/tenantLocations.ts`, change `ActiveContractCandidate.unit_id: string` to `unit_ids: string[]` and flatten in `dedupeById`'s callers. Update the comment on `dedupeById` — "two contracts really are two units" is no longer true; one contract can now be several units.

- [ ] **Step 6: Run the gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all pass. `typecheck` is the enumerator here — work through every error it reports in the 14 files listed under **Files** above.

- [ ] **Step 7: Commit**

```bash
git add src/
git commit -m "refactor(contracts): read units through contract_units"
```

---

## Task 8: Multi-unit contract form

**Files:**

- Create: `src/components/admin/ContractUnitsField.tsx`, `src/components/admin/ContractUnitsField.test.tsx`
- Modify: `src/routes/admin.contracts.tsx:157-192, 435-460, 960-1010`
- Modify: `db/migrations/110_multi_unit_contracts.sql` (append section 7)

**Interfaces:**

- Consumes: `aggregateUnitsForProperties`, `totalMonthlyAmount` from Task 7.
- Produces: `public.save_contract_with_units(p_contract jsonb, p_units jsonb, p_contract_id uuid default null) returns public.contracts`.

- [ ] **Step 1: Write the failing test**

Create `src/components/admin/ContractUnitsField.test.tsx`. Vitest here runs in the **node** environment with no jsdom, so test the pure mapping, not the DOM:

```ts
import { describe, expect, it } from "vitest";
import { syncUnitRows } from "./ContractUnitsField";

describe("syncUnitRows", () => {
  it("adds a rent row when a unit is selected", () => {
    const rows = syncUnitRows([], ["u1"]);
    expect(rows).toEqual([{ unit_id: "u1", monthly_amount: 0 }]);
  });

  it("keeps the amount already typed when another unit is added", () => {
    const rows = syncUnitRows([{ unit_id: "u1", monthly_amount: 400 }], ["u1", "u2"]);
    expect(rows).toEqual([
      { unit_id: "u1", monthly_amount: 400 },
      { unit_id: "u2", monthly_amount: 0 },
    ]);
  });

  it("drops the row and its amount when a unit is deselected", () => {
    const rows = syncUnitRows(
      [
        { unit_id: "u1", monthly_amount: 400 },
        { unit_id: "u2", monthly_amount: 350 },
      ],
      ["u2"],
    );
    expect(rows).toEqual([{ unit_id: "u2", monthly_amount: 350 }]);
  });

  it("orders rows by the selection order, which becomes line_order", () => {
    expect(syncUnitRows([], ["u3", "u1"]).map((r) => r.unit_id)).toEqual(["u3", "u1"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test ContractUnitsField`
Expected: FAIL with "Cannot find module './ContractUnitsField'".

- [ ] **Step 3: Write the component and its mapping**

Create `src/components/admin/ContractUnitsField.tsx` exporting `syncUnitRows` and the field component. `syncUnitRows` is the whole testable core:

```tsx
export interface ContractUnitValue {
  unit_id: string;
  monthly_amount: number;
}

/**
 * Rent rows for the currently selected units, preserving amounts already
 * typed. Selection order becomes line_order, which is the order rent lines
 * appear on the invoice.
 */
export function syncUnitRows(
  current: ContractUnitValue[],
  selectedUnitIds: string[],
): ContractUnitValue[] {
  const byId = new Map(current.map((row) => [row.unit_id, row]));
  return selectedUnitIds.map((unit_id) => byId.get(unit_id) ?? { unit_id, monthly_amount: 0 });
}
```

The component renders a multi-select of properties, a multi-select of units built with `aggregateUnitsForProperties`, and one titled `Monthly Amount` section per selected unit. Deselecting a property removes its units from `selectedUnitIds`, which `syncUnitRows` then drops.

- [ ] **Step 4: Rewrite the form schema**

In `src/routes/admin.contracts.tsx`, replace `property_id`/`unit_id`/`monthly_amount` in the schema (lines 157-174) with:

```ts
  property_ids: z.array(z.string().min(1)).min(1),
  units: z
    .array(z.object({ unit_id: z.string().min(1), monthly_amount: numberField(0) }))
    .min(1, "Select at least one unit"),
```

and the matching `defaults` (lines 176-192) with `property_ids: []`, `units: []`. Remove `monthly_amount` from both — it is trigger-maintained now. In `persistContract` (`:441`), strip `property_ids` instead of `property_id` and send `units` to the new RPC.

- [ ] **Step 5: Append section 7 to the migration**

```sql
-- ---------------------------------------------------------------------------
-- Section 7: atomic contract + units save.
-- One RPC so a contract can never exist with zero units, which the generator
-- would silently bill as nothing.
-- ---------------------------------------------------------------------------
create or replace function public.save_contract_with_units(
  p_contract jsonb,
  p_units jsonb,
  p_contract_id uuid default null
)
returns public.contracts
language plpgsql security definer set search_path = public
as $$
declare
  v_contract public.contracts;
  v_unit jsonb;
  v_line integer := 1;
begin
  if not public.has_permission(auth.uid(), 'contracts.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if jsonb_array_length(p_units) = 0 then
    raise exception 'A contract must have at least one unit';
  end if;

  if p_contract_id is null then
    -- Explicit column list, NOT `select * from jsonb_populate_record(...)`:
    -- that yields NULL for every key the payload omits, including `id` and
    -- `code`, overriding their defaults and failing the not-null constraint.
    insert into public.contracts
      (tenant_id, type, state, commercial_activity, start_date, end_date,
       duration_months, due_day, grace_days, deposit, notes)
    values (
      (p_contract->>'tenant_id')::uuid,
      coalesce((p_contract->>'type')::public.contract_types, 'investment'),
      coalesce((p_contract->>'state')::public.contract_states, 'draft'),
      p_contract->>'commercial_activity',
      (p_contract->>'start_date')::date,
      (p_contract->>'end_date')::date,
      (p_contract->>'duration_months')::integer,
      coalesce((p_contract->>'due_day')::integer, 1),
      coalesce((p_contract->>'grace_days')::integer, 0),
      coalesce((p_contract->>'deposit')::numeric, 0),
      p_contract->>'notes'
    )
    returning * into v_contract;
  else
    update public.contracts c set
      tenant_id = coalesce((p_contract->>'tenant_id')::uuid, c.tenant_id),
      type = coalesce((p_contract->>'type')::public.contract_types, c.type),
      state = coalesce((p_contract->>'state')::public.contract_states, c.state),
      commercial_activity = p_contract->>'commercial_activity',
      start_date = coalesce((p_contract->>'start_date')::date, c.start_date),
      end_date = coalesce((p_contract->>'end_date')::date, c.end_date),
      duration_months = (p_contract->>'duration_months')::integer,
      due_day = coalesce((p_contract->>'due_day')::integer, c.due_day),
      grace_days = coalesce((p_contract->>'grace_days')::integer, c.grace_days),
      deposit = coalesce((p_contract->>'deposit')::numeric, c.deposit),
      notes = p_contract->>'notes'
     where c.id = p_contract_id
     returning * into v_contract;
    if not found then raise exception 'Contract not found'; end if;
    delete from public.contract_units
     where contract_id = v_contract.id
       and unit_id not in (select (u->>'unit_id')::uuid from jsonb_array_elements(p_units) u);
  end if;

  for v_unit in select * from jsonb_array_elements(p_units) loop
    insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
    values (v_contract.id, (v_unit->>'unit_id')::uuid, (v_unit->>'monthly_amount')::numeric, v_line)
    on conflict (contract_id, unit_id)
      do update set monthly_amount = excluded.monthly_amount, line_order = excluded.line_order;
    v_line := v_line + 1;
  end loop;

  select * into v_contract from public.contracts where id = v_contract.id;
  return v_contract;
end;
$$;

revoke execute on function public.save_contract_with_units(jsonb, jsonb, uuid) from public, anon;
grant execute on function public.save_contract_with_units(jsonb, jsonb, uuid) to authenticated;
```

The `revoke ... from public, anon` matters: `anon` and `authenticated` hold their own grants, so revoking from `public` alone would leave this money-adjacent function callable by `anon`.

- [ ] **Step 6: Run the tests and gates**

Run: `bun run test:sql && bun run lint && bun run typecheck && bun run test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/ db/migrations/110_multi_unit_contracts.sql
git commit -m "feat(contracts): select several units and set each unit's rent"
```

---

## Task 9: Drop `contracts.unit_id`

**Files:**

- Modify: `db/migrations/110_multi_unit_contracts.sql` (append section 8)
- Modify: `src/integrations/supabase/database.types.ts`

**Interfaces:**

- Consumes: every preceding task.
- Produces: `contracts` without `unit_id`; `ContractRow` without `unit_id`.

- [ ] **Step 1: Write the failing test**

Append to `src/db/multiUnitContracts.sqltest.ts`:

```ts
describe("contracts.unit_id is gone", () => {
  it("no longer exists as a column", async () => {
    await withRollback(async (client: PoolClient) => {
      const column = await client.query(
        `select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'contracts' and column_name = 'unit_id'`,
      );
      expect(column.rowCount).toBe(0);
    });
  });

  it("is not referenced by any remaining function body", async () => {
    await withRollback(async (client: PoolClient) => {
      // Postgres does NOT track column references inside plpgsql bodies, so
      // `drop column` succeeded regardless. This is the only check there is.
      const offenders = await client.query(
        `select p.proname from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.prosrc ~ '\\mc\\.unit_id|v_contract\\.unit_id|contracts\\.unit_id'`,
      );
      expect(offenders.rows.map((r) => r.proname)).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:sql -- multiUnitContracts`
Expected: FAIL — the column still exists.

- [ ] **Step 3: Append section 8 to the migration**

```sql
-- ---------------------------------------------------------------------------
-- Section 8: drop the old column. LAST, after every SQL reader has moved.
--
-- This is NOT a safety net. PostgreSQL does not track column references inside
-- plpgsql function bodies, so this drop succeeds even if a function still names
-- contracts.unit_id -- and that function then fails at RUNTIME on a money path
-- with `record "v_contract" has no field "unit_id"`. There are no views over
-- contracts to catch it either. The SQL test suite is the only check.
-- ---------------------------------------------------------------------------
-- The legacy uniqueness index goes with the column it covers. Migration 110
-- RENAMED rather than dropped it (to one_active_contract_per_unit_legacy):
-- dropping it there removed the double-booking guard from every path still
-- writing contracts.unit_id directly, which bulkImportContracts.sqltest.ts
-- caught by letting a duplicate live-unit contract through. It is safe to drop
-- only here, because after this statement no such path exists.
drop index if exists public.one_active_contract_per_unit_legacy;
drop index if exists public.contracts_unit_id_idx;
alter table public.contracts drop column if exists unit_id;
```

Add a test asserting the legacy index is gone and the `contract_units` one remains:

```ts
it("keeps exactly one double-booking index, on contract_units", async () => {
  await withRollback(async (client: PoolClient) => {
    const indexes = await client.query(
      `select tablename, indexname from pg_indexes
          where indexname like 'one_active_contract_per_unit%' order by indexname`,
    );
    expect(indexes.rows).toEqual([
      { tablename: "contract_units", indexname: "one_active_contract_per_unit" },
    ]);
  });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:sql`
Expected: PASS — the whole suite, all 30+ files. Any function missed in Tasks 2-5 surfaces here.

- [ ] **Step 5: Remove the type**

In `src/integrations/supabase/database.types.ts`, delete `unit_id: string;` from `ContractRow` and remove `"unit_id"` from the `contracts` `TableDefinition` required-key union, leaving `"tenant_id" | "start_date" | "end_date"`.

- [ ] **Step 6: Run the gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/110_multi_unit_contracts.sql src/
git commit -m "feat(contracts)!: drop contracts.unit_id"
```

---

## Task 10: Apply to production and deploy

**Files:** none — this is an operational task.

**Interfaces:**

- Consumes: the completed `db/migrations/110_multi_unit_contracts.sql`.

**Order is mandatory.** Dokploy auto-deploys on push to `main` and migrations do **not** auto-apply. Reversed, the new code deploys against the old schema and every contract screen fails.

- [ ] **Step 1: Verify the migration builds a clean database from scratch**

Run: `bun run test:db && bun run test:sql`
Expected: PASS. This is the only place the backfill is exercised — production has zero contracts, so migration 11's seeded contracts are the sole coverage.

- [ ] **Step 2: Back up production**

```bash
docker exec danatfuture-supabase-ozoxsa-db-1 pg_dump -U supabase_admin -d postgres \
  > /root/danat-pre-110-$(date +%F).sql
grep -c "PostgreSQL database dump complete" /root/danat-pre-110-*.sql
```

Expected: `1`. Do not proceed without it.

- [ ] **Step 3: Apply migration 110 to the live database**

Transfer `db/migrations/110_multi_unit_contracts.sql` to the server (the MCP `exec` call caps around 1000 characters, so send it as chunked base64 and verify with `md5sum` before applying), then:

```bash
docker exec -i danatfuture-supabase-ozoxsa-db-1 \
  psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - < /root/110_multi_unit_contracts.sql
```

Expected: no `ERROR`, ending in `COMMIT` or a clean statement list.

- [ ] **Step 4: Reload the PostgREST schema cache**

```bash
docker exec danatfuture-supabase-ozoxsa-db-1 \
  psql -U supabase_admin -d postgres -Atc "notify pgrst, 'reload schema'"
```

Without this, PostgREST keeps the stale signature cache and `save_contract_with_units` 404s even though it exists.

- [ ] **Step 5: Verify the schema landed**

```bash
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres -Atc \
"select (select count(*) from information_schema.tables where table_name='contract_units')::text
     || ' ' || (select count(*) from information_schema.columns
                 where table_name='contracts' and column_name='unit_id')::text"
```

Expected: `1 0` — the table exists and the old column is gone.

- [ ] **Step 6: Push, open the PR and merge**

```bash
git push -u origin work/multi-unit-contracts
gh pr create --title "feat: multiple units under a single contract" --body "$(cat <<'BODY'
Promotes the unit from a column on `contracts` to a `contract_units` join table.
One contract can now hold several units across several properties, each with its
own rent, billed on a single consolidated invoice.

Spec: `docs/superpowers/specs/2026-08-07-multi-unit-contracts-design.md`
Plan: `docs/superpowers/plans/2026-08-07-multi-unit-contracts.md`

Migration 110 was applied to production before this PR, per the deploy order in
the spec.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

Wait for CodeRabbit, then `gh pr merge --merge --delete-branch`.

- [ ] **Step 7: Confirm the deploy**

After Dokploy rebuilds, check that the app container was recreated from the merge commit and that `https://danat-future.com` returns 200, then create a two-unit contract in the UI and generate its invoice.

---

## Task 11: Regeneration writes per-unit rent lines

Added 2026-08-07 after implementation review. The original plan cleared migrations
55/94/95/97 because they do not reference `unit_id`. That grep was accurate and
the conclusion was wrong: they read **`monthly_amount`** and write rent lines,
which is the same requirement under a different column name.

**Files:**

- Create: `db/migrations/116_regeneration_multi_unit.sql`
- Create: `src/db/multiUnitRegeneration.sqltest.ts`

**Interfaces:**

- Consumes: `public.contract_units` (Task 1); the per-unit rent-line loop shape from Task 3.
- Produces: re-issued `public.contract_period_amounts(...)` and `public.regenerate_contract_invoices(...)`.

- [ ] **Step 1: Write the failing test**

```ts
describe("regeneration keeps per-unit attribution", () => {
  it("rebuilds three rent lines, not one combined line", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });
      await client.query(`select * from public.generate_invoices_for_year($1, 2026, true)`, [
        fixture.contractId,
      ]);
      await client.query(`select * from public.regenerate_contract_invoices($1)`, [
        fixture.contractId,
      ]);

      const invoice = await client.query(
        `select id, total from public.invoices where contract_id = $1`,
        [fixture.contractId],
      );
      expect(invoice.rowCount).toBe(1);
      expect(Number(invoice.rows[0].total)).toBe(1200);

      const items = await client.query(
        `select unit_id, amount from public.invoice_items
          where invoice_id = $1 and is_concession = false order by line`,
        [invoice.rows[0].id],
      );
      // The defect this guards: regeneration collapsing three attributed lines
      // into one un-attributed line with the correct total. Nothing fails, and
      // per-property revenue reporting silently stops working.
      expect(items.rowCount).toBe(3);
      expect(items.rows.every((r) => r.unit_id !== null)).toBe(true);
      expect(items.rows.map((r) => Number(r.amount))).toEqual([400, 400, 400]);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:sql -- multiUnitRegeneration`
Expected: FAIL — one rent line with `unit_id` null, amount 1200.

- [ ] **Step 3: Re-issue both functions**

`contract_period_amounts` — live definition in `db/migrations/55_invoice_regeneration.sql`. Copy it and replace `v_subtotal := v_contract.monthly_amount;` (55:90) with the same sum used in Task 3:

```sql
  select coalesce(sum(cu.monthly_amount), 0) into v_subtotal
    from public.contract_units cu where cu.contract_id = v_contract.id;
```

`regenerate_contract_invoices` — live definition in `db/migrations/95_never_touch_paid_invoices_on_regenerate.sql` (it supersedes 82 and 94). Copy it and replace the single rent-line inserts at 95:100 and 95:127 with the per-unit loop from Task 3, ordered by `cu.line_order, cu.unit_id`, each row carrying its `unit_id`. Keep every other guard byte-identical — in particular 95's rule that paid invoices are never touched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:sql`
Expected: PASS, including `src/db/invoiceRegeneration.sqltest.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/116_regeneration_multi_unit.sql src/db/multiUnitRegeneration.sqltest.ts
git commit -m "feat(invoices): regeneration rebuilds one rent line per unit"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: schema → 1; double-booking → 1; occupancy → 2; invoice generation → 3; electricity + bulk import → 4; close-out → 5; portal RLS → 6; application readers → 7; contract form → 8; migration order → 1-9; deployment → 10. Payments are covered by _not_ changing them, which the spec justifies via nullable `payments.unit_id`.

**Placeholders.** None. Every code step carries real SQL or TypeScript. Tasks 3, 4 and 5 instruct the implementer to copy a named function body from a named migration and list the exact edits, rather than reproducing 200 lines of unchanged SQL — the file and the change are both named precisely.

**Type consistency.** `ContractUnitRow` (Task 1) is used in Task 7. `syncUnitRows` / `ContractUnitValue` (Task 8) match the `units` schema entry in the form. `save_contract_with_units(jsonb, jsonb, uuid)` has the same signature in Task 8's SQL, its grant, and Task 10's verification. `seedContract`'s new `units` option (Task 1) is used in Tasks 2, 3, 4, 5 and 6 with the same shape.

**Known risk carried forward.** Task 9's second test greps `pg_proc.prosrc`, which catches the three spellings used in this codebase (`c.unit_id`, `v_contract.unit_id`, `contracts.unit_id`) but is a text search, not a dependency check. It is a backstop for the SQL suite, not a replacement.
