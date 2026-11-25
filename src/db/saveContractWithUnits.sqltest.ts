import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import {
  actAs,
  actAsSuperuser,
  captureRaise,
  captureRaiseError,
  closePool,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 117 — `save_contract_with_units`, the RPC that finally lets
 * application code write `contract_units`. Before this, a contract created
 * through the admin form got zero unit rows and the invoice generator
 * silently billed nothing for it.
 *
 * Real SQL against a real Postgres built from db/migrations, same approach as
 * contractCloseout.sqltest.ts.
 */

interface Fixture {
  companyId: string;
  propertyId: string;
  tenantId: string;
  unitIds: string[];
}

/** company -> property -> N units -> tenant, WITHOUT a pre-existing contract
 *  — save_contract_with_units is what creates the contract here. */
async function seedFixture(client: PoolClient, unitCount = 2): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const company = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة اختبار ${tag}`, `Test Co ${tag}`],
  );
  const companyId = company.rows[0].id;

  const property = await client.query<{ id: string }>(
    `insert into public.properties (code, company_id, name_ar, name_en)
     values ($1, $2, $3, $4) returning id`,
    [`P-${tag}`, companyId, `عقار ${tag}`, `Property ${tag}`],
  );
  const propertyId = property.rows[0].id;

  const unitIds: string[] = [];
  for (let index = 0; index < unitCount; index += 1) {
    const unit = await client.query<{ id: string }>(
      `insert into public.units (code, property_id, name) values ($1, $2, $3) returning id`,
      [`U-${tag}-${index}`, propertyId, `Unit ${tag}-${index}`],
    );
    unitIds.push(unit.rows[0].id);
  }

  const tenant = await client.query<{ id: string }>(
    `insert into public.tenants (code, company_id, name, lifecycle)
     values ($1, $2, $3, 'active'::public.tenant_lifecycle) returning id`,
    [`T-${tag}`, companyId, `مستأجر ${tag}`],
  );
  const tenantId = tenant.rows[0].id;

  return { companyId, propertyId, tenantId, unitIds };
}

async function seedAdmin(client: PoolClient): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@example.test`],
  );
  await client.query(
    `insert into public.user_roles (user_id, role) values ($1, 'admin'::public.app_role)`,
    [userId],
  );
  await client.query(
    `insert into public.profiles (id, email, display_name, is_active)
     values ($1, $2, 'Save Contract Admin', true)
     on conflict (id) do nothing`,
    [userId, `${userId}@example.test`],
  );
  return userId;
}

/**
 * A user holding `contracts.update` and nothing else.
 *
 * Granted through a custom role (migration 16) rather than an `app_role`,
 * because `has_permission` short-circuits on `has_role(admin)` and no built-in
 * role splits create from update the way this test needs.
 */
async function seedUpdateOnlyUser(client: PoolClient): Promise<string> {
  const userId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@example.test`],
  );
  await client.query(
    `insert into public.profiles (id, email, display_name, is_active)
     values ($1, $2, 'Update Only', true) on conflict (id) do nothing`,
    [userId, `${userId}@example.test`],
  );
  const role = await client.query<{ id: string }>(
    `insert into public.custom_roles (code, name_ar, name_en)
     values ($1, $2, $3) returning id`,
    [`updater-${tag}`, `محدّث ${tag}`, `Updater ${tag}`],
  );
  await client.query(
    `insert into public.custom_role_permissions (custom_role_id, permission_code)
     values ($1, 'contracts.update')`,
    [role.rows[0].id],
  );
  await client.query(
    `insert into public.user_custom_roles (user_id, custom_role_id) values ($1, $2)`,
    [userId, role.rows[0].id],
  );
  return userId;
}

function contractPayload(tenantId: string, overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: tenantId,
    type: "investment",
    state: "active",
    commercial_activity: null,
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    duration_months: 12,
    end_date_override_reason: null,
    due_day: 1,
    grace_days: 0,
    deposit: 0,
    notes: null,
    ...overrides,
  };
}

async function saveContractWithUnits(
  client: PoolClient,
  args: {
    contract: Record<string, unknown>;
    units: Array<{ unit_id: string; monthly_amount: number }>;
    contractId?: string | null;
  },
) {
  // `from fn(...) as c`, NOT `select (fn(...)).* `: the latter is a documented
  // Postgres gotcha — expanding a composite-returning function's columns with
  // `.*` in the target list can re-evaluate the function once per referenced
  // column. For a volatile function this means the RPC actually runs TWICE,
  // which surfaced here as a duplicate-key error on the second, independent
  // contract it created. Verified against this exact function with
  // RAISE NOTICE tracing before landing this fix — `from fn() as c` calls it
  // exactly once. This is a test-harness-only concern: PostgREST (what the
  // browser client actually goes through) calls RPCs the safe way already.
  const { rows } = await client.query(
    `select c.* from public.save_contract_with_units($1::jsonb, $2::jsonb, $3::uuid) as c`,
    [JSON.stringify(args.contract), JSON.stringify(args.units), args.contractId ?? null],
  );
  return rows[0];
}

describe("save_contract_with_units — create", () => {
  test("creates the contract AND its contract_units rows in one call", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client, 2);
      const admin = await seedAdmin(client);
      await actAs(client, "authenticated", admin);

      const result = await saveContractWithUnits(client, {
        contract: contractPayload(fixture.tenantId),
        units: [
          { unit_id: fixture.unitIds[0], monthly_amount: 400 },
          { unit_id: fixture.unitIds[1], monthly_amount: 350 },
        ],
      });

      expect(result.id).toBeTruthy();
      expect(result.tenant_id).toBe(fixture.tenantId);
      // Trigger-maintained total (migration 110) — never written directly.
      expect(Number(result.monthly_amount)).toBe(750);

      await actAsSuperuser(client);
      const units = await client.query(
        `select unit_id, monthly_amount, line_order from public.contract_units
          where contract_id = $1 order by line_order`,
        [result.id],
      );
      expect(
        units.rows.map((row) => ({ ...row, monthly_amount: Number(row.monthly_amount) })),
      ).toEqual([
        { unit_id: fixture.unitIds[0], monthly_amount: 400, line_order: 1 },
        { unit_id: fixture.unitIds[1], monthly_amount: 350, line_order: 2 },
      ]);
    });
  });

  test("an omitted grace_days falls back to one day, and an explicit zero is kept (migration 249)", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client, 2);
      const admin = await seedAdmin(client);
      await actAs(client, "authenticated", admin);

      const withoutGrace = Object.fromEntries(
        Object.entries(contractPayload(fixture.tenantId)).filter(([key]) => key !== "grace_days"),
      );
      const defaulted = await saveContractWithUnits(client, {
        contract: withoutGrace,
        units: [{ unit_id: fixture.unitIds[0], monthly_amount: 400 }],
      });
      const explicitZero = await saveContractWithUnits(client, {
        contract: contractPayload(fixture.tenantId, { grace_days: 0 }),
        units: [{ unit_id: fixture.unitIds[1], monthly_amount: 400 }],
      });

      expect(defaulted.grace_days).toBe(1);
      expect(explicitZero.grace_days).toBe(0);
    });
  });

  test("persists end_date_override_reason on create (correction 3 — the brief's column list omitted it)", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client, 1);
      const admin = await seedAdmin(client);
      await actAs(client, "authenticated", admin);

      const result = await saveContractWithUnits(client, {
        contract: contractPayload(fixture.tenantId, {
          end_date: "2026-11-30",
          end_date_override_reason: "Operator moved the end date up",
        }),
        units: [{ unit_id: fixture.unitIds[0], monthly_amount: 400 }],
      });

      expect(result.end_date_override_reason).toBe("Operator moved the end date up");
    });
  });

  test("refuses to create a contract with zero units, leaving no contracts row behind", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client, 1);
      const admin = await seedAdmin(client);
      await actAs(client, "authenticated", admin);

      const before = await client.query(`select count(*)::int n from public.contracts`);

      const message = await captureRaise(client, () =>
        saveContractWithUnits(client, { contract: contractPayload(fixture.tenantId), units: [] }),
      );
      expect(message).toMatch(/at least one unit/);

      await actAsSuperuser(client);
      const after = await client.query(`select count(*)::int n from public.contracts`);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });
  });

  test("a user without contracts.update is refused (SQLSTATE 42501)", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client, 1);
      const readonlyUser = randomUUID();
      await client.query(
        `insert into auth.users (id, instance_id, aud, role, email)
         values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
        [readonlyUser, `${readonlyUser}@example.test`],
      );
      await client.query(
        `insert into public.user_roles (user_id, role) values ($1, 'readonly'::public.app_role)`,
        [readonlyUser],
      );
      await actAs(client, "authenticated", readonlyUser);

      const message = await captureRaise(client, () =>
        saveContractWithUnits(client, {
          contract: contractPayload(fixture.tenantId),
          units: [{ unit_id: fixture.unitIds[0], monthly_amount: 400 }],
        }),
      );
      expect(message).toMatch(/Permission denied/);
    });
  });

  test("anon cannot call save_contract_with_units at all (SQLSTATE 42501)", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client, 1);
      await actAs(client, "anon");
      // captureRaiseError, not `.rejects`: a bare throw aborts the whole
      // transaction, so every statement after it — including any assertion
      // appended below — fails with "current transaction is aborted". The
      // savepoint confines the abort. The SQLSTATE assertion is unchanged;
      // captureRaise would have downgraded it to a message match.
      const error = await captureRaiseError(client, () =>
        client.query(`select public.save_contract_with_units($1::jsonb, $2::jsonb, null::uuid)`, [
          JSON.stringify(contractPayload(fixture.tenantId)),
          JSON.stringify([{ unit_id: fixture.unitIds[0], monthly_amount: 400 }]),
        ]),
      );
      expect(error).toMatchObject({ code: "42501" });

      await actAsSuperuser(client);
      const contracts = await client.query(
        `select count(*)::int n from public.contracts where tenant_id = $1`,
        [fixture.tenantId],
      );
      expect(contracts.rows[0].n).toBe(0);
    });
  });

  /**
   * Final review I3. Both branches of the RPC checked `contracts.update`, so a
   * user holding update but not create could create contracts. The function is
   * SECURITY DEFINER, so `contracts_insert_permitted` (04:269-284) never runs
   * as a backstop, and the client-side split in useContractMutations.ts is a UI nicety
   * — this RPC is directly callable over PostgREST.
   */
  test("contracts.update alone cannot create a contract, but can still update one", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client, 2);
      const admin = await seedAdmin(client);
      const updater = await seedUpdateOnlyUser(client);

      await actAs(client, "authenticated", admin);
      const created = await saveContractWithUnits(client, {
        contract: contractPayload(fixture.tenantId),
        units: [{ unit_id: fixture.unitIds[0], monthly_amount: 400 }],
      });

      await actAs(client, "authenticated", updater);
      const refused = await captureRaise(client, () =>
        saveContractWithUnits(client, {
          contract: contractPayload(fixture.tenantId),
          units: [{ unit_id: fixture.unitIds[1], monthly_amount: 400 }],
        }),
      );
      // captureRaise returns null when nothing raised — i.e. when the create
      // silently succeeded, which is the defect.
      expect(refused, "an update-only user must not be able to CREATE a contract").toMatch(
        /Permission denied/,
      );

      // The same user must still be able to edit an existing contract —
      // the fix narrows create, it does not narrow update.
      const updated = await saveContractWithUnits(client, {
        contractId: created.id,
        contract: contractPayload(fixture.tenantId),
        units: [{ unit_id: fixture.unitIds[0], monthly_amount: 650 }],
      });
      expect(Number(updated.monthly_amount)).toBe(650);

      await actAsSuperuser(client);
      const contracts = await client.query(
        `select count(*)::int n from public.contracts where tenant_id = $1`,
        [fixture.tenantId],
      );
      expect(contracts.rows[0].n).toBe(1);
    });
  });
});

describe("save_contract_with_units — update", () => {
  test("adds, keeps, and drops units to match the new selection", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client, 3);
      const admin = await seedAdmin(client);
      await actAs(client, "authenticated", admin);

      const created = await saveContractWithUnits(client, {
        contract: contractPayload(fixture.tenantId),
        units: [
          { unit_id: fixture.unitIds[0], monthly_amount: 400 },
          { unit_id: fixture.unitIds[1], monthly_amount: 350 },
        ],
      });

      // Drop unit 0, keep unit 1 (new amount), add unit 2.
      const updated = await saveContractWithUnits(client, {
        contractId: created.id,
        contract: contractPayload(fixture.tenantId),
        units: [
          { unit_id: fixture.unitIds[1], monthly_amount: 500 },
          { unit_id: fixture.unitIds[2], monthly_amount: 300 },
        ],
      });

      expect(Number(updated.monthly_amount)).toBe(800);

      await actAsSuperuser(client);
      const units = await client.query(
        `select unit_id, monthly_amount, line_order from public.contract_units
          where contract_id = $1 order by line_order`,
        [created.id],
      );
      expect(
        units.rows.map((row) => ({ ...row, monthly_amount: Number(row.monthly_amount) })),
      ).toEqual([
        { unit_id: fixture.unitIds[1], monthly_amount: 500, line_order: 1 },
        { unit_id: fixture.unitIds[2], monthly_amount: 300, line_order: 2 },
      ]);
    });
  });

  test("clears end_date_override_reason on update — a stale value must not survive turning the override off", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client, 1);
      const admin = await seedAdmin(client);
      await actAs(client, "authenticated", admin);

      const created = await saveContractWithUnits(client, {
        contract: contractPayload(fixture.tenantId, {
          end_date: "2026-11-30",
          end_date_override_reason: "Initial override",
        }),
        units: [{ unit_id: fixture.unitIds[0], monthly_amount: 400 }],
      });
      expect(created.end_date_override_reason).toBe("Initial override");

      const updated = await saveContractWithUnits(client, {
        contractId: created.id,
        contract: contractPayload(fixture.tenantId, {
          end_date: "2026-12-31",
          end_date_override_reason: null,
        }),
        units: [{ unit_id: fixture.unitIds[0], monthly_amount: 400 }],
      });
      expect(updated.end_date_override_reason).toBeNull();
    });
  });

  test("refuses to update down to zero units", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client, 1);
      const admin = await seedAdmin(client);
      await actAs(client, "authenticated", admin);

      const created = await saveContractWithUnits(client, {
        contract: contractPayload(fixture.tenantId),
        units: [{ unit_id: fixture.unitIds[0], monthly_amount: 400 }],
      });

      const message = await captureRaise(client, () =>
        saveContractWithUnits(client, {
          contractId: created.id,
          contract: contractPayload(fixture.tenantId),
          units: [],
        }),
      );
      expect(message).toMatch(/at least one unit/);

      await actAsSuperuser(client);
      const units = await client.query(
        `select count(*)::int n from public.contract_units where contract_id = $1`,
        [created.id],
      );
      // Untouched — the raise happens before any contract_units mutation.
      expect(units.rows[0].n).toBe(1);
    });
  });

  /**
   * Final review M6. The prune used
   * `unit_id not in (select (u->>'unit_id')::uuid ...)`. One element without a
   * `unit_id` made the subquery yield NULL, `NOT IN` evaluated to NULL for
   * every row, and nothing was pruned; the insert loop then failed the NOT NULL
   * on `contract_units.unit_id`, so the caller saw a message about a column it
   * never named. Migration 119 validates the payload shape first and rewrites
   * the prune as a NULL-safe `not exists`.
   */
  test("names the real problem when a unit entry has no unit_id", async () => {
    await withRollback(async (client) => {
      const fixture = await seedFixture(client, 2);
      const admin = await seedAdmin(client);
      await actAs(client, "authenticated", admin);

      const created = await saveContractWithUnits(client, {
        contract: contractPayload(fixture.tenantId),
        units: [{ unit_id: fixture.unitIds[0], monthly_amount: 400 }],
      });

      const message = await captureRaise(client, () =>
        client.query(
          `select c.* from public.save_contract_with_units($1::jsonb, $2::jsonb, $3::uuid) as c`,
          [
            JSON.stringify(contractPayload(fixture.tenantId)),
            JSON.stringify([{ monthly_amount: 400 }, { unit_id: fixture.unitIds[1] }]),
            created.id,
          ],
        ),
      );
      expect(message).toMatch(/must carry a unit_id/);

      await actAsSuperuser(client);
      const units = await client.query(
        `select unit_id from public.contract_units where contract_id = $1`,
        [created.id],
      );
      expect(units.rows.map((row) => row.unit_id)).toEqual([fixture.unitIds[0]]);
    });
  });
});
