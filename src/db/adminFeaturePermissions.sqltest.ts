import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { actAs, captureRaise, closePool, seedCompanyUser, withRollback } from "@/db/testDb";
import { PERMISSION_CODES } from "@/lib/permissions";

afterAll(closePool);

/**
 * Migration 230 moved seven admin-only features, plus the landing page, onto
 * grantable permission codes. Two things have to hold for a grant to work:
 * the TypeScript catalog must list the code (usePermissions drops any code it
 * does not know), and the RLS policy must check the code rather than a role.
 */

/** ينشئ شركة اختبار جديدة ويعيد معرّفها. */
async function seedCompany(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة اختبار ${tag}`, `Test Co ${tag}`],
  );
  return rows[0].id;
}

/** ينشئ مستخدماً بدور محاسب ضمن الشركة، ويمنحه الصلاحيات المذكورة عبر role_permissions. */
async function seedAccountant(
  client: PoolClient,
  companyId: string,
  codes: string[],
): Promise<string> {
  const userId = await seedCompanyUser(client, companyId, "accountant", "afp-acct");
  // Grants are per company and role, so they are rolled back with the test transaction.
  for (const code of codes) {
    await client.query(
      `insert into public.role_permissions (company_id, role, permission_code)
       values ($1, 'accountant', $2) on conflict do nothing`,
      [companyId, code],
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
      const { rows } = await client.query<{ n: number; company_id: string | null }>(
        `select count(*)::int as n, min(company_id::text) as company_id from public.${table}`,
      );
      // The assertion below is only meaningful if there is a row to touch.
      expect(rows[0].n).toBeGreaterThan(0);
      const companyId = rows[0].company_id!;

      const without = await seedAccountant(client, companyId, []);
      await client.query(
        `delete from public.role_permissions
          where company_id = $1 and role = 'accountant' and permission_code = $2`,
        [companyId, code],
      );
      await actAs(client, "authenticated", without);
      expect(await touchableRows(client, table, column)).toBe(0);
    });

    await withRollback(async (client) => {
      const { rows } = await client.query<{ company_id: string | null }>(
        `select min(company_id::text) as company_id from public.${table}`,
      );
      const companyId = rows[0].company_id!;
      const granted = await seedAccountant(client, companyId, [code]);
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
      const companyId = await seedCompany(client);
      const without = await seedAccountant(client, companyId, []);
      await actAs(client, "authenticated", without);
      expect(await captureRaise(client, () => insert(client))).toMatch(/row-level security/i);
    });

    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const granted = await seedAccountant(client, companyId, [code]);
      await actAs(client, "authenticated", granted);
      expect(await captureRaise(client, () => insert(client))).toBeNull();
    });
  });
});
