import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { actAs, closePool, seedContract, setCompanyClaimContext, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 79 — per-module summary RPCs behind the admin list-page KPI cards.
 *
 * These are `security definer`, so RLS does not apply and the `has_permission`
 * guard is the entire access control. The grant tests below are therefore load
 * bearing, not decorative: `revoke ... from public` does NOT reach `anon`, which
 * holds its own grant from Supabase's default privileges.
 */

/**
 * Every call below is SCOPED to the fixture the test just created — by tenant,
 * by property, or by the tenant's unique code.
 *
 * This is not stylistic. `withRollback`'s own contract says assertions "must be
 * scoped to the fixtures the test itself created rather than to global counts",
 * for two independent reasons:
 *
 *  1. Migrations 11 and 15 seed demo rows, so an unscoped total measures the
 *     seed, not the change under test.
 *  2. Vitest runs test FILES in parallel against one Postgres. An unscoped
 *     `before`/`after` delta straddles two READ COMMITTED snapshots, so a
 *     concurrent file moving the same global number makes the delta wrong.
 *     The arrears test below failed exactly this way in the full suite while
 *     passing when run alone.
 *
 * Codes are omitted from every insert: payments/expenses/invoices all default
 * theirs from a sequence function, and hardcoding a literal into a `unique`
 * column is a collision waiting to happen.
 */
/**
 * jsonb payload from the five summary RPCs. Nested objects and scalars; shape
 * is asserted at each call site via `num(...)` rather than a rigid interface.
 */

type SummaryJson = Record<string, any>;

/** ينشئ شركة اختبارية معزولة ويضبط سياقها لاستدعاء ملخصات الوحدات. */
async function seedSummaryCompany(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة ملخص ${tag}`, `Summary Co ${tag}`],
  );
  await setCompanyClaimContext(client, rows[0].id);
  return rows[0].id;
}

async function summaryWith(
  client: PoolClient,
  fn: string,
  placeholders: string,
  params: unknown[],
): Promise<SummaryJson> {
  const { rows } = await client.query<{ result: SummaryJson }>(
    `select public.${fn}(${placeholders}) as result`,
    params,
  );
  return rows[0].result;
}

/** jsonb numerics arrive as numbers or numeric strings depending on scale. */
function num(value: unknown): number {
  return Number(value ?? 0);
}

describe("get_payments_summary", () => {
  test("counts only confirmed, non-reversed payments", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      await client.query(
        `insert into public.payments (tenant_id, unit_id, amount, method, status, payment_date)
         values ($1, $2, 100.000, 'cash', 'confirmed', '2026-02-01'),
                ($1, $2, 50.000, 'cash', 'pending', '2026-02-02')`,
        [fixture.tenantId, fixture.unitId],
      );

      const result = await summaryWith(client, "get_payments_summary", "null, null, null, $1", [
        fixture.tenantId,
      ]);

      // The pending row must not land anywhere in the total.
      expect(num(result.full.total)).toBe(100);
      expect(num(result.full.count)).toBe(1);
    });
  });

  test("a reversed payment drops out of the total", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      const original = await client.query<{ id: string }>(
        `insert into public.payments (tenant_id, unit_id, amount, method, status, payment_date)
         values ($1, $2, 400.000, 'cash', 'confirmed', '2026-02-01') returning id`,
        [fixture.tenantId, fixture.unitId],
      );

      const before = await summaryWith(client, "get_payments_summary", "null, null, null, $1", [
        fixture.tenantId,
      ]);
      expect(num(before.full.total)).toBe(400);

      // A reversal is a second payment that the original points at — the schema
      // forbids self-reference (`reversed_by_payment_id <> id`, migration 05).
      // The reversing row is itself status 'reversed', so neither side counts.
      const reversal = await client.query<{ id: string }>(
        `insert into public.payments (tenant_id, unit_id, amount, method, status, payment_date)
         values ($1, $2, 400.000, 'cash', 'reversed', '2026-02-02') returning id`,
        [fixture.tenantId, fixture.unitId],
      );
      await client.query(`update public.payments set reversed_by_payment_id = $2 where id = $1`, [
        original.rows[0].id,
        reversal.rows[0].id,
      ]);

      const after = await summaryWith(client, "get_payments_summary", "null, null, null, $1", [
        fixture.tenantId,
      ]);
      expect(num(after.full.total)).toBe(0);
      expect(num(after.full.count)).toBe(0);
    });
  });

  test("net excludes insurance but subtracts refunds", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      await client.query(
        `insert into public.payments (tenant_id, unit_id, amount, method, status, payment_date)
         values ($1, $2, 300.000, 'cash', 'confirmed', '2026-03-01')`,
        [fixture.tenantId, fixture.unitId],
      );
      await client.query(
        `insert into public.insurance_payments (tenant_id, contract_id, amount, collected_date)
         values ($1, $2, 500.000, '2026-03-01')`,
        [fixture.tenantId, fixture.contractId],
      );
      await client.query(
        `insert into public.refunds (tenant_id, contract_id, amount, refund_date, post_action)
         values ($1, $2, 20.000, '2026-03-05', 'store')`,
        [fixture.tenantId, fixture.contractId],
      );

      const result = await summaryWith(client, "get_payments_summary", "null, null, null, $1", [
        fixture.tenantId,
      ]);

      expect(num(result.insurance.total)).toBe(500);
      // 300 collected - 20 refunded. The 500 insurance is a holding, not income,
      // so it must not move net.
      expect(num(result.net)).toBe(280);
    });
  });
});

describe("get_expenses_summary", () => {
  test("splits approved from pending and honours the property filter", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      await client.query(
        `insert into public.expenses (amount, class, status, expense_date, property_id)
         values (70.000, 'sudden_one_time', 'approved', '2026-02-01', $1),
                (30.000, 'sudden_one_time', 'pending', '2026-02-02', $1)`,
        [fixture.propertyId],
      );

      const scoped = await summaryWith(
        client,
        "get_expenses_summary",
        "null, null, null, $1, null, null, null",
        [fixture.propertyId],
      );

      expect(num(scoped.total.amount)).toBe(100);
      expect(num(scoped.total.count)).toBe(2);
      expect(num(scoped.approved.amount)).toBe(70);
      expect(num(scoped.pending.amount)).toBe(30);
    });
  });

  test("an unmatched property filter zeroes the totals", async () => {
    await withRollback(async (client) => {
      await seedSummaryCompany(client);
      const scoped = await summaryWith(
        client,
        "get_expenses_summary",
        "null, null, null, $1, null, null, null",
        ["00000000-0000-0000-0000-000000000000"],
      );
      expect(num(scoped.total.amount)).toBe(0);
      expect(num(scoped.total.count)).toBe(0);
    });
  });

  test("the date range bounds `total` but never `this month`", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      await client.query(
        `insert into public.expenses (amount, class, status, expense_date, property_id)
         values (10.000, 'sudden_one_time', 'approved', '2020-01-15', $1)`,
        [fixture.propertyId],
      );

      const scoped = await summaryWith(
        client,
        "get_expenses_summary",
        "null, null, null, $1, null, '2020-01-01'::date, '2020-01-31'::date",
        [fixture.propertyId],
      );

      expect(num(scoped.total.amount)).toBe(10);
      // `this month` is an absolute reference point and ignores p_from/p_to, so
      // a 2020 row must not appear in it.
      expect(num(scoped.this_month.amount)).toBe(0);
    });
  });
});

describe("get_contracts_summary", () => {
  test("counts active contracts and flags those ending within 60 days", async () => {
    await withRollback(async (client) => {
      // Ends inside the 60-day window relative to whatever `current_date` is.
      const endDate = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate,
        state: "active",
        monthlyAmount: 500,
      });

      const result = await summaryWith(client, "get_contracts_summary", "null, null, $1", [
        fixture.tenantId,
      ]);

      expect(num(result.total)).toBe(1);
      expect(num(result.active)).toBe(1);
      expect(num(result.expiring_60d)).toBe(1);
      expect(num(result.monthly_amount)).toBe(500);
      expect(num(result.annual_amount)).toBe(6000);
      expect(result.next_expiry).toBe(endDate);
    });
  });

  test("a contract ending beyond 60 days is active but not expiring", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10),
        state: "active",
      });

      const result = await summaryWith(client, "get_contracts_summary", "null, null, $1", [
        fixture.tenantId,
      ]);

      expect(num(result.active)).toBe(1);
      expect(num(result.expiring_60d)).toBe(0);
    });
  });

  test("excludes archived contracts", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
      });

      const before = await summaryWith(client, "get_contracts_summary", "null, null, $1", [
        fixture.tenantId,
      ]);
      expect(num(before.total)).toBe(1);

      await client.query(`update public.contracts set archived_at = now() where id = $1`, [
        fixture.contractId,
      ]);

      const after = await summaryWith(client, "get_contracts_summary", "null, null, $1", [
        fixture.tenantId,
      ]);
      expect(num(after.total)).toBe(0);
    });
  });

  test("archived_count is identical across all three archive modes", async () => {
    await withRollback(async (client) => {
      const live = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
      });
      const archived = await seedContract(client, {
        companyId: live.companyId,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "terminated",
      });
      await client.query(`update public.contracts set archived_at = now() where id = $1`, [
        archived.contractId,
      ]);

      // Scope by a synthetic shared search that matches neither by default —
      // use tenant filter null and pass no search; instead assert per-tenant
      // would mix. Scope both fixtures under null filters but verify counts
      // via the archived row's contract code as p_search is single-code.
      // Two separate mode triples scoped to each fixture's tenant prove the
      // mode-independence property without depending on global seed data.
      for (const tenantId of [live.tenantId, archived.tenantId]) {
        const current = await summaryWith(
          client,
          "get_contracts_summary",
          "null, null, $1, 'current'",
          [tenantId],
        );
        const arch = await summaryWith(
          client,
          "get_contracts_summary",
          "null, null, $1, 'archived'",
          [tenantId],
        );
        const all = await summaryWith(client, "get_contracts_summary", "null, null, $1, 'all'", [
          tenantId,
        ]);
        expect(num(current.archived_count)).toBe(num(arch.archived_count));
        expect(num(arch.archived_count)).toBe(num(all.archived_count));
        expect(num(current.current_count)).toBe(num(arch.current_count));
        expect(num(arch.current_count)).toBe(num(all.current_count));
      }

      const liveModes = await Promise.all(
        (["current", "archived", "all"] as const).map((mode) =>
          summaryWith(client, "get_contracts_summary", "null, null, $1, $2", [live.tenantId, mode]),
        ),
      );
      expect(liveModes.map((r) => num(r.archived_count))).toEqual([0, 0, 0]);
      expect(liveModes.map((r) => num(r.current_count))).toEqual([1, 1, 1]);

      const archivedModes = await Promise.all(
        (["current", "archived", "all"] as const).map((mode) =>
          summaryWith(client, "get_contracts_summary", "null, null, $1, $2", [
            archived.tenantId,
            mode,
          ]),
        ),
      );
      expect(archivedModes.map((r) => num(r.archived_count))).toEqual([1, 1, 1]);
      expect(archivedModes.map((r) => num(r.current_count))).toEqual([0, 0, 0]);
      // Mode still scopes `total`.
      expect(num(archivedModes[0].total)).toBe(0);
      expect(num(archivedModes[1].total)).toBe(1);
      expect(num(archivedModes[2].total)).toBe(1);
    });
  });
});

describe("get_tenants_summary", () => {
  test("sums overdue invoice balances into arrears", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      // get_tenants_summary has no tenant-id argument, so scope through p_search
      // on the fixture's unique code. Without this the assertion straddles two
      // READ COMMITTED snapshots of a global aggregate and flakes under the
      // parallel suite — which is exactly how this test first failed.
      const { rows } = await client.query<{ code: string }>(
        `select code from public.tenants where id = $1`,
        [fixture.tenantId],
      );
      const tenantCode = rows[0].code;

      // invoices.balance is `generated always as (total - paid)`, so set total
      // and paid rather than balance; the period is year/month, not a date range.
      await client.query(
        `insert into public.invoices
           (tenant_id, contract_id, unit_id, period_year, period_month,
            issue_date, due_date, subtotal, total, paid, state, idempotency_key)
         values ($1, $2, $3, 2026, 2, '2026-02-01', '2026-02-05',
                 250.000, 250.000, 0, 'overdue', $4)`,
        [
          fixture.tenantId,
          fixture.contractId,
          fixture.unitId,
          `sqltest-arrears-${fixture.tenantId}`,
        ],
      );

      const result = await summaryWith(client, "get_tenants_summary", "$1, null, null", [
        tenantCode,
      ]);

      expect(num(result.total)).toBe(1);
      expect(num(result.arrears.amount)).toBe(250);
      expect(num(result.arrears.tenants)).toBe(1);
    });
  });

  test("a settled invoice contributes nothing to arrears", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const { rows } = await client.query<{ code: string }>(
        `select code from public.tenants where id = $1`,
        [fixture.tenantId],
      );

      await client.query(
        `insert into public.invoices
           (tenant_id, contract_id, unit_id, period_year, period_month,
            issue_date, due_date, subtotal, total, paid, state, idempotency_key)
         values ($1, $2, $3, 2026, 3, '2026-03-01', '2026-03-05',
                 250.000, 250.000, 250.000, 'paid', $4)`,
        [fixture.tenantId, fixture.contractId, fixture.unitId, `sqltest-paid-${fixture.tenantId}`],
      );

      const result = await summaryWith(client, "get_tenants_summary", "$1, null, null", [
        rows[0].code,
      ]);

      expect(num(result.arrears.amount)).toBe(0);
      expect(num(result.arrears.tenants)).toBe(0);
    });
  });

  test("archived_count is identical across all three archive modes", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const { rows } = await client.query<{ code: string }>(
        `select code from public.tenants where id = $1`,
        [fixture.tenantId],
      );
      const tenantCode = rows[0].code;

      await client.query(`update public.tenants set archived_at = now() where id = $1`, [
        fixture.tenantId,
      ]);

      const modes = await Promise.all(
        (["current", "archived", "all"] as const).map((mode) =>
          summaryWith(client, "get_tenants_summary", "$1, null, null, $2", [tenantCode, mode]),
        ),
      );
      expect(modes.map((r) => num(r.archived_count))).toEqual([1, 1, 1]);
      expect(modes.map((r) => num(r.current_count))).toEqual([0, 0, 0]);
      expect(num(modes[0].total)).toBe(0);
      expect(num(modes[1].total)).toBe(1);
      expect(num(modes[2].total)).toBe(1);
    });
  });
});

describe("get_units_summary", () => {
  test("occupied reflects the trigger-derived status, and the buckets partition", async () => {
    await withRollback(async (client) => {
      // seedContract inserts the unit first, so migration 76's trigger flips it
      // to `occupied` when the active contract lands.
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
      });

      const result = await summaryWith(
        client,
        "get_units_summary",
        "null, $1, null, null, null, null",
        [fixture.propertyId],
      );

      expect(num(result.total)).toBe(1);
      expect(num(result.occupied)).toBe(1);
      expect(num(result.vacant)).toBe(0);
      expect(num(result.under_maintenance)).toBe(0);
    });
  });

  test("rent_potential sums default_rent and tolerates nulls", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
      });

      // seedContract leaves default_rent null — the coalesce must survive it.
      const nullRent = await summaryWith(
        client,
        "get_units_summary",
        "null, $1, null, null, null, null",
        [fixture.propertyId],
      );
      expect(num(nullRent.rent_potential)).toBe(0);

      await client.query(`update public.units set default_rent = 350.000 where id = $1`, [
        fixture.unitId,
      ]);

      const withRent = await summaryWith(
        client,
        "get_units_summary",
        "null, $1, null, null, null, null",
        [fixture.propertyId],
      );
      expect(num(withRent.rent_potential)).toBe(350);
    });
  });
});

describe("grants", () => {
  test.each([
    ["get_payments_summary(text,text,text,uuid)"],
    ["get_expenses_summary(text,text,uuid,uuid,text,date,date)"],
    ["get_contracts_summary(text,text,uuid,text)"],
    ["get_tenants_summary(text,text,text,text)"],
    ["get_units_summary(text,uuid,uuid,text,text,text)"],
  ])("anon cannot execute %s", async (signature) => {
    await withRollback(async (client) => {
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
   *
   * actAs takes (client, role, userId) — the JWT claim.sub GUC is what
   * auth.uid() reads in this test image.
   */
  test("an authenticated user without payments.read is refused", async () => {
    await withRollback(async (client) => {
      const companyId = await seedSummaryCompany(client);
      const { rows } = await client.query<{ id: string }>(
        `insert into auth.users (id, instance_id, aud, role, email)
         values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
                 'authenticated', 'authenticated', 'nobody@example.test')
         returning id`,
      );
      const userId = rows[0].id;
      await client.query(
        `insert into public.profiles (id, company_id, display_name, is_active)
         values ($1, $2, 'No Role', true)
         on conflict (id) do update set company_id = excluded.company_id, is_active = true`,
        [userId, companyId],
      );
      // No role assignment, so has_permission() returns false for every code.
      await actAs(client, "authenticated", userId);

      await expect(
        client.query(`select public.get_payments_summary(null, null, null, null)`),
      ).rejects.toThrow(/Permission denied/);
    });
  });

  test("an authenticated user without expenses.read is refused", async () => {
    await withRollback(async (client) => {
      const companyId = await seedSummaryCompany(client);
      const { rows } = await client.query<{ id: string }>(
        `insert into auth.users (id, instance_id, aud, role, email)
         values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
                 'authenticated', 'authenticated', 'nobody2@example.test')
         returning id`,
      );
      await client.query(
        `insert into public.profiles (id, company_id, display_name, is_active)
         values ($1, $2, 'No Role 2', true)
         on conflict (id) do update set company_id = excluded.company_id, is_active = true`,
        [rows[0].id, companyId],
      );
      await actAs(client, "authenticated", rows[0].id);

      await expect(
        client.query(
          `select public.get_expenses_summary(null, null, null, null, null, null, null)`,
        ),
      ).rejects.toThrow(/Permission denied/);
    });
  });
});
