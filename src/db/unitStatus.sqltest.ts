import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

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
 * seeds. None of this is reachable from the mock suite — the whole feature is
 * two triggers.
 */

async function statusOf(client: PoolClient, unitId: string): Promise<string> {
  const { rows } = await client.query<{ status: string }>(
    `select status from public.units where id = $1`,
    [unitId],
  );
  return rows[0].status;
}

/** An auth user holding `role`, so has_permission resolves for it. Same shape
 *  as the helper in src/db/lifecycle.sqltest.ts. */
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
      await client.query(`update public.contract_units set unit_id = $1 where contract_id = $2`, [
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

describe("the sync survives RLS", () => {
  test("a user with contracts.update but NOT units.update still syncs status", async () => {
    // THE discriminating test for the `security definer` decision, shaped after
    // the equivalent for tenants in src/db/lifecycle.sqltest.ts.
    //
    // A blocked UPDATE under RLS affects zero rows and does NOT raise. Without
    // definer rights the contract save below would succeed, the user would see
    // no error, and occupancy would quietly stop tracking reality for them.
    // Every other test in this file passes either way — they all run as owner.
    //
    // No shipped role has this permission combination: accountant holds
    // contracts.read and units.read but neither update, and admin holds both
    // updates. So the test constructs the combination and rolls it back.
    await withRollback(async (client) => {
      const { unitId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "draft",
      });
      const accountant = await seedUserWithRole(client, "accountant");
      await client.query(
        `insert into public.role_permissions (role, permission_code)
         values ('accountant', 'contracts.update')
         on conflict do nothing`,
      );

      // actAs takes the POSTGRES role; the app role is carried by the seeded
      // user's user_roles row.
      await actAs(client, "authenticated", accountant);

      // Guard: if the contract write itself were blocked, the assertion at the
      // end would pass for the wrong reason. An earlier version of this test
      // omitted the grant above and failed here, which is the only reason the
      // vacuous-pass trap was noticed at all.
      const updated = await client.query(
        `update public.contracts set state = 'active' where id = $1 returning id`,
        [contractId],
      );
      expect(updated.rows).toHaveLength(1);

      // And confirm this user genuinely cannot write units directly, so the
      // sync below can only have come from the definer function.
      const direct = await client.query(
        `update public.units set name = 'Direct write' where id = $1 returning id`,
        [unitId],
      );
      expect(direct.rows).toHaveLength(0);

      await actAsSuperuser(client);
      expect(await statusOf(client, unitId)).toBe("occupied");
    });
  });
});

describe("the units guard normalises what callers ask for", () => {
  test.each(["available", "reserved"])(
    "inserting a unit as the retired %s lands it vacant",
    async (retired) => {
      await withRollback(async (client) => {
        const unitId = await seedBareUnit(client, retired);
        expect(await statusOf(client, unitId)).toBe("vacant");
      });
    },
  );

  test("claiming occupied without a contract lands vacant", async () => {
    // A different branch from the retired pair above: this one is not a rename
    // of a dead value, it is a caller asserting occupancy the contracts do not
    // support.
    await withRollback(async (client) => {
      const unitId = await seedBareUnit(client, "occupied");
      expect(await statusOf(client, unitId)).toBe("vacant");
    });
  });

  test("a new unit defaults to vacant", async () => {
    // Deliberately kept alongside `the column default is vacant`, which reads
    // information_schema. This one would still pass with the old 'available'
    // default, because the guard would coerce it — so only the schema test pins
    // the default itself, and only this one proves the observable outcome.
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
    // bulk_import_phase6 still hardcodes 'available' for units. The BEFORE
    // INSERT guard is what makes that harmless. Migration 78 does now re-issue
    // the function to add a contracts branch, but it carries the units branch
    // across verbatim — this asserts that stayed true.
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

describe("the invariant holds across the whole table", () => {
  // These assert on the WHOLE table, which the harness note at
  // src/db/testDb.ts warns against — the database is not empty at rest and
  // assertions are normally scoped to the fixtures a test created. The
  // exception is deliberate: their entire purpose is to check the backfill
  // against rows migrations 11, 15 and 19 seeded long before migration 76
  // existed, which a fixture-scoped test cannot see. The suite is
  // single-threaded (vitest.sql.config.ts) and every other test rolls back, so
  // no concurrent fixture can perturb them.
  test("no unit disagrees with its contracts", async () => {
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
});

describe("the migration is safe to re-run", () => {
  // Migration 76 itself dropped out of this test in migration 118: 76's
  // Section 7 backfill (76:310-319) calls `compute_unit_status`, which calls
  // `unit_has_active_contract` — and replaying 76's own file text recreates
  // that function with its ORIGINAL body (`where c.unit_id = _unit`), because
  // create-or-replace has no notion of regressing a later definition. Once
  // migration 118 drops `contracts.unit_id`, that recreated body fails at
  // that same backfill statement with "column c.unit_id does not exist" —
  // before 111 (or anything else) ever gets a chance to fix it back up.
  // Nothing in this database's actual migration order ever replays 76 in
  // isolation this late, so this is the same accepted "not every migration
  // stays re-runnable forever" exception scripts/test-db.sh already documents
  // for `identify_contract_expiry_reminders`, not a regression to chase.
  //
  // 111_unit_occupancy_multi_unit.sql is what actually stays live and
  // re-runnable: it explicitly supersedes "the occupancy half of 76" —
  // `unit_has_active_contract` plus the contracts-side trigger — moving both
  // onto `contract_units`, and it has no backfill of its own to trip over a
  // dropped column. That is what this test now replays and checks.
  test("111_unit_occupancy_multi_unit.sql applies a second time cleanly, with no orphaned occupancy", async () => {
    // Asserted, not assumed. Reads the file from disk so it cannot drift from
    // what ships.
    await withRollback(async (client) => {
      const sql = await readFile("db/migrations/111_unit_occupancy_multi_unit.sql", "utf8");
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
