import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { actAs, actAsSuperuser, captureRaiseError, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 239 — `rename_option_list_value` plus the value guard trigger.
 *
 * `units.type` stores the list value as free text with no FK, so a rename in
 * the catalogue must cascade to every storing column in one transaction, and a
 * direct PATCH of `value` must be refused so old browser bundles cannot
 * re-orphan rows the way the 2026-09-26 Roof_Apartment edit did.
 */

/** ينشئ مستخدماً بدور معين حتى تُحسم `has_permission` لصالحه. */
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

interface RenameProbe {
  itemId: string;
  value: string;
  unitIds: string[];
}

/**
 * يزرع عنصر `unit_types` بقيمة فريدة ووحدتين تخزنانها.
 *
 * Each test builds its own probe inside its own rollback: the value is uuid
 * suffixed so the UNIQUE(list_id, value) constraint can never collide with
 * another test's probe or with seed data.
 */
async function seedRenameProbe(client: PoolClient): Promise<RenameProbe> {
  const tag = randomUUID().slice(0, 8);
  const value = `probe_${tag}`;
  const { rows: lists } = await client.query<{ id: string }>(
    `select id from public.option_lists where code = 'unit_types'`,
  );
  const { rows: items } = await client.query<{ id: string }>(
    `insert into public.option_list_items (list_id, value, label_ar, label_en)
     values ($1, $2, $3, $4) returning id`,
    [lists[0].id, value, `اختبار ${tag}`, `Probe ${tag}`],
  );
  const company = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة ${tag}`, `Co ${tag}`],
  );
  const property = await client.query<{ id: string }>(
    `insert into public.properties (code, company_id, name_ar, name_en)
     values ($1, $2, $3, $4) returning id`,
    [`P-${tag}`, company.rows[0].id, `عقار ${tag}`, `Property ${tag}`],
  );
  const unitIds: string[] = [];
  for (const suffix of ["a", "b"]) {
    const { rows: units } = await client.query<{ id: string }>(
      `insert into public.units (code, property_id, name, type)
       values ($1, $2, $3, $4) returning id`,
      [`U-${tag}-${suffix}`, property.rows[0].id, `Unit ${tag} ${suffix}`, value],
    );
    unitIds.push(units[0].id);
  }
  return { itemId: items[0].id, value, unitIds };
}

/** يعيد قيمة عنصر القائمة من قاعدة البيانات. */
async function itemValueOf(client: PoolClient, itemId: string): Promise<string> {
  const { rows } = await client.query<{ value: string }>(
    `select value from public.option_list_items where id = $1`,
    [itemId],
  );
  return rows[0].value;
}

/** يعيد نوع الوحدة المخزن كنص حر. */
async function unitTypeOf(client: PoolClient, unitId: string): Promise<string> {
  const { rows } = await client.query<{ type: string }>(
    `select type from public.units where id = $1`,
    [unitId],
  );
  return rows[0].type;
}

/** يعيد معرّف عنصر مزروع في قائمة معروفة. */
async function seededItemId(client: PoolClient, listCode: string, value: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `select i.id
       from public.option_list_items i
       join public.option_lists l on l.id = i.list_id
      where l.code = $1 and i.value = $2`,
    [listCode, value],
  );
  return rows[0].id;
}

describe("rename cascades to every storing column", () => {
  test("(a) admin renames a unit_types value used by two units", async () => {
    await withRollback(async (client) => {
      // probe_ values are unbound (not in UNIT_FLOOR_TYPE_BINDING), so (a)
      // exercises the unbound rename path.
      const probe = await seedRenameProbe(client);
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const { rows } = await client.query<{ rename_option_list_value: unknown }>(
        `select public.rename_option_list_value($1, $2) as rename_option_list_value`,
        [probe.itemId, "probe_renamed"],
      );
      expect(rows[0].rename_option_list_value).toEqual({ updated: { "units.type": 2 } });

      await actAsSuperuser(client);
      expect(await itemValueOf(client, probe.itemId)).toBe("probe_renamed");
      expect(await unitTypeOf(client, probe.unitIds[0])).toBe("probe_renamed");
      expect(await unitTypeOf(client, probe.unitIds[1])).toBe("probe_renamed");

      const { rows: audits } = await client.query<{
        action: string;
        before: { value: string };
        after: { value: string; updated: { "units.type": number } };
      }>(
        `select action, before, after from public.audit_logs
          where action = 'option_list_item.rename_value' and entity_id = $1`,
        [probe.itemId],
      );
      expect(audits).toHaveLength(1);
      expect(audits[0].before.value).toBe(probe.value);
      expect(audits[0].after.value).toBe("probe_renamed");
      expect(audits[0].after.updated).toEqual({ "units.type": 2 });
    });
  });

  test("(b) a user without settings.lists gets 42501 and nothing changes", async () => {
    await withRollback(async (client) => {
      const probe = await seedRenameProbe(client);
      // Accountant holds reports.read and invoices.read but not settings.lists,
      // so the denial below can only come from the permission check.
      const accountant = await seedUserWithRole(client, "accountant");
      await actAs(client, "authenticated", accountant);

      const error = (await captureRaiseError(client, () =>
        client.query(`select public.rename_option_list_value($1, $2)`, [
          probe.itemId,
          "probe_blocked",
        ]),
      )) as { code?: string } | null;
      expect(error?.code).toBe("42501");

      await actAsSuperuser(client);
      expect(await itemValueOf(client, probe.itemId)).toBe(probe.value);
      expect(await unitTypeOf(client, probe.unitIds[0])).toBe(probe.value);
      const { rows: audits } = await client.query(
        `select id from public.audit_logs
          where action = 'option_list_item.rename_value' and entity_id = $1`,
        [probe.itemId],
      );
      expect(audits).toHaveLength(0);
    });
  });

  test("(c) renaming to a value already in the list raises 23505", async () => {
    await withRollback(async (client) => {
      const probe = await seedRenameProbe(client);
      const { rows: lists } = await client.query<{ id: string }>(
        `select id from public.option_lists where code = 'unit_types'`,
      );
      await client.query(
        `insert into public.option_list_items (list_id, value, label_ar, label_en)
         values ($1, 'probe_taken', 'محجوز', 'Taken')`,
        [lists[0].id],
      );
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const error = (await captureRaiseError(client, () =>
        client.query(`select public.rename_option_list_value($1, $2)`, [
          probe.itemId,
          "probe_taken",
        ]),
      )) as { code?: string } | null;
      expect(error?.code).toBe("23505");

      await actAsSuperuser(client);
      expect(await itemValueOf(client, probe.itemId)).toBe(probe.value);
    });
  });

  test.each([
    ["unit_statuses", "occupied"],
    ["tenant_categories", "standard"],
    ["tenant_lifecycles", "active"],
  ])("(d) enum-backed list %s rejects the rename with 22023", async (listCode, value) => {
    // tenant_lifecycles backs the tenants.lifecycle enum (migration 04) even
    // though the TS enum module omits it — the migration rejects it anyway.
    await withRollback(async (client) => {
      const itemId = await seededItemId(client, listCode, value);
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const error = (await captureRaiseError(client, () =>
        client.query(`select public.rename_option_list_value($1, $2)`, [itemId, "probe_new"]),
      )) as { code?: string } | null;
      expect(error?.code).toBe("22023");

      await actAsSuperuser(client);
      expect(await itemValueOf(client, itemId)).toBe(value);
    });
  });

  test("(d2) a direct value update raises 42501 but label edits still succeed", async () => {
    await withRollback(async (client) => {
      const probe = await seedRenameProbe(client);
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const error = (await captureRaiseError(client, () =>
        client.query(`update public.option_list_items set value = 'probe_direct' where id = $1`, [
          probe.itemId,
        ]),
      )) as { code?: string } | null;
      expect(error?.code).toBe("42501");

      // The guard fires only on `value`: labels, ordering and flags keep the
      // direct path old bundles and the metadata phase rely on.
      await client.query(
        `update public.option_list_items
            set label_ar = 'اسم جديد', sort_order = 7, is_active = false
          where id = $1`,
        [probe.itemId],
      );
      await actAsSuperuser(client);
      expect(await itemValueOf(client, probe.itemId)).toBe(probe.value);
      const { rows } = await client.query<{
        label_ar: string;
        sort_order: number;
        is_active: boolean;
      }>(
        `select label_ar, sort_order, is_active
           from public.option_list_items where id = $1`,
        [probe.itemId],
      );
      expect(rows[0].label_ar).toBe("اسم جديد");
      expect(rows[0].sort_order).toBe(7);
      expect(rows[0].is_active).toBe(false);
    });
  });

  test("(e) count returns the same counts without changing anything", async () => {
    await withRollback(async (client) => {
      const probe = await seedRenameProbe(client);
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const { rows } = await client.query<{ count_option_list_value_usage: unknown }>(
        `select public.count_option_list_value_usage($1) as count_option_list_value_usage`,
        [probe.itemId],
      );
      expect(rows[0].count_option_list_value_usage).toEqual({ "units.type": 2 });

      await actAsSuperuser(client);
      expect(await itemValueOf(client, probe.itemId)).toBe(probe.value);
      expect(await unitTypeOf(client, probe.unitIds[0])).toBe(probe.value);
      expect(await unitTypeOf(client, probe.unitIds[1])).toBe(probe.value);
    });
  });

  test("(f) no unit still carries the orphaned Roof_Apartment value", async () => {
    // Whole-table by design: the repair backfilled seed rows this fixture
    // cannot see, so only a global count proves the orphaning is gone.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ bad: string }>(
        `select count(*)::text as bad from public.units where type = 'Roof_Apartment'`,
      );
      expect(rows[0].bad).toBe("0");
    });
  });

  test("(f) managemental-services exists as an active unit_types item", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ is_active: boolean; label_ar: string }>(
        `select i.is_active, i.label_ar
           from public.option_list_items i
           join public.option_lists l on l.id = i.list_id
          where l.code = 'unit_types' and i.value = 'managemental-services'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].is_active).toBe(true);
      expect(rows[0].label_ar).toBe("خدمات إدارية");
    });
  });

  test("(g) manual_payment_reasons rejects the rename with 22023", async () => {
    // invoices.manual_payment_reason also stores payment-method values since
    // migration 159, so a string cascade could rewrite the wrong rows and the
    // migration refuses the rename instead.
    await withRollback(async (client) => {
      const itemId = await seededItemId(client, "manual_payment_reasons", "bank_transfer");
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const error = (await captureRaiseError(client, () =>
        client.query(`select public.rename_option_list_value($1, $2)`, [itemId, "probe_new"]),
      )) as { code?: string } | null;
      expect(error?.code).toBe("22023");

      await actAsSuperuser(client);
      expect(await itemValueOf(client, itemId)).toBe("bank_transfer");
    });
  });

  test("(h) bound unit_floors value roof rejects the rename with 22023", async () => {
    await withRollback(async (client) => {
      const itemId = await seededItemId(client, "unit_floors", "roof");
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const error = (await captureRaiseError(client, () =>
        client.query(`select public.rename_option_list_value($1, $2)`, [itemId, "probe_new"]),
      )) as { code?: string; message?: string } | null;
      expect(error?.code).toBe("22023");
      expect(error?.message ?? "").toMatch("bound to system rules");

      await actAsSuperuser(client);
      expect(await itemValueOf(client, itemId)).toBe("roof");
    });
  });

  test("(h2) bound unit_types value managemental-services rejects the rename with 22023", async () => {
    await withRollback(async (client) => {
      const itemId = await seededItemId(client, "unit_types", "managemental-services");
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const error = (await captureRaiseError(client, () =>
        client.query(`select public.rename_option_list_value($1, $2)`, [itemId, "probe_new"]),
      )) as { code?: string; message?: string } | null;
      expect(error?.code).toBe("22023");
      expect(error?.message ?? "").toMatch("bound to system rules");

      await actAsSuperuser(client);
      expect(await itemValueOf(client, itemId)).toBe("managemental-services");
    });
  });

  test("(i) option_list_value_is_code_bound mirrors UNIT_FLOOR_TYPE_BINDING", async () => {
    await withRollback(async (client) => {
      const cases: Array<[string, string, boolean]> = [
        ["unit_floors", "roof", true],
        ["unit_types", "managemental-services", true],
        ["unit_types", "probe_unbound", false],
        ["unit_floors", "probe_unbound", false],
      ];
      for (const [listCode, value, expected] of cases) {
        const { rows } = await client.query<{ is_bound: boolean }>(
          `select public.option_list_value_is_code_bound($1, $2) as is_bound`,
          [listCode, value],
        );
        expect(rows[0].is_bound).toBe(expected);
      }
    });
  });
});
