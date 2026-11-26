import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { closePool, setCompanyClaimContext, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 78 — `bulk_import_phase6` learns about contracts.
 *
 * Worth a SQL test rather than a mock: the branch is plpgsql, and everything
 * that can go wrong with it is invisible to the type checker. `create or
 * replace` validates the body's *syntax* at creation, so a clean `test:db` run
 * proves only that it parses — a wrong column name, a bad enum cast or the
 * wrong return count all survive until the function is actually called.
 */

interface Fixture {
  companyId: string;
  propertyId: string;
  tenantId: string;
  unitId: string;
  tag: string;
}

/** A company, property, unit and tenant — everything a contract needs to exist. */
async function seedLocation(client: PoolClient): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const company = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة ${tag}`, `Co ${tag}`],
  );
  const companyId = company.rows[0].id;
  await setCompanyClaimContext(client, companyId);
  const property = await client.query<{ id: string }>(
    `insert into public.properties (code, company_id, name_ar, name_en)
     values ($1, $2, $3, $4) returning id`,
    [`P-${tag}`, companyId, `عقار ${tag}`, `Property ${tag}`],
  );
  const unit = await client.query<{ id: string }>(
    `insert into public.units (company_id, code, property_id, name) values ($1, $2, $3, $4) returning id`,
    [companyId, `U-${tag}`, property.rows[0].id, `Unit ${tag}`],
  );
  const tenant = await client.query<{ id: string }>(
    `insert into public.tenants (code, company_id, name) values ($1, $2, $3) returning id`,
    [`T-${tag}`, companyId, `مستأجر ${tag}`],
  );
  return {
    companyId,
    propertyId: property.rows[0].id,
    tenantId: tenant.rows[0].id,
    unitId: unit.rows[0].id,
    tag,
  };
}

async function importContracts(
  client: PoolClient,
  rows: Array<Record<string, unknown>>,
): Promise<number> {
  const { rows: result } = await client.query<{ bulk_import_phase6: number }>(
    `select public.bulk_import_phase6('contracts', $1::jsonb)`,
    [JSON.stringify(rows)],
  );
  return result[0].bulk_import_phase6;
}

describe("bulk_import_phase6('contracts')", () => {
  test("inserts contracts and returns how many, not how many insurance rows", async () => {
    // The regression this pins: the branch ends with an insert into
    // insurance_payments, so the function's shared trailing
    // `get diagnostics v_count = row_count` would report *that* count. Two
    // contracts where only one carries a deposit is the case that tells the
    // two numbers apart — a wrong implementation returns 1.
    await withRollback(async (client) => {
      const { companyId, tenantId, unitId, propertyId, tag } = await seedLocation(client);
      const second = await client.query<{ id: string }>(
        `insert into public.units (company_id, code, property_id, name) values ($1, $2, $3, $4) returning id`,
        [companyId, `U2-${tag}`, propertyId, `Unit two ${tag}`],
      );

      const inserted = await importContracts(client, [
        {
          tenant_id: tenantId,
          unit_id: unitId,
          start_date: "2026-01-01",
          end_date: "2026-12-31",
          monthly_amount: 500,
          deposit: 250,
        },
        {
          tenant_id: tenantId,
          unit_id: second.rows[0].id,
          start_date: "2026-01-01",
          end_date: "2026-12-31",
          monthly_amount: 300,
          deposit: 0,
        },
      ]);

      expect(inserted).toBe(2);
    });
  });

  test("generates a code when the column is blank and honours one that is given", async () => {
    await withRollback(async (client) => {
      const { companyId, tenantId, unitId, propertyId, tag } = await seedLocation(client);
      const second = await client.query<{ id: string }>(
        `insert into public.units (company_id, code, property_id, name) values ($1, $2, $3, $4) returning id`,
        [companyId, `U2-${tag}`, propertyId, `Unit two ${tag}`],
      );

      await importContracts(client, [
        {
          code: "",
          tenant_id: tenantId,
          unit_id: unitId,
          start_date: "2026-01-01",
          end_date: "2026-12-31",
          monthly_amount: 500,
        },
        {
          code: `KEEP-${tag}`,
          tenant_id: tenantId,
          unit_id: second.rows[0].id,
          start_date: "2026-01-01",
          end_date: "2026-12-31",
          monthly_amount: 500,
        },
      ]);

      const { rows } = await client.query<{ code: string }>(
        `select code from public.contracts where tenant_id = $1 order by code`,
        [tenantId],
      );
      expect(rows).toHaveLength(2);
      expect(rows.some((row) => row.code === `KEEP-${tag}`)).toBe(true);
      expect(rows.some((row) => row.code !== `KEEP-${tag}` && row.code.length > 0)).toBe(true);
    });
  });

  test("blank type and state fall back to investment and draft", async () => {
    // Draft matters: `active` would flip the unit to occupied through migration
    // 76's trigger, so a template column left empty must not activate a lease.
    await withRollback(async (client) => {
      const { tenantId, unitId } = await seedLocation(client);

      await importContracts(client, [
        {
          tenant_id: tenantId,
          unit_id: unitId,
          type: "",
          state: "",
          start_date: "2026-01-01",
          end_date: "2026-12-31",
          monthly_amount: 500,
        },
      ]);

      const { rows } = await client.query<{ type: string; state: string; due_day: number }>(
        `select type, state, due_day from public.contracts where tenant_id = $1`,
        [tenantId],
      );
      expect(rows[0].type).toBe("investment");
      expect(rows[0].state).toBe("draft");
      expect(rows[0].due_day).toBe(1);
    });
  });

  test("a row without grace_days imports with one day of grace (migration 249)", async () => {
    await withRollback(async (client) => {
      const { tenantId, unitId } = await seedLocation(client);

      await importContracts(client, [
        {
          tenant_id: tenantId,
          unit_id: unitId,
          start_date: "2026-01-01",
          end_date: "2026-12-31",
          monthly_amount: 500,
        },
      ]);

      const { rows } = await client.query<{ grace_days: number }>(
        `select grace_days from public.contracts where tenant_id = $1`,
        [tenantId],
      );
      expect(rows[0].grace_days).toBe(1);
    });
  });

  test("an imported active contract still flips its unit to occupied", async () => {
    await withRollback(async (client) => {
      const { tenantId, unitId } = await seedLocation(client);

      await importContracts(client, [
        {
          tenant_id: tenantId,
          unit_id: unitId,
          state: "active",
          start_date: "2026-01-01",
          end_date: "2026-12-31",
          monthly_amount: 500,
        },
      ]);

      const { rows } = await client.query<{ status: string }>(
        `select status from public.units where id = $1`,
        [unitId],
      );
      expect(rows[0].status).toBe("occupied");
    });
  });

  describe("the deposit reaches insurance_payments", () => {
    test("a contract with a deposit gets a holding dated to its start", async () => {
      // Without this the amount lives only on the contract row, and the
      // Insurance tab and the budget's insurance_collected KPI never see it —
      // silently, which is why it is asserted rather than assumed.
      await withRollback(async (client) => {
        const { tenantId, unitId } = await seedLocation(client);

        await importContracts(client, [
          {
            tenant_id: tenantId,
            unit_id: unitId,
            start_date: "2026-03-15",
            end_date: "2026-12-31",
            monthly_amount: 500,
            deposit: 750,
          },
        ]);

        const { rows } = await client.query<{ amount: string; collected_date: string }>(
          // Formatted in SQL, not read as a Date: `pg` hands a `date` back as a
          // JS Date at *local* midnight, so .toISOString() shifts it a day
          // earlier anywhere east of UTC — Kuwait included.
          `select i.amount, to_char(i.collected_date, 'YYYY-MM-DD') as collected_date
             from public.insurance_payments i
             join public.contracts c on c.id = i.contract_id
            where c.tenant_id = $1`,
          [tenantId],
        );
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].amount)).toBe(750);
        // The contract's start, not today: a back-dated import must land in the
        // budget period it was actually collected in.
        expect(rows[0].collected_date).toBe("2026-03-15");
      });
    });

    test("a zero-deposit contract imports cleanly and holds nothing", async () => {
      // insurance_payments.amount carries check (amount > 0), so without the
      // `deposit > 0` filter a single zero-deposit row aborts the whole batch.
      await withRollback(async (client) => {
        const { tenantId, unitId } = await seedLocation(client);

        const inserted = await importContracts(client, [
          {
            tenant_id: tenantId,
            unit_id: unitId,
            start_date: "2026-01-01",
            end_date: "2026-12-31",
            monthly_amount: 500,
            deposit: 0,
          },
        ]);

        expect(inserted).toBe(1);
        const { rows } = await client.query<{ count: string }>(
          `select count(*) from public.insurance_payments i
             join public.contracts c on c.id = i.contract_id
            where c.tenant_id = $1`,
          [tenantId],
        );
        expect(Number(rows[0].count)).toBe(0);
      });
    });
  });

  test("anon and authenticated cannot execute the importer", async () => {
    // Not hypothetical. Before migration 78 named `anon` in its REVOKE, an
    // unauthenticated POST to /rest/v1/rpc/bulk_import_phase6 on production,
    // carrying only the publishable anon key, reached the function body and
    // returned `Unsupported import entity` — with a real entity it would have
    // inserted rows as the owner, bypassing RLS entirely.
    //
    // The trap: Supabase grants EXECUTE on every new public function to anon
    // and authenticated by default, and `revoke ... from public` does not
    // reach them — they hold their own grants rather than inheriting through
    // PUBLIC. Migrations 08 and 16 both revoked "from public, authenticated"
    // and so left anon behind. This asserts a clean build closes it.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ role: string; allowed: boolean }>(
        `select r.rolname as role,
                has_function_privilege(r.rolname,
                  'public.bulk_import_phase6(text, jsonb, uuid)', 'EXECUTE') as allowed
           from pg_roles r
          where r.rolname in ('anon', 'authenticated', 'service_role')
          order by r.rolname`,
      );
      const allowed = Object.fromEntries(rows.map((row) => [row.role, row.allowed]));
      expect(allowed.anon).toBe(false);
      expect(allowed.authenticated).toBe(false);
      // service_role keeps it — that is the only path the server function uses.
      expect(allowed.service_role).toBe(true);
    });
  });

  test("a second live contract on the same unit is refused", async () => {
    // one_active_contract_per_unit (04:179) is the real authority — the
    // client-side assertUnitAvailable never runs on this path.
    await withRollback(async (client) => {
      const { tenantId, unitId } = await seedLocation(client);
      const row = {
        tenant_id: tenantId,
        unit_id: unitId,
        state: "active",
        start_date: "2026-01-01",
        end_date: "2026-12-31",
        monthly_amount: 500,
      };

      await expect(importContracts(client, [row, row])).rejects.toThrow(
        /one_active_contract_per_unit/i,
      );
    });
  });
});
