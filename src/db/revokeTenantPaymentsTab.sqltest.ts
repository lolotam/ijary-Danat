import { readFileSync } from "node:fs";

import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 205 — revoke the tenant-role payments tab.
 *
 * Every production tenant is on "inherit" (57 null, 0 true, 0 false), so
 * removing the role default hides the tab for all of them while keeping the
 * tri-state override (an admin can still force-show one tenant) and the
 * permission row itself (Settings → Roles can grant it back).
 */

const MIGRATION = readFileSync("db/migrations/205_revoke_tenant_payments_tab.sql", "utf8");

describe("205_revoke_tenant_payments_tab", () => {
  test("the fresh build already lacks the row, and replaying the file removes a re-inserted one leaving every other tenant grant identical", async () => {
    await withRollback(async (client) => {
      const { rows: companies } = await client.query<{ id: string }>(
        `select id from public.companies order by created_at asc limit 1`,
      );
      const companyId = companies[0].id;
      const baseline = await client.query(
        `select permission_code from public.role_permissions
          where company_id = $1 and role = 'tenant'
          order by 1`,
        [companyId],
      );
      expect(baseline.rows.map((r) => r.permission_code)).not.toContain("portal.tab_payments");
      await client.query(
        `insert into public.role_permissions (company_id, role, permission_code)
         values ($1, 'tenant', 'portal.tab_payments')`,
        [companyId],
      );
      await client.query(MIGRATION);
      await client.query(MIGRATION);
      const after = await client.query(
        `select permission_code from public.role_permissions
          where company_id = $1 and role = 'tenant'
          order by 1`,
        [companyId],
      );
      expect(after.rows).toEqual(baseline.rows);
      expect(
        (await client.query(`select 1 from public.permissions where code = 'portal.tab_payments'`))
          .rowCount,
      ).toBe(1);
    });
  });
});
