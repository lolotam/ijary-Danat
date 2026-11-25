import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { actAs, actAsSuperuser, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * T8 — `tenants.lifecycle` is derived from `public.contracts` (migration 54).
 *
 * None of this is expressible against a mock: the whole feature is a trigger
 * plus an RLS-sensitive write, and the interesting failure mode is a write that
 * is *silently skipped* rather than rejected.
 */

async function lifecycleOf(client: PoolClient, tenantId: string): Promise<string> {
  const { rows } = await client.query<{ lifecycle: string }>(
    `select lifecycle from public.tenants where id = $1`,
    [tenantId],
  );
  return rows[0].lifecycle;
}

/** Creates an auth user holding `role`, so has_permission resolves for it. */
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

describe("tenant lifecycle is derived from contracts", () => {
  test("an active contract makes the tenant active", async () => {
    await withRollback(async (client) => {
      const { tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      expect(await lifecycleOf(client, tenantId)).toBe("active");
    });
  });

  test("expiring the only contract makes the tenant contract_ended", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`update public.contracts set state = 'expired' where id = $1`, [
        contractId,
      ]);
      expect(await lifecycleOf(client, tenantId)).toBe("contract_ended");
    });
  });

  test("a tenant whose only contract is a draft is inactive, not contract_ended", async () => {
    // Found by live testing on 2026-07-31, not by any test. Migration 54 read
    // `contract_ended` as "has contracts, none active", which caught drafts too
    // — so a tenant whose lease starts next month was labelled as one whose
    // lease had finished. That window is the documented admin working order:
    // create tenant -> create login -> add contract (draft) -> activate.
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`update public.contracts set state = 'draft' where id = $1`, [contractId]);
      expect(await lifecycleOf(client, tenantId)).toBe("inactive");
    });
  });

  test("a draft alongside an ended contract still reads contract_ended", async () => {
    // The draft must not mask a lease that genuinely ended, or renewing a
    // finished tenant would reset them to 'inactive' and hide their history.
    await withRollback(async (client) => {
      const { tenantId, unitId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`update public.contracts set state = 'terminated' where id = $1`, [
        contractId,
      ]);
      const draft = await client.query<{ id: string }>(
        `insert into public.contracts
           (code, tenant_id, start_date, end_date, monthly_amount, state)
         values ($1, $2, '2027-01-01', '2027-12-31', 500, 'draft')
         returning id`,
        [`C-draft-${randomUUID().slice(0, 8)}`, tenantId],
      );
      // Migration 114: close-out/restore and the electricity trigger now
      // read contract_units instead of contracts.unit_id. Keep this
      // raw-inserted contract's units in sync so it isn't treated as
      // unitless by those readers.
      await client.query(
        `insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
         values ($1, $2, 500, 1)`,
        [draft.rows[0].id, unitId],
      );
      expect(await lifecycleOf(client, tenantId)).toBe("contract_ended");
    });
  });

  test("deleting the last contract makes the tenant inactive", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`delete from public.contracts where id = $1`, [contractId]);
      expect(await lifecycleOf(client, tenantId)).toBe("inactive");
    });
  });

  test("a tenant created with no contract is inactive, not active", async () => {
    // The column default is 'active' and the tenant form no longer sends a
    // value, so without the before-insert trigger every new tenant would claim
    // to be active forever. This is the drift that put 12 contractless tenants
    // in the `active` bucket on production.
    await withRollback(async (client) => {
      const company = await client.query<{ id: string }>(
        `insert into public.companies (name_ar, name_en) values ('ش', 'C') returning id`,
      );
      const tag = randomUUID().slice(0, 8);
      const { rows } = await client.query<{ id: string; lifecycle: string }>(
        `insert into public.tenants (code, company_id, name) values ($1, $2, $3)
         returning id, lifecycle`,
        [`T-${tag}`, company.rows[0].id, `مستأجر ${tag}`],
      );
      expect(rows[0].lifecycle).toBe("inactive");
    });
  });

  test("a contract moving between tenants resyncs BOTH tenants", async () => {
    // Resolving only coalesce(old.tenant_id, new.tenant_id) would leave the
    // origin tenant still claiming a contract it no longer holds.
    await withRollback(async (client) => {
      const from = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const to = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      // Strip `to` back to contractless so the move is observable on both sides.
      await client.query(`delete from public.contracts where id = $1`, [to.contractId]);
      expect(await lifecycleOf(client, to.tenantId)).toBe("inactive");

      await client.query(`update public.contracts set tenant_id = $1 where id = $2`, [
        to.tenantId,
        from.contractId,
      ]);

      expect(await lifecycleOf(client, from.tenantId)).toBe("inactive");
      expect(await lifecycleOf(client, to.tenantId)).toBe("active");
    });
  });
});

describe("blocked is the one sticky state", () => {
  test("blocked survives an insert, an update and a delete of contracts", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`update public.tenants set lifecycle = 'blocked' where id = $1`, [
        tenantId,
      ]);

      await client.query(`update public.contracts set state = 'expired' where id = $1`, [
        contractId,
      ]);
      expect(await lifecycleOf(client, tenantId)).toBe("blocked");

      // contracts.unit_id is gone (migration 118); the original contract's
      // unit now lives on contract_units.
      const originalUnit = await client.query<{ unit_id: string }>(
        `select unit_id from public.contract_units
          where contract_id = $1 order by line_order limit 1`,
        [contractId],
      );
      const second = await client.query<{ id: string }>(
        `insert into public.contracts
           (code, tenant_id, start_date, end_date, monthly_amount, state)
         select 'C2-' || substr($1::text, 1, 8), tenant_id,
                '2027-01-01'::date, '2027-12-31'::date, 500, 'active'
           from public.contracts where id = $2
         returning id`,
        [randomUUID(), contractId],
      );
      // Migration 114: keep contract_units in sync with the copied contract
      // above — a contract with no contract_units row now reads as unitless
      // to close-out/restore and the electricity trigger.
      await client.query(
        `insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
         values ($1, $2, 500, 1)`,
        [second.rows[0].id, originalUnit.rows[0].unit_id],
      );
      expect(await lifecycleOf(client, tenantId)).toBe("blocked");

      await client.query(`delete from public.contracts where tenant_id = $1`, [tenantId]);
      expect(await lifecycleOf(client, tenantId)).toBe("blocked");
    });
  });

  test("a tenant inserted as blocked stays blocked", async () => {
    await withRollback(async (client) => {
      const company = await client.query<{ id: string }>(
        `insert into public.companies (name_ar, name_en) values ('ش', 'C') returning id`,
      );
      const tag = randomUUID().slice(0, 8);
      const { rows } = await client.query<{ lifecycle: string }>(
        `insert into public.tenants (code, company_id, name, lifecycle)
         values ($1, $2, $3, 'blocked') returning lifecycle`,
        [`T-${tag}`, company.rows[0].id, `مستأجر ${tag}`],
      );
      expect(rows[0].lifecycle).toBe("blocked");
    });
  });
});

describe("the sync survives RLS", () => {
  test("a user with contracts.update but NOT tenants.update still syncs lifecycle", async () => {
    // THE discriminating test for the `security definer` decision.
    //
    // A blocked UPDATE under RLS affects zero rows and does NOT raise. Without
    // definer rights the contract save below would succeed, this user would see
    // no error, and lifecycle would quietly stop tracking reality for them.
    // Every other test in this file passes either way, because they run as
    // superuser.
    //
    // No shipped role has this permission combination — accountant holds
    // contracts.read but not contracts.update (03_phase1:296-311) — so the test
    // constructs it. The transaction is rolled back.
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const accountant = await seedUserWithRole(client, "accountant");
      await client.query(
        `insert into public.role_permissions (role, permission_code)
         values ('accountant', 'contracts.update')
         on conflict do nothing`,
      );

      await actAs(client, "authenticated", accountant);

      // Guard: if the contract write itself is blocked, the assertion below
      // would pass for the wrong reason.
      const updated = await client.query(
        `update public.contracts set state = 'expired' where id = $1 returning id`,
        [contractId],
      );
      expect(updated.rows).toHaveLength(1);

      // And confirm this user genuinely cannot write tenants directly.
      const direct = await client.query(
        `update public.tenants set lifecycle = 'active' where id = $1 returning id`,
        [tenantId],
      );
      expect(direct.rows).toHaveLength(0);

      await actAsSuperuser(client);
      expect(await lifecycleOf(client, tenantId)).toBe("contract_ended");
    });
  });
});

describe("set_tenant_blocked", () => {
  test("an admin can block and unblock, and unblocking recomputes", async () => {
    await withRollback(async (client) => {
      const { tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      await client.query(`select public.set_tenant_blocked($1, true)`, [tenantId]);
      expect(await lifecycleOf(client, tenantId)).toBe("blocked");

      // Unblocking must recompute, not write 'active' blindly — this tenant has
      // an active contract so it lands on 'active' via the rule, and a
      // contractless tenant would land on 'inactive'.
      await client.query(`select public.set_tenant_blocked($1, false)`, [tenantId]);
      expect(await lifecycleOf(client, tenantId)).toBe("active");
    });
  });

  test("unblocking a contractless tenant lands on inactive, not active", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`delete from public.contracts where id = $1`, [contractId]);
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      await client.query(`select public.set_tenant_blocked($1, true)`, [tenantId]);
      await client.query(`select public.set_tenant_blocked($1, false)`, [tenantId]);
      expect(await lifecycleOf(client, tenantId)).toBe("inactive");
    });
  });

  test("a user without tenants.update is refused", async () => {
    await withRollback(async (client) => {
      const { tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const collector = await seedUserWithRole(client, "collector");
      await actAs(client, "authenticated", collector);

      await expect(
        client.query(`select public.set_tenant_blocked($1, true)`, [tenantId]),
      ).rejects.toThrow(/not authorized/i);
    });
  });
});

describe("backfill", () => {
  test("recomputing every tenant twice is idempotent", async () => {
    await withRollback(async (client) => {
      const { tenantId: activeTenant } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const ended = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "terminated",
      });
      const blocked = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`update public.tenants set lifecycle = 'blocked' where id = $1`, [
        blocked.tenantId,
      ]);

      const backfill = `update public.tenants t
           set lifecycle = public.compute_tenant_lifecycle(t.id, t.lifecycle)
         where t.lifecycle is distinct from public.compute_tenant_lifecycle(t.id, t.lifecycle)`;

      await client.query(backfill);
      const first = await client.query<{ id: string; lifecycle: string }>(
        `select id, lifecycle from public.tenants order by id`,
      );
      const second = await client.query(backfill);
      expect(second.rowCount).toBe(0);

      const after = await client.query<{ id: string; lifecycle: string }>(
        `select id, lifecycle from public.tenants order by id`,
      );
      expect(after.rows).toEqual(first.rows);

      expect(await lifecycleOf(client, activeTenant)).toBe("active");
      expect(await lifecycleOf(client, ended.tenantId)).toBe("contract_ended");
      expect(await lifecycleOf(client, blocked.tenantId)).toBe("blocked");
    });
  });
});

describe("units.name_en", () => {
  test("is nullable and round-trips", async () => {
    await withRollback(async (client) => {
      const { unitId, propertyId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const bare = await client.query<{ name_en: string | null }>(
        `select name_en from public.units where id = $1`,
        [unitId],
      );
      expect(bare.rows[0].name_en).toBeNull();

      const tag = randomUUID().slice(0, 8);
      const { rows } = await client.query<{ name: string; name_en: string | null }>(
        `insert into public.units (code, property_id, name, name_en)
         values ($1, $2, 'وحدة', 'Unit A') returning name, name_en`,
        [`U2-${tag}`, propertyId],
      );
      expect(rows[0].name).toBe("وحدة");
      expect(rows[0].name_en).toBe("Unit A");
    });
  });
});
