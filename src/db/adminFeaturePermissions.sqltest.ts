import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { actAs, captureRaise, closePool, withRollback } from "@/db/testDb";
import { PERMISSION_CODES } from "@/lib/permissions";

afterAll(closePool);

/**
 * Migration 230 moved seven admin-only features, plus the landing page, onto
 * grantable permission codes. Two things have to hold for a grant to work:
 * the TypeScript catalog must list the code (usePermissions drops any code it
 * does not know), and the RLS policy must check the code rather than a role.
 */

/** ينشئ مستخدماً بدور محاسب، ويمنحه الصلاحيات المذكورة عبر role_permissions. */
async function seedAccountant(client: PoolClient, codes: string[]): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@example.test`],
  );
  await client.query(`insert into public.user_roles (user_id, role) values ($1, 'accountant')`, [
    userId,
  ]);
  // Grants are per role, so they are rolled back with the test transaction.
  for (const code of codes) {
    await client.query(
      `insert into public.role_permissions (role, permission_code)
       values ('accountant', $1) on conflict do nothing`,
      [code],
    );
  }
  return userId;
}

/** يعيد عدد الصفوف التي سمحت سياسة UPDATE بلمسها — صفر يعني أن RLS أخفاها. */
async function touchableRows(client: PoolClient, table: string, column: string): Promise<number> {
  const { rowCount } = await client.query(`update public.${table} set ${column} = ${column}`);
  return rowCount ?? 0;
}

describe("permission catalog", () => {
  test("the TypeScript catalog and the permissions table list the same codes", async () => {
    // Drift here is silent in the app: a DB-only code is dropped by
    // usePermissions (landing_page.* for its whole life before 230), and a
    // TS-only code is a roles-screen checkbox with no row to grant.
    const { rows } = await withRollback((client) =>
      client.query<{ code: string }>(`select code from public.permissions order by code`),
    );
    expect(rows.map((r) => r.code).sort()).toEqual([...PERMISSION_CODES].sort());
  });
});

describe("RLS follows the migration-230 codes, not the admin role", () => {
  test.each([
    ["cron_jobs", "is_active", "workflows.manage"],
    ["option_lists", "name_ar", "settings.lists"],
    ["landing_page_sections", "enabled", "landing_page.update"],
  ])("%s is writable with %s's code and not without it", async (table, column, code) => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ n: number }>(
        `select count(*)::int as n from public.${table}`,
      );
      // The assertion below is only meaningful if there is a row to touch.
      expect(rows[0].n).toBeGreaterThan(0);

      const without = await seedAccountant(client, []);
      await actAs(client, "authenticated", without);
      expect(await touchableRows(client, table, column)).toBe(0);
    });

    await withRollback(async (client) => {
      const granted = await seedAccountant(client, [code]);
      await actAs(client, "authenticated", granted);
      expect(await touchableRows(client, table, column)).toBeGreaterThan(0);
    });
  });

  test.each([
    ["expense_categories", "expenses.categories"],
    ["electricity_tariffs", "electricity.tariffs"],
  ])("inserting into %s needs %s", async (table, code) => {
    const insert = (client: PoolClient) =>
      client.query(`insert into public.${table} (code, name_ar) values ($1, 'اختبار')`, [
        `t-${randomUUID()}`,
      ]);

    await withRollback(async (client) => {
      const without = await seedAccountant(client, []);
      await actAs(client, "authenticated", without);
      expect(await captureRaise(client, () => insert(client))).toMatch(/row-level security/i);
    });

    await withRollback(async (client) => {
      const granted = await seedAccountant(client, [code]);
      await actAs(client, "authenticated", granted);
      expect(await captureRaise(client, () => insert(client))).toBeNull();
    });
  });
});
