# Admin Summary Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a row of KPI cards above the table on `/admin/payments`, `/admin/expenses`, `/admin/contracts`, `/admin/tenants` and `/admin/units`, each card carrying a money total and a record count, computed server-side from the page's active filters.

**Architecture:** Five `security definer` Postgres functions returning `jsonb`, one per module, each taking the same filter arguments as its list query — the pattern `get_budget_summary` and `get_deposit_total` already establish. Five thin `useQuery` hooks transcribe `useBudget.ts`. The existing `VibrantKpiCard` renders the tiles; no new visual component is designed.

**Tech Stack:** Postgres 17 (self-hosted Supabase), plpgsql, PostgREST RPC, React 19 + TanStack Start, TanStack Query, Tailwind CSS 4 + shadcn/ui, Vitest (`bun run test`) and the SQL integration suite (`bun run test:sql` / `bun run test:db`).

**Spec:** `docs/superpowers/specs/2026-08-03-admin-summary-cards-design.md`

## Global Constraints

- Branch is `feat/admin-summary-cards`, created off `main` at `ad654fa`. The repo
  is **Lovable-connected**: never force-push, rebase, amend or squash anything
  already pushed.
- **Another agent may be committing here concurrently.** Always `git add` by
  explicit path — never `git add -A` or `git add .`. The working tree carries a
  large volume of unrelated modified files (`graphify-out/`, several `docs/`
  files). Re-check the branch before every commit.
- **Re-check the migration number before creating the file:**
  `git fetch origin main && git ls-tree -r --name-only origin/main -- db/migrations | tail -3`.
  Verified free at plan time: `origin/main` ends at **78**, so this takes **79**.
  If 79 has been taken by the time you run, renumber consistently across the
  migration, the sqltest and Task 7 rather than reusing it.
- **No CTE before `select ... into`.** All ~12 existing `into v_` sites in
  `db/migrations/` use a plain select or `from (subquery) f`; follow that form.
- **Never edit an already-applied migration in place.** An in-place edit passes
  `bun run test:db` and changes nothing on the live database. All new SQL goes in
  `db/migrations/79_module_summary_rpcs.sql`.
- Migration 79 must be idempotent — `create or replace function` throughout. It
  creates no tables, no types and no triggers, so it is safe to re-run.
- Every function is `stable security definer set search_path = public, auth, pg_temp`,
  opens with the `has_permission` guard, and ends with
  `revoke all ... from public, anon` then `grant execute ... to authenticated, service_role`.
- **`src/integrations/supabase/database.types.ts` is hand-maintained** despite
  looking generated. Do **not** run `bun run gen:types` over it. Add the five
  function entries by hand.
- Any new i18n key goes in **both** the `ar` and `en` blocks of
  `src/i18n/dictionary.ts`. `src/i18n/dictionary.test.ts` fails `bun run test` on
  a one-locale key — **and it checks by truthiness, so an empty-string value also
  fails parity.** Use double-quoted literals in `t("...")`; the scanner regex only
  sees double quotes.
- Money is KWD, **3 decimals**, everywhere.
- Gates before the PR: `bun run lint`, `bun run typecheck`, `bun run test`,
  `bun run test:db`, `bun run test:sql`. The last two need Docker.
- **Do not apply anything to production until Task 7.** Dokploy auto-deploys on
  push to `main`, so the schema change must land on the live database _before_ the
  frontend that calls it.

## File structure

| File                                                                 | Responsibility                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| `db/migrations/79_module_summary_rpcs.sql`                           | the five aggregate functions + grants                       |
| `src/db/moduleSummaries.sqltest.ts`                                  | integration tests for all five                              |
| `src/lib/json.ts`                                                    | `numberValue` — shared `Json` → `number` coercion           |
| `src/lib/money.ts`                                                   | `formatKwd(value, locale)`                                  |
| `src/components/admin/SummaryCards.tsx`                              | grid + skeleton + silent-failure wrapper                    |
| `src/hooks/use{Payments,Expenses,Contracts,Tenants,Units}Summary.ts` | one hook each                                               |
| five `src/routes/admin.*.tsx`                                        | one import block, one hook call, one `<SummaryCards>` block |
| `src/i18n/dictionary.ts`                                             | `summary.*` keys, both locales                              |
| `src/integrations/supabase/database.types.ts`                        | five `Functions` entries                                    |

---

### Task 1: Migration 79 — payments and expenses summaries

**Files:**

- Create: `db/migrations/79_module_summary_rpcs.sql`
- Create: `src/db/moduleSummaries.sqltest.ts`

**Interfaces:**

- Consumes: `withRollback`, `actAs`, `actAsSuperuser`, `closePool`, `seedContract` from `@/db/testDb`; `public.has_permission(uuid, text)` from migration 03.
- Produces:
  - `public.get_payments_summary(p_search text, p_method text, p_status text, p_tenant_id uuid) returns jsonb`
  - `public.get_expenses_summary(p_search text, p_class text, p_category_id uuid, p_property_id uuid, p_status text, p_from date, p_to date) returns jsonb`
  - Task 2 appends to the same migration file. Task 4 consumes both shapes.

- [ ] **Step 1: Write the failing test file**

Create `src/db/moduleSummaries.sqltest.ts`:

```typescript
import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { actAs, actAsSuperuser, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 79 — per-module summary RPCs behind the admin list-page KPI cards.
 *
 * These are `security definer`, so RLS does not apply and the `has_permission`
 * guard is the entire access control. The grant tests below are therefore load
 * bearing, not decorative: `revoke ... from public` does NOT reach `anon`, which
 * holds its own grant from Supabase's default privileges.
 */

async function summary(
  client: PoolClient,
  fn: string,
  args: string,
): Promise<Record<string, unknown>> {
  const { rows } = await client.query<{ result: Record<string, unknown> }>(
    `select public.${fn}(${args}) as result`,
  );
  return rows[0].result;
}

describe("get_payments_summary", () => {
  test("counts only confirmed, non-reversed payments", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      await client.query(
        `insert into public.payments (code, tenant_id, unit_id, amount, currency, method, status, payment_date)
         values ('PAY-A', $1, $2, 100.000, 'KWD', 'cash', 'confirmed', '2026-02-01'),
                ('PAY-B', $1, $2, 50.000, 'KWD', 'cash', 'pending', '2026-02-02')`,
        [fixture.tenantId, fixture.unitId],
      );

      const result = await summary(client, "get_payments_summary", "null, null, null, null");
      const full = result.full as { total: number; count: number };

      expect(Number(full.total)).toBe(100);
      expect(Number(full.count)).toBe(1);
    });
  });

  test("net excludes insurance but subtracts refunds", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      await client.query(
        `insert into public.payments (code, tenant_id, unit_id, amount, currency, method, status, payment_date)
         values ('PAY-C', $1, $2, 300.000, 'KWD', 'cash', 'confirmed', '2026-03-01')`,
        [fixture.tenantId, fixture.unitId],
      );
      await client.query(
        `insert into public.insurance_payments (tenant_id, contract_id, amount, currency, collected_date)
         values ($1, $2, 500.000, 'KWD', '2026-03-01')`,
        [fixture.tenantId, fixture.contractId],
      );
      await client.query(
        `insert into public.refunds (tenant_id, contract_id, amount, currency, refund_date, post_action)
         values ($1, $2, 20.000, 'KWD', '2026-03-05', 'store')`,
        [fixture.tenantId, fixture.contractId],
      );

      const result = await summary(client, "get_payments_summary", "null, null, null, null");

      expect(Number((result.insurance as { total: number }).total)).toBe(500);
      expect(Number(result.net)).toBe(280); // 300 - 20; insurance is a holding
    });
  });
});

describe("get_expenses_summary", () => {
  test("splits approved from pending and honours the property filter", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      await client.query(
        `insert into public.expenses (code, amount, currency, class, status, expense_date, property_id)
         values ('EXP-A', 70.000, 'KWD', 'sudden_one_time', 'approved', '2026-02-01', $1),
                ('EXP-B', 30.000, 'KWD', 'sudden_one_time', 'pending', '2026-02-02', $1)`,
        [fixture.propertyId],
      );

      const all = await summary(
        client,
        "get_expenses_summary",
        "null, null, null, null, null, null, null",
      );
      expect(Number((all.total as { amount: number }).amount)).toBe(100);
      expect(Number((all.approved as { amount: number }).amount)).toBe(70);
      expect(Number((all.pending as { amount: number }).amount)).toBe(30);

      const filtered = await client.query<{ result: { total: { amount: string } } }>(
        `select public.get_expenses_summary(null, null, null, $1, null, null, null) as result`,
        ["00000000-0000-0000-0000-000000000000"],
      );
      expect(Number(filtered.rows[0].result.total.amount)).toBe(0);
    });
  });
});

describe("grants", () => {
  test.each([
    ["get_payments_summary(text,text,text,uuid)"],
    ["get_expenses_summary(text,text,uuid,uuid,text,date,date)"],
  ])("anon cannot execute %s", async (signature) => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const { rows } = await client.query<{ allowed: boolean }>(
        `select has_function_privilege('anon', 'public.${signature}', 'execute') as allowed`,
      );
      expect(rows[0].allowed).toBe(false);
    });
  });
});

describe("permission guard", () => {
  /**
   * These functions are `security definer`, so RLS does not apply and this
   * guard IS the access control. An authenticated user without the module's
   * read permission must be refused, not served a zeroed summary.
   */
  test("an authenticated user without payments.read is refused", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const { rows } = await client.query<{ id: string }>(
        `insert into auth.users (id, email) values (gen_random_uuid(), 'nobody@example.test')
         returning id`,
      );
      const userId = rows[0].id;
      // No role assignment, so has_permission() returns false for every code.
      await actAs(client, userId);

      await expect(
        client.query(`select public.get_payments_summary(null, null, null, null)`),
      ).rejects.toThrow(/Permission denied/);
    });
  });

  test("an authenticated user without expenses.read is refused", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const { rows } = await client.query<{ id: string }>(
        `insert into auth.users (id, email) values (gen_random_uuid(), 'nobody2@example.test')
         returning id`,
      );
      await actAs(client, rows[0].id);

      await expect(
        client.query(
          `select public.get_expenses_summary(null, null, null, null, null, null, null)`,
        ),
      ).rejects.toThrow(/Permission denied/);
    });
  });
});
```

> **Before writing these two guard tests, read `src/db/rls.sqltest.ts`** for the
> exact `actAs` calling convention in this repo. The test image reads
> `request.jwt.claim.sub`, not the JSON claims object — setting the wrong GUC
> makes `auth.uid()` return null, `auth.role()` return something other than
> `authenticated`, and the guard is skipped entirely, so the test passes
> vacuously while proving nothing.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:db && bun run test:sql -- moduleSummaries`
Expected: FAIL — `function public.get_payments_summary(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `db/migrations/79_module_summary_rpcs.sql`:

```sql
-- 79 — per-module summary RPCs for the admin list-page KPI cards.
--
-- One function per module, each taking the SAME filter arguments as its list
-- query so the cards agree with the table beneath them. Follows the shape of
-- get_budget_summary / get_deposit_total in migration 08.
--
-- These are `security definer`, so RLS does not apply and the has_permission
-- guard IS the access control. Note the revoke names `anon` explicitly: the
-- older migrations only `revoke ... from public`, which does not reach anon —
-- Supabase grants it directly through default privileges.

------------------------------------------------------------
-- Payments
------------------------------------------------------------

create or replace function public.get_payments_summary(
  p_search text default null,
  p_method text default null,
  p_status text default null,
  p_tenant_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_full_total numeric(14,3); v_full_count bigint;
  v_partial_total numeric(14,3); v_partial_count bigint;
  v_insurance_total numeric(14,3); v_insurance_count bigint;
  v_refund_total numeric(14,3); v_refund_count bigint;
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'payments.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  -- Same predicate get_budget_summary uses for `collections`, so this card and
  -- the budget report cannot disagree.
  select coalesce(sum(p.amount), 0), count(*)
    into v_full_total, v_full_count
  from public.payments p
  where p.status = 'confirmed'
    and p.reversed_by_payment_id is null
    and (p_method is null or p.method::text = p_method)
    and (p_status is null or p.status::text = p_status)
    and (p_tenant_id is null or p.tenant_id = p_tenant_id)
    and (p_search is null or p.code ilike '%' || p_search || '%'
      or coalesce(p.reference, '') ilike '%' || p_search || '%'
      or exists (
        select 1 from public.tenants t
        where t.id = p.tenant_id
          and (t.code ilike '%' || p_search || '%' or t.name ilike '%' || p_search || '%')
      ));

  -- partial_payments / insurance_payments / refunds are plain ledgers: no code
  -- and no status column, so only p_tenant_id is expressible against them.
  select coalesce(sum(x.amount), 0), count(*) into v_partial_total, v_partial_count
  from public.partial_payments x
  where (p_tenant_id is null or x.tenant_id = p_tenant_id);

  select coalesce(sum(x.amount), 0), count(*) into v_insurance_total, v_insurance_count
  from public.insurance_payments x
  where (p_tenant_id is null or x.tenant_id = p_tenant_id);

  select coalesce(sum(x.amount), 0), count(*) into v_refund_total, v_refund_count
  from public.refunds x
  where (p_tenant_id is null or x.tenant_id = p_tenant_id);

  return jsonb_build_object(
    'full',      jsonb_build_object('total', v_full_total,      'count', v_full_count),
    'partial',   jsonb_build_object('total', v_partial_total,   'count', v_partial_count),
    'insurance', jsonb_build_object('total', v_insurance_total, 'count', v_insurance_count),
    'refunds',   jsonb_build_object('total', v_refund_total,    'count', v_refund_count),
    -- Insurance is a holding, not income — it does not move net. Same rule as
    -- BudgetSummary (src/hooks/useBudget.ts).
    'net', v_full_total + v_partial_total - v_refund_total
  );
end;
$$;

revoke all on function public.get_payments_summary(text, text, text, uuid) from public, anon;
grant execute on function public.get_payments_summary(text, text, text, uuid)
  to authenticated, service_role;

------------------------------------------------------------
-- Expenses
------------------------------------------------------------

create or replace function public.get_expenses_summary(
  p_search text default null,
  p_class text default null,
  p_category_id uuid default null,
  p_property_id uuid default null,
  p_status text default null,
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_total numeric(14,3); v_count bigint;
  v_approved numeric(14,3); v_approved_count bigint;
  v_pending numeric(14,3); v_pending_count bigint;
  v_month numeric(14,3); v_month_count bigint;
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'expenses.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  -- Predicates mirror fetchExpenses() in src/hooks/useExpenses.ts exactly.
  -- Note the inline subquery rather than a CTE: every `select ... into` in
  -- db/migrations/ uses this form (see get_budget_summary in migration 08).
  select
    coalesce(sum(f.amount), 0), count(*),
    coalesce(sum(f.amount) filter (where f.status = 'approved'), 0),
    count(*) filter (where f.status = 'approved'),
    coalesce(sum(f.amount) filter (where f.status = 'pending'), 0),
    count(*) filter (where f.status = 'pending')
  into v_total, v_count, v_approved, v_approved_count, v_pending, v_pending_count
  from (
    select e.*
    from public.expenses e
    where (p_class is null or e.class::text = p_class)
      and (p_category_id is null or e.category_id = p_category_id)
      and (p_property_id is null or e.property_id = p_property_id)
      and (p_status is null or e.status::text = p_status)
      and (p_from is null or e.expense_date >= p_from)
      and (p_to is null or e.expense_date <= p_to)
      and (p_search is null or e.code ilike '%' || p_search || '%'
        or coalesce(e.payee, '') ilike '%' || p_search || '%'
        or coalesce(e.cost_center, '') ilike '%' || p_search || '%'
        or coalesce(e.note, '') ilike '%' || p_search || '%')
  ) f;

  -- `this month` deliberately ignores p_from/p_to — it is an absolute reference
  -- point, not a slice of the current filter.
  select coalesce(sum(e.amount), 0), count(*)
    into v_month, v_month_count
  from public.expenses e
  where e.expense_date >= date_trunc('month', current_date)::date
    and e.expense_date < (date_trunc('month', current_date) + interval '1 month')::date;

  return jsonb_build_object(
    'total',      jsonb_build_object('amount', v_total,    'count', v_count),
    'approved',   jsonb_build_object('amount', v_approved, 'count', v_approved_count),
    'pending',    jsonb_build_object('amount', v_pending,  'count', v_pending_count),
    'this_month', jsonb_build_object('amount', v_month,    'count', v_month_count)
  );
end;
$$;

revoke all on function public.get_expenses_summary(text, text, uuid, uuid, text, date, date)
  from public, anon;
grant execute on function public.get_expenses_summary(text, text, uuid, uuid, text, date, date)
  to authenticated, service_role;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:db && bun run test:sql -- moduleSummaries`
Expected: PASS — all five tests green.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/79_module_summary_rpcs.sql src/db/moduleSummaries.sqltest.ts
git commit -m "feat(db): add payments and expenses summary RPCs for admin KPI cards"
```

---

### Task 2: Migration 79 — contracts, tenants and units summaries

Appends to the same migration file. Uses no helper from Task 1 — each function is
self-contained — but relies on that file existing.

**Files:**

- Modify: `db/migrations/79_module_summary_rpcs.sql` (append)
- Modify: `src/db/moduleSummaries.sqltest.ts` (append)

**Interfaces:**

- Consumes: `public.has_permission(uuid, text)`; the migration file created in Task 1.
- Produces:
  - `public.get_contracts_summary(p_search text, p_state text, p_tenant_id uuid) returns jsonb`
  - `public.get_tenants_summary(p_search text, p_category text, p_lifecycle text) returns jsonb`
  - `public.get_units_summary(p_search text, p_property_id uuid, p_building_id uuid, p_status text, p_type text, p_meter text) returns jsonb`

- [ ] **Step 1: Write the failing tests**

Append to `src/db/moduleSummaries.sqltest.ts`:

```typescript
describe("get_contracts_summary", () => {
  test("counts active contracts and flags those ending within 60 days", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      // Ends inside the 60-day window relative to whatever `current_date` is.
      await seedContract(client, {
        startDate: "2026-01-01",
        endDate: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
        state: "active",
      });

      const result = await summary(client, "get_contracts_summary", "null, null, null");

      expect(Number(result.active)).toBeGreaterThanOrEqual(1);
      expect(Number(result.expiring_60d)).toBeGreaterThanOrEqual(1);
      // annual = monthly * 12, over active contracts only
      expect(Number(result.annual_amount)).toBe(Number(result.monthly_amount) * 12);
    });
  });

  test("excludes archived contracts", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
      });

      const before = await summary(client, "get_contracts_summary", "null, null, null");
      await client.query(`update public.contracts set archived_at = now() where id = $1`, [
        fixture.contractId,
      ]);
      const after = await summary(client, "get_contracts_summary", "null, null, null");

      expect(Number(after.total)).toBe(Number(before.total) - 1);
    });
  });
});

describe("get_tenants_summary", () => {
  test("sums overdue invoice balances into arrears", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      await client.query(
        `insert into public.invoices
           (code, tenant_id, contract_id, unit_id, period_start, period_end,
            due_date, total, balance, state, currency)
         values ('INV-OD', $1, $2, $3, '2026-02-01', '2026-02-28',
                 '2026-02-05', 250.000, 250.000, 'overdue', 'KWD')`,
        [fixture.tenantId, fixture.contractId, fixture.unitId],
      );

      const result = await summary(client, "get_tenants_summary", "null, null, null");
      const arrears = result.arrears as { amount: number; tenants: number };

      expect(Number(arrears.amount)).toBeGreaterThanOrEqual(250);
      expect(Number(arrears.tenants)).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("get_units_summary", () => {
  test("occupied reflects the trigger-derived status, and totals partition", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      // seedContract inserts the unit first, so migration 76's trigger flips it
      // to `occupied` when the active contract lands.
      await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
      });

      const result = await summary(
        client,
        "get_units_summary",
        "null, null, null, null, null, null",
      );

      expect(Number(result.occupied)).toBeGreaterThanOrEqual(1);
      expect(Number(result.total)).toBeGreaterThanOrEqual(
        Number(result.occupied) + Number(result.vacant) + Number(result.under_maintenance),
      );
    });
  });
});

describe("grants — task 2 functions", () => {
  test.each([
    ["get_contracts_summary(text,text,uuid)"],
    ["get_tenants_summary(text,text,text)"],
    ["get_units_summary(text,uuid,uuid,text,text,text)"],
  ])("anon cannot execute %s", async (signature) => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const { rows } = await client.query<{ allowed: boolean }>(
        `select has_function_privilege('anon', 'public.${signature}', 'execute') as allowed`,
      );
      expect(rows[0].allowed).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test:db && bun run test:sql -- moduleSummaries`
Expected: FAIL — `function public.get_contracts_summary(...) does not exist`.

- [ ] **Step 3: Append the three functions to the migration**

Append to `db/migrations/79_module_summary_rpcs.sql`:

```sql
------------------------------------------------------------
-- Contracts
------------------------------------------------------------

create or replace function public.get_contracts_summary(
  p_search text default null,
  p_state text default null,
  p_tenant_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_total bigint; v_active bigint; v_expiring bigint; v_ended bigint;
  v_next_expiry date; v_monthly numeric(14,3);
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'contracts.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select
    count(*),
    count(*) filter (where f.state = 'active'),
    -- There is no `expiring` state. Migration 76: nothing in this codebase
    -- transitions a contract to `expired`, so the window is computed from
    -- end_date over live contracts.
    count(*) filter (
      where f.state = 'active'
        and f.end_date between current_date and current_date + 60
    ),
    count(*) filter (where f.state in ('expired', 'terminated')),
    min(f.end_date) filter (
      where f.state = 'active' and f.end_date >= current_date
    ),
    coalesce(sum(f.monthly_amount) filter (where f.state = 'active'), 0)
  into v_total, v_active, v_expiring, v_ended, v_next_expiry, v_monthly
  from (
    select c.*
    from public.contracts c
    where c.archived_at is null                      -- matches useContracts
      and (p_state is null or c.state::text = p_state)
      and (p_tenant_id is null or c.tenant_id = p_tenant_id)
      and (p_search is null or c.code ilike '%' || p_search || '%')
  ) f;

  return jsonb_build_object(
    'total', v_total,
    'active', v_active,
    'expiring_60d', v_expiring,
    'ended', v_ended,
    'next_expiry', v_next_expiry,
    'monthly_amount', v_monthly,
    'annual_amount', v_monthly * 12
  );
end;
$$;

revoke all on function public.get_contracts_summary(text, text, uuid) from public, anon;
grant execute on function public.get_contracts_summary(text, text, uuid)
  to authenticated, service_role;

------------------------------------------------------------
-- Tenants
------------------------------------------------------------

create or replace function public.get_tenants_summary(
  p_search text default null,
  p_category text default null,
  p_lifecycle text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_total bigint; v_active bigint; v_blocked bigint;
  v_arrears numeric(14,3); v_arrears_tenants bigint;
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'tenants.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  -- Two statements rather than one: joining `invoices` into the same select
  -- would multiply the tenant rows and corrupt the count(*) aggregates.
  select
    count(*),
    count(*) filter (where t.lifecycle = 'active'),
    count(*) filter (where t.lifecycle in ('blocked', 'inactive'))
  into v_total, v_active, v_blocked
  from public.tenants t
  where t.archived_at is null                        -- matches useTenants
    and (p_category is null or t.category::text = p_category)
    and (p_lifecycle is null or t.lifecycle::text = p_lifecycle)
    and (p_search is null or t.code ilike '%' || p_search || '%'
      or t.name ilike '%' || p_search || '%'
      or coalesce(t.mobile, '') ilike '%' || p_search || '%'
      or coalesce(t.email, '') ilike '%' || p_search || '%');

  select coalesce(sum(i.balance), 0), count(distinct i.tenant_id)
  into v_arrears, v_arrears_tenants
  from public.invoices i
  join public.tenants t on t.id = i.tenant_id
  where i.state = 'overdue' and i.balance > 0
    and t.archived_at is null
    and (p_category is null or t.category::text = p_category)
    and (p_lifecycle is null or t.lifecycle::text = p_lifecycle)
    and (p_search is null or t.code ilike '%' || p_search || '%'
      or t.name ilike '%' || p_search || '%'
      or coalesce(t.mobile, '') ilike '%' || p_search || '%'
      or coalesce(t.email, '') ilike '%' || p_search || '%');

  return jsonb_build_object(
    'total', v_total,
    'active', v_active,
    'blocked_inactive', v_blocked,
    'arrears', jsonb_build_object('amount', v_arrears, 'tenants', v_arrears_tenants)
  );
end;
$$;

revoke all on function public.get_tenants_summary(text, text, text) from public, anon;
grant execute on function public.get_tenants_summary(text, text, text)
  to authenticated, service_role;

------------------------------------------------------------
-- Units
------------------------------------------------------------

create or replace function public.get_units_summary(
  p_search text default null,
  p_property_id uuid default null,
  p_building_id uuid default null,
  p_status text default null,
  p_type text default null,
  p_meter text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_total bigint; v_occupied bigint; v_vacant bigint; v_maintenance bigint;
  v_rent numeric(14,3);
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'units.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select
    count(*),
    -- `occupied` is trigger-derived from an active contract (migration 76) and
    -- cannot be written by the app, so reading the column is authoritative.
    count(*) filter (where u.status = 'occupied'),
    count(*) filter (where u.status = 'vacant'),
    count(*) filter (where u.status = 'under_maintenance'),
    coalesce(sum(coalesce(u.default_rent, 0)), 0)
  into v_total, v_occupied, v_vacant, v_maintenance, v_rent
  from public.units u
  where (p_property_id is null or u.property_id = p_property_id)
    and (p_building_id is null or u.building_id = p_building_id)
    and (p_status is null or u.status::text = p_status)
    and (p_type is null or u.type::text = p_type)
    and (p_meter is null or u.electricity_meter_ownership::text = p_meter)
    and (p_search is null or u.code ilike '%' || p_search || '%'
      or u.name ilike '%' || p_search || '%');

  return jsonb_build_object(
    'total', v_total,
    'occupied', v_occupied,
    'vacant', v_vacant,
    'under_maintenance', v_maintenance,
    'rent_potential', v_rent
  );
end;
$$;

revoke all on function public.get_units_summary(text, uuid, uuid, text, text, text)
  from public, anon;
grant execute on function public.get_units_summary(text, uuid, uuid, text, text, text)
  to authenticated, service_role;
```

> **Why `get_tenants_summary` uses two scalar sub-selects rather than a join:**
> joining `invoices` to `filtered` would multiply the tenant rows and break the
> `count(*)` aggregates in the same `select`. The sub-selects keep the tenant
> counts and the arrears figures independent of each other.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:db && bun run test:sql -- moduleSummaries`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/79_module_summary_rpcs.sql src/db/moduleSummaries.sqltest.ts
git commit -m "feat(db): add contracts, tenants and units summary RPCs"
```

---

### Task 3: Shared frontend scaffolding

Everything the five pages need in common, in one reviewable unit: the coercion
helper, the money formatter, the card grid, the type entries and the i18n keys.

**Files:**

- Create: `src/lib/json.ts`, `src/lib/money.ts`, `src/components/admin/SummaryCards.tsx`
- Create: `src/lib/money.test.ts`
- Modify: `src/integrations/supabase/database.types.ts`, `src/i18n/dictionary.ts`, `src/hooks/useBudget.ts`

**Interfaces:**

- Consumes: `VibrantKpiCard` from `@/components/shared/dashboardCards`; `Json` from `@/integrations/supabase/database.types`.
- Produces:
  - `numberValue(value: Json | undefined): number` from `@/lib/json`
  - `formatKwd(value: number, locale: string): string` from `@/lib/money`
  - `<SummaryCards loading error>{children}</SummaryCards>` from `@/components/admin/SummaryCards`
  - the five `Functions` entries every hook in Tasks 4–5 types against

- [ ] **Step 1: Write the failing test**

Create `src/lib/money.test.ts`:

```typescript
import { describe, expect, test } from "vitest";

import { formatKwd } from "@/lib/money";

describe("formatKwd", () => {
  test("renders KWD with exactly three decimals", () => {
    expect(formatKwd(1240, "en")).toBe("1,240.000 KWD");
  });

  test("keeps three decimals on a fractional amount", () => {
    expect(formatKwd(0.5, "en")).toBe("0.500 KWD");
  });

  test("uses Arabic-locale grouping without changing the decimal count", () => {
    const result = formatKwd(1240, "ar");
    expect(result).toContain("KWD");
    expect(result).not.toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- money`
Expected: FAIL — cannot resolve `@/lib/money`.

- [ ] **Step 3: Write the three modules**

Create `src/lib/json.ts`:

```typescript
import type { Json } from "@/integrations/supabase/database.types";

/**
 * PostgREST returns numeric aggregates as strings inside a jsonb payload.
 * Every summary hook funnels through this rather than trusting `as number`.
 */
export function numberValue(value: Json | undefined): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}
```

Create `src/lib/money.ts`:

```typescript
/**
 * KWD is a 3-decimal currency. Until now this formatter was re-declared inline
 * in ~14 files; new code uses this helper. Migrating the existing call sites is
 * deliberately out of scope.
 */
export function formatKwd(value: number, locale: string): string {
  const formatter = new Intl.NumberFormat(locale === "ar" ? "ar-KW" : "en-KW", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
  return `${formatter.format(value)} KWD`;
}
```

Create `src/components/admin/SummaryCards.tsx`:

```tsx
import type { ReactNode } from "react";

/**
 * Grid wrapper for the list-page KPI rows.
 *
 * Fails SILENTLY: a broken aggregate must never blank the table beneath it.
 * The table is the product; the cards are a garnish.
 */
export function SummaryCards({
  loading,
  error,
  children,
}: {
  loading: boolean;
  error: unknown;
  children: ReactNode;
}) {
  if (error) {
    console.error("Summary cards failed to load", error);
    return null;
  }

  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="h-[148px] animate-pulse rounded-2xl bg-muted"
            aria-hidden="true"
          />
        ))}
      </div>
    );
  }

  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">{children}</div>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- money`
Expected: PASS — 3 tests.

- [ ] **Step 5: Add the five entries to `database.types.ts`**

In the `Functions` block, alongside the existing `get_budget_summary` and
`get_deposit_total` entries, add — matching their `Args` / `Returns: Json` shape:

```typescript
get_payments_summary: {
  Args: {
    p_search?: string | null;
    p_method?: string | null;
    p_status?: string | null;
    p_tenant_id?: string | null;
  };
  Returns: Json;
};
get_expenses_summary: {
  Args: {
    p_search?: string | null;
    p_class?: string | null;
    p_category_id?: string | null;
    p_property_id?: string | null;
    p_status?: string | null;
    p_from?: string | null;
    p_to?: string | null;
  };
  Returns: Json;
};
get_contracts_summary: {
  Args: { p_search?: string | null; p_state?: string | null; p_tenant_id?: string | null };
  Returns: Json;
};
get_tenants_summary: {
  Args: { p_search?: string | null; p_category?: string | null; p_lifecycle?: string | null };
  Returns: Json;
};
get_units_summary: {
  Args: {
    p_search?: string | null;
    p_property_id?: string | null;
    p_building_id?: string | null;
    p_status?: string | null;
    p_type?: string | null;
    p_meter?: string | null;
  };
  Returns: Json;
};
```

Do **not** run `bun run gen:types` — that writes a reference file and this one is
hand-maintained.

`useBudget.ts` keeps its own local `numberValue`. Deduplicating it is a one-line
change to a money-path hook backing `/admin/reports` and is **not** in this
change's scope — listed under _Out of scope_ in the spec.

- [ ] **Step 6: Add the i18n keys to both locales**

In `src/i18n/dictionary.ts`, add to the **`ar`** block:

```typescript
"summary.records": "سجل",
"summary.payments.full": "المدفوعات الكاملة",
"summary.payments.partial": "المدفوعات الجزئية",
"summary.payments.insurance": "التأمين المحتجز",
"summary.payments.refunds": "المبالغ المستردة",
"summary.payments.net": "صافي التحصيل",
"summary.expenses.total": "إجمالي المصروفات",
"summary.expenses.approved": "المعتمدة",
"summary.expenses.pending": "قيد الاعتماد",
"summary.expenses.thisMonth": "هذا الشهر",
"summary.contracts.total": "إجمالي العقود",
"summary.contracts.active": "العقود النشطة",
"summary.contracts.expiring60": "تنتهي خلال ٦٠ يوماً",
"summary.contracts.ended": "منتهية أو ملغاة",
"summary.contracts.annualValue": "القيمة السنوية",
"summary.contracts.monthlyHint": "شهرياً",
"summary.tenants.total": "إجمالي المستأجرين",
"summary.tenants.active": "النشطون",
"summary.tenants.arrears": "المتأخرات",
"summary.tenants.arrearsHint": "مستأجر",
"summary.tenants.blocked": "محظور أو غير نشط",
"summary.units.total": "إجمالي الوحدات",
"summary.units.occupied": "مشغولة",
"summary.units.vacant": "شاغرة",
"summary.units.maintenance": "تحت الصيانة",
"summary.units.rentPotential": "الإيراد الشهري المتوقع",
```

And the identical keys to the **`en`** block:

```typescript
"summary.records": "records",
"summary.payments.full": "Full payments",
"summary.payments.partial": "Partial payments",
"summary.payments.insurance": "Insurance held",
"summary.payments.refunds": "Refunds",
"summary.payments.net": "Net collected",
"summary.expenses.total": "Total expenses",
"summary.expenses.approved": "Approved",
"summary.expenses.pending": "Pending",
"summary.expenses.thisMonth": "This month",
"summary.contracts.total": "Total contracts",
"summary.contracts.active": "Active",
"summary.contracts.expiring60": "Expiring in 60 days",
"summary.contracts.ended": "Expired or terminated",
"summary.contracts.annualValue": "Annual rent value",
"summary.contracts.monthlyHint": "per month",
"summary.tenants.total": "Total tenants",
"summary.tenants.active": "Active",
"summary.tenants.arrears": "In arrears",
"summary.tenants.arrearsHint": "tenants",
"summary.tenants.blocked": "Blocked or inactive",
"summary.units.total": "Total units",
"summary.units.occupied": "Occupied",
"summary.units.vacant": "Vacant",
"summary.units.maintenance": "Under maintenance",
"summary.units.rentPotential": "Monthly rent potential",
```

No value may be an empty string — the parity test checks by truthiness, so `""`
fails as if the key were missing.

- [ ] **Step 7: Run the full suite**

Run: `bun run typecheck && bun run test`
Expected: PASS, including `src/i18n/dictionary.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/json.ts src/lib/money.ts src/lib/money.test.ts \
        src/components/admin/SummaryCards.tsx \
        src/integrations/supabase/database.types.ts src/i18n/dictionary.ts
git commit -m "feat(admin): add shared summary-card scaffolding, money helper and i18n keys"
```

---

### Task 4: Payments and Expenses cards

**Files:**

- Create: `src/hooks/usePaymentsSummary.ts`, `src/hooks/useExpensesSummary.ts`
- Modify: `src/routes/admin.payments.tsx`, `src/routes/admin.expenses.tsx`

**Interfaces:**

- Consumes: `numberValue` from `@/lib/json`, `formatKwd` from `@/lib/money`, `SummaryCards` from `@/components/admin/SummaryCards`, `VibrantKpiCard` from `@/components/shared/dashboardCards`, `PERMISSIONS` from `@/lib/permissions`.
- Produces:
  - `usePaymentsSummary(params, enabled?)` → `{ full, partial, insurance, refunds, net }` where each of the first four is `{ total: number; count: number }`
  - `useExpensesSummary(params, enabled?)` → `{ total, approved, pending, thisMonth }`, each `{ amount: number; count: number }`

- [ ] **Step 1: Write `usePaymentsSummary`**

Create `src/hooks/usePaymentsSummary.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/database.types";
import { numberValue } from "@/lib/json";

export interface MoneyBucket {
  count: number;
  total: number;
}
export interface PaymentsSummary {
  full: MoneyBucket;
  insurance: MoneyBucket;
  net: number;
  partial: MoneyBucket;
  refunds: MoneyBucket;
}

function bucket(value: Json | undefined): MoneyBucket {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { total: numberValue(object.total), count: numberValue(object.count) };
}

function parse(data: Json): PaymentsSummary {
  const value = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return {
    full: bucket(value.full),
    partial: bucket(value.partial),
    insurance: bucket(value.insurance),
    refunds: bucket(value.refunds),
    net: numberValue(value.net),
  };
}

export function usePaymentsSummary(
  params: { method?: string; search?: string; status?: string; tenantId?: string } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: ["payments", "summary", params],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const result = await supabase.rpc("get_payments_summary", {
        p_search: params.search || null,
        p_method: params.method ?? null,
        p_status: params.status ?? null,
        p_tenant_id: params.tenantId ?? null,
      });
      if (result.error) throw result.error;
      return parse(result.data);
    },
  });
}
```

- [ ] **Step 2: Write `useExpensesSummary`**

Create `src/hooks/useExpensesSummary.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/database.types";
import { numberValue } from "@/lib/json";

export interface ExpenseBucket {
  amount: number;
  count: number;
}
export interface ExpensesSummary {
  approved: ExpenseBucket;
  pending: ExpenseBucket;
  thisMonth: ExpenseBucket;
  total: ExpenseBucket;
}

// Structurally identical to usePaymentsSummary's `bucket`; only the money key
// differs (`amount` here, `total` there) because the SQL keys differ.
function bucket(value: Json | undefined): ExpenseBucket {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { amount: numberValue(object.amount), count: numberValue(object.count) };
}

function parse(data: Json): ExpensesSummary {
  const value = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return {
    total: bucket(value.total),
    approved: bucket(value.approved),
    pending: bucket(value.pending),
    thisMonth: bucket(value.this_month),
  };
}

export function useExpensesSummary(
  params: {
    categoryId?: string;
    dateFrom?: string;
    dateTo?: string;
    propertyId?: string;
    search?: string;
    status?: string;
  } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: ["expenses", "summary", params],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const result = await supabase.rpc("get_expenses_summary", {
        p_search: params.search || null,
        p_class: null,
        p_category_id: params.categoryId ?? null,
        p_property_id: params.propertyId ?? null,
        p_status: params.status ?? null,
        p_from: params.dateFrom ?? null,
        p_to: params.dateTo ?? null,
      });
      if (result.error) throw result.error;
      return parse(result.data);
    },
  });
}
```

- [ ] **Step 3: Add the card row to the Payments page**

In `src/routes/admin.payments.tsx`, inside `PaymentsPage` (line ~970) — **above
the tabs**, per the spec's _Why Payments is module-wide_ — add the imports and:

```tsx
const summary = usePaymentsSummary({}, permissions.can(PERMISSIONS.PAYMENTS_READ));
const data = summary.data;
const records = (n: number) => `${n} ${t("summary.records")}`;

<SummaryCards loading={summary.isLoading} error={summary.error}>
  <VibrantKpiCard
    label={t("summary.payments.full")}
    value={<LtrText>{formatKwd(data?.full.total ?? 0, locale)}</LtrText>}
    hint={records(data?.full.count ?? 0)}
    icon={<Wallet className="size-6 text-white" />}
    bgClass="bg-gradient-to-br from-emerald-500 via-emerald-600 to-green-600 shadow-emerald-500/25"
  />
  <VibrantKpiCard
    label={t("summary.payments.partial")}
    value={<LtrText>{formatKwd(data?.partial.total ?? 0, locale)}</LtrText>}
    hint={records(data?.partial.count ?? 0)}
    icon={<PieChart className="size-6 text-white" />}
    bgClass="bg-gradient-to-br from-sky-500 via-sky-600 to-blue-600 shadow-sky-500/25"
  />
  <VibrantKpiCard
    label={t("summary.payments.insurance")}
    value={<LtrText>{formatKwd(data?.insurance.total ?? 0, locale)}</LtrText>}
    hint={records(data?.insurance.count ?? 0)}
    icon={<ShieldCheck className="size-6 text-white" />}
    bgClass="bg-gradient-to-br from-cyan-500 via-cyan-600 to-teal-600 shadow-cyan-500/25"
  />
  <VibrantKpiCard
    label={t("summary.payments.refunds")}
    value={<LtrText>{formatKwd(data?.refunds.total ?? 0, locale)}</LtrText>}
    hint={records(data?.refunds.count ?? 0)}
    icon={<Undo2 className="size-6 text-white" />}
    bgClass="bg-gradient-to-br from-rose-500 via-rose-600 to-red-600 shadow-rose-500/25"
  />
  <VibrantKpiCard
    label={t("summary.payments.net")}
    value={<LtrText>{formatKwd(data?.net ?? 0, locale)}</LtrText>}
    icon={<TrendingUp className="size-6 text-white" />}
    bgClass="bg-gradient-to-br from-violet-500 via-violet-600 to-purple-600 shadow-violet-500/25"
  />
</SummaryCards>;
```

Imports to add: `Wallet, PieChart, ShieldCheck, Undo2, TrendingUp` from
`lucide-react`; `SummaryCards`; `VibrantKpiCard`; `formatKwd`;
`usePaymentsSummary`; `LtrText` from `@/components/ui/ltr-text` if not already
imported.

- [ ] **Step 4: Add the card row to the Expenses page**

In `src/routes/admin.expenses.tsx`, directly after the existing `filters` object
(line ~140):

```tsx
const summary = useExpensesSummary(filters, permissions.can(PERMISSIONS.EXPENSES_READ));
```

and render, between `<ModuleHeader>` and the filter bar:

```tsx
<SummaryCards loading={summary.isLoading} error={summary.error}>
  <VibrantKpiCard
    label={t("summary.expenses.total")}
    value={<LtrText>{formatKwd(summary.data?.total.amount ?? 0, locale)}</LtrText>}
    hint={`${summary.data?.total.count ?? 0} ${t("summary.records")}`}
    icon={<Receipt className="size-6 text-white" />}
    bgClass="bg-gradient-to-br from-amber-500 via-amber-600 to-orange-600 shadow-amber-500/25"
  />
  <VibrantKpiCard
    label={t("summary.expenses.approved")}
    value={<LtrText>{formatKwd(summary.data?.approved.amount ?? 0, locale)}</LtrText>}
    hint={`${summary.data?.approved.count ?? 0} ${t("summary.records")}`}
    icon={<CheckCircle2 className="size-6 text-white" />}
    bgClass="bg-gradient-to-br from-emerald-500 via-emerald-600 to-green-600 shadow-emerald-500/25"
  />
  <VibrantKpiCard
    label={t("summary.expenses.pending")}
    value={<LtrText>{formatKwd(summary.data?.pending.amount ?? 0, locale)}</LtrText>}
    hint={`${summary.data?.pending.count ?? 0} ${t("summary.records")}`}
    icon={<Clock className="size-6 text-white" />}
    bgClass="bg-gradient-to-br from-slate-500 via-slate-600 to-gray-700 shadow-slate-500/25"
  />
  <VibrantKpiCard
    label={t("summary.expenses.thisMonth")}
    value={<LtrText>{formatKwd(summary.data?.thisMonth.amount ?? 0, locale)}</LtrText>}
    hint={`${summary.data?.thisMonth.count ?? 0} ${t("summary.records")}`}
    icon={<CalendarDays className="size-6 text-white" />}
    bgClass="bg-gradient-to-br from-indigo-500 via-indigo-600 to-blue-700 shadow-indigo-500/25"
  />
</SummaryCards>
```

- [ ] **Step 5: Verify in the browser**

Run: `bun run dev`, open `/admin/expenses`.
Expected: four cards above the filter bar. Set the property filter — the totals
change with the table. Clear it — they return. Open `/admin/payments`: five cards
above the tabs, and the "Full payments" figure equals `collections` on
`/admin/reports` for an all-time range.

- [ ] **Step 6: Run the gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/usePaymentsSummary.ts src/hooks/useExpensesSummary.ts \
        src/routes/admin.payments.tsx src/routes/admin.expenses.tsx
git commit -m "feat(admin): add summary cards to payments and expenses pages"
```

---

### Task 5: Contracts, Tenants and Units cards

**Files:**

- Create: `src/hooks/useContractsSummary.ts`, `src/hooks/useTenantsSummary.ts`, `src/hooks/useUnitsSummary.ts`
- Modify: `src/routes/admin.contracts.tsx`, `src/routes/admin.tenants.index.tsx`, `src/routes/admin.units.index.tsx`

**Interfaces:**

- Consumes: exactly the same imports as Task 4.
- Produces:
  - `useContractsSummary(params, enabled?)` → `{ total, active, expiring60d, ended, nextExpiry, monthlyAmount, annualAmount }`
  - `useTenantsSummary(params, enabled?)` → `{ total, active, blockedInactive, arrears: { amount, tenants } }`
  - `useUnitsSummary(params, enabled?)` → `{ total, occupied, vacant, underMaintenance, rentPotential }`

- [ ] **Step 1: Write the three hooks**

Each follows `usePaymentsSummary` exactly — same `useQuery` options, same
`numberValue` coercion, `queryKey: ["<module>", "summary", params]`,
`staleTime: 30_000`. Example, `src/hooks/useContractsSummary.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/database.types";
import { numberValue } from "@/lib/json";

export interface ContractsSummary {
  active: number;
  annualAmount: number;
  ended: number;
  expiring60d: number;
  monthlyAmount: number;
  nextExpiry: string | null;
  total: number;
}

function parse(data: Json): ContractsSummary {
  const value = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return {
    total: numberValue(value.total),
    active: numberValue(value.active),
    expiring60d: numberValue(value.expiring_60d),
    ended: numberValue(value.ended),
    nextExpiry: typeof value.next_expiry === "string" ? value.next_expiry : null,
    monthlyAmount: numberValue(value.monthly_amount),
    annualAmount: numberValue(value.annual_amount),
  };
}

export function useContractsSummary(
  params: { search?: string; state?: string; tenantId?: string } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: ["contracts", "summary", params],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const result = await supabase.rpc("get_contracts_summary", {
        p_search: params.search || null,
        p_state: params.state && params.state !== "all" ? params.state : null,
        p_tenant_id: params.tenantId ?? null,
      });
      if (result.error) throw result.error;
      return parse(result.data);
    },
  });
}
```

`useTenantsSummary` parses `{total, active, blocked_inactive, arrears:{amount,tenants}}`
and calls `get_tenants_summary(p_search, p_category, p_lifecycle)`.
`useUnitsSummary` parses `{total, occupied, vacant, under_maintenance, rent_potential}`
and calls `get_units_summary(p_search, p_property_id, p_building_id, p_status, p_type, p_meter)`,
mapping each `"all"` sentinel to `null` the way `useUnits` already maps it to
`undefined`.

- [ ] **Step 2: Wire the Contracts page**

In `src/routes/admin.contracts.tsx`, after the existing filter state (~line 162):

```tsx
const summary = useContractsSummary(
  { search, state: stateFilter },
  permissions.can(PERMISSIONS.CONTRACTS_READ),
);
```

Render between `<ModuleHeader>` and the filter bar — five cards: Total (`FileText`,
slate), Active (`FileCheck`, emerald, with
`progressBar={{ current: summary.data?.active ?? 0, total: summary.data?.total ?? 0 }}`),
Expiring ≤60d (`CalendarClock`, amber, `hint` = `summary.data?.nextExpiry ?? ""`),
Ended (`FileX`, rose), Annual rent value (`Banknote`, violet, value
`formatKwd(annualAmount, locale)`, hint
`` `${formatKwd(monthlyAmount, locale)} ${t("summary.contracts.monthlyHint")}` ``).

- [ ] **Step 3: Wire the Tenants page**

In `src/routes/admin.tenants.index.tsx`, after the `search` state (~line 243):

```tsx
const summary = useTenantsSummary({ search }, permissions.can(PERMISSIONS.TENANTS_READ));
```

Four cards: Total (`Users`, slate), Active (`UserCheck`, emerald), In arrears
(`AlertTriangle`, rose — value `formatKwd(arrears.amount, locale)`, hint
`` `${arrears.tenants} ${t("summary.tenants.arrearsHint")}` ``), Blocked/inactive
(`UserX`, amber).

- [ ] **Step 4: Wire the Units page**

In `src/routes/admin.units.index.tsx`, after `unitFilters` (~line 142):

```tsx
const summary = useUnitsSummary(unitFilters, permissions.can(PERMISSIONS.UNITS_READ));
```

Five cards: Total (`Building2`, slate), Occupied (`DoorClosed`, emerald, with
`progressBar={{ current: occupied, total }}` and hint = occupancy percentage),
Vacant (`DoorOpen`, blue), Under maintenance (`Wrench`, amber), Monthly rent
potential (`Banknote`, violet, `formatKwd(rentPotential, locale)`).

- [ ] **Step 5: Verify each page in the browser**

Run: `bun run dev`.
Expected, per page:

- `/admin/contracts` — set the state filter to `active`; the "Total" card must
  equal the Pager count.
- `/admin/units` — set the status filter to `occupied`; the "Occupied" card must
  equal the Pager count, and "Total" must equal it too.
- `/admin/tenants` — the arrears tenant count must equal the number of rows
  showing an overdue badge.

Then toggle to Arabic on each and confirm labels translate and numerals stay LTR.

- [ ] **Step 6: Confirm silent failure**

Temporarily change one hook's RPC name to `get_units_summary_nope`, reload
`/admin/units`. Expected: no cards, table renders normally, one console error.
Revert.

- [ ] **Step 7: Run the gates and commit**

Run: `bun run lint && bun run typecheck && bun run test`

```bash
git add src/hooks/useContractsSummary.ts src/hooks/useTenantsSummary.ts \
        src/hooks/useUnitsSummary.ts src/routes/admin.contracts.tsx \
        src/routes/admin.tenants.index.tsx src/routes/admin.units.index.tsx
git commit -m "feat(admin): add summary cards to contracts, tenants and units pages"
```

---

### Task 6: Full gates and PR

**Files:** none created or modified.

- [ ] **Step 1: Re-check the branch** — another agent may have committed here.

```bash
git status && git log --oneline -5
```

- [ ] **Step 2: Run every gate**

```bash
bun run lint && bun run typecheck && bun run test && bun run test:db && bun run test:sql
```

Expected: all PASS. `test:db` rebuilds the schema from scratch and is the only
thing that proves migration 79 applies cleanly in order.

- [ ] **Step 3: Open the PR** — do **not** use `gh pr merge --auto`; it merges
      instantly and aborts the CodeRabbit review.

```bash
git push -u origin feat/admin-summary-cards
gh pr create --title "feat(admin): summary KPI cards above the five list tables" --body "..."
```

---

### Task 7: Apply migration 79 to production

**Only after the PR is approved and merged.** Dokploy auto-deploys on push to
`main`, so the schema must land **before** the frontend that calls it. Run these
steps immediately after merging, ideally before the build finishes.

- [ ] **Step 1: Transfer the migration**

Via `ssh-danatfuture-mcp`. SSH exec caps at ~1000 characters, so send
`db/migrations/79_module_summary_rpcs.sql` as chunked base64 into a temp file on
the host, then verify with `md5sum` against the local checksum before applying.

- [ ] **Step 2: Apply it**

```bash
docker exec -i danatfuture-supabase-ozoxsa-db-1 \
  psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f /tmp/79_module_summary_rpcs.sql
```

Do **not** replay the whole migration set — several are not idempotent.

- [ ] **Step 3: Reload the PostgREST schema cache**

```sql
notify pgrst, 'reload schema';
```

Without this the functions exist but PostgREST returns 404 for every RPC call.

- [ ] **Step 4: Verify on production**

```sql
select public.get_units_summary(null, null, null, null, null, null);
select has_function_privilege('anon',
  'public.get_units_summary(text,uuid,uuid,text,text,text)', 'execute');  -- must be false
```

- [ ] **Step 5: Confirm in the live app**

Open https://danat-future.com/admin/units and confirm the cards render and the
Occupied count matches the table when filtered to `occupied`.

---

## Self-review

**Spec coverage.** Every spec section maps to a task: the five card sets → Tasks
1–2 (SQL) and 4–5 (UI); the Payments module-wide deviation → Task 4 Step 3, which
passes `{}` rather than the tab search; the security rules → the guard and
`revoke ... from public, anon` in Tasks 1–2, tested by **both** the `grants`
describe blocks (anon has no execute) and the `permission guard` describe block
(an authenticated user without the read code gets `42501`) — the guard is the
whole access control on a `security definer` function, so testing only the grant
would leave half the story unverified; silent failure → Task 3 Step 3 and
verified in Task 5 Step 6; the `archived_at` wart → the `archived_at is null`
predicates in `get_contracts_summary` and `get_tenants_summary`, with the
dashboard explicitly left alone.

**SQL form.** No function uses a CTE before `select ... into`. Every aggregate is
a plain select or a `from (subquery) f`, matching all ~12 existing `into v_` sites
in `db/migrations/` — `get_budget_summary` in migration 08 is the reference.
`get_tenants_summary` uses two separate statements because joining `invoices` into
the tenant aggregate would multiply rows and corrupt the `count(*)`s.

**Placeholder scan.** No TBDs, no "handle edge cases", no "similar to Task N".
Task 5 Steps 2–4 describe the card JSX in prose rather than repeating five
near-identical blocks, but the full pattern is shown verbatim in Task 4 Steps 3–4
and every prop is named explicitly (icon, colour class, label key, value
expression, progress bar) — an implementer reading Task 5 alone has the pattern
one screen above and no decision left to make.

**Type consistency.** `MoneyBucket` (`{total,count}`) is used only by
`usePaymentsSummary`; `ExpenseBucket` (`{amount,count}`) only by
`useExpensesSummary` — the field names differ because the SQL keys differ
(`total` vs `amount`), and the two `bucket()` functions are otherwise structurally
identical, reading the matching key. `numberValue` has one definition
(`src/lib/json.ts`) consumed by all five new hooks; `useBudget` keeps its own by
design. JSON keys are snake_case in SQL and camelCase in TypeScript, mapped
explicitly in every `parse` (`expiring_60d` → `expiring60d`, `this_month` →
`thisMonth`, `rent_potential` → `rentPotential`, `blocked_inactive` →
`blockedInactive`).

## Execution handoff

Two options once approved:

1. **Subagent-driven (recommended)** — a fresh subagent per task, reviewed between
   tasks. Task 2 depends on Task 1's file existing; Tasks 4 and 5 both depend on
   Task 3; otherwise they are independent.
2. **Inline execution** — run the tasks in this session with checkpoints.
