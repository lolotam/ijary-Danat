import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { DEFAULT_MODULE_ENABLED, MODULE_KEYS, PERMISSION_SECTION } from "@/company/modules";
import {
  actAsCompanyService,
  actAsCompanyUser,
  COMPANY_ROLES,
  runAsCompanyService,
  runAsUser,
  seedTwoCompanies,
} from "@/db/isolation/twoCompanies";
import { actAs, actAsSuperuser, captureRaiseError, closePool, withRollback } from "@/db/testDb";
import { PERMISSION_CODES } from "@/lib/permissions";

afterAll(closePool);

/**
 * يضبط حالة قسمٍ معين لشركة محددة بصلاحية المالك (محاكاةً لإجراء المشرف العام).
 */
async function setCompanyModule(
  client: PoolClient,
  companyId: string,
  moduleKey: string,
  enabled: boolean,
): Promise<void> {
  await actAsSuperuser(client);
  await client.query(
    `insert into public.company_modules (company_id, module_key, enabled)
     values ($1, $2, $3)
     on conflict (company_id, module_key)
     do update set enabled = excluded.enabled`,
    [companyId, moduleKey, enabled],
  );
}

/**
 * يستعلم عن نتيجة `public.has_permission` للمستخدم والرمز المحددين.
 */
async function queryHasPermission(
  client: PoolClient,
  userId: string,
  code: string,
): Promise<boolean> {
  const { rows } = await client.query<{ allowed: boolean }>(
    `select public.has_permission($1, $2) as allowed`,
    [userId, code],
  );
  return rows[0].allowed;
}

/**
 * يدرج دوراً مخصصاً في الشركة بالصلاحية المطلوبة ويربطه بمستخدم محدد.
 */
async function grantCustomRolePermission(
  client: PoolClient,
  companyId: string,
  userId: string,
  permissionCode: string,
): Promise<void> {
  const roleId = randomUUID();
  await client.query(
    `insert into public.custom_roles (id, company_id, code, name_ar, name_en, is_active)
     values ($1, $2, $3, 'دور اختبار', 'Test Role', true)`,
    [roleId, companyId, `test_role_${roleId.replaceAll("-", "")}`],
  );
  await client.query(
    `insert into public.custom_role_permissions (company_id, custom_role_id, permission_code)
     values ($1, $2, $3)`,
    [companyId, roleId, permissionCode],
  );
  await client.query(
    `insert into public.user_custom_roles (company_id, user_id, custom_role_id)
     values ($1, $2, $3)`,
    [companyId, userId, roleId],
  );
}

describe("migration 320 - company_modules, module_enabled, and has_permission gate (T105, T107)", () => {
  test("SQL permission_section() matches TS PERMISSION_SECTION for every PermissionCode", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ code: string; section: string | null }>(
        `select c as code, public.permission_section(c) as section
           from unnest($1::text[]) as c`,
        [[...PERMISSION_CODES]],
      );

      const sqlMap = Object.fromEntries(rows.map((row) => [row.code, row.section]));
      const expectedMap = Object.fromEntries(
        PERMISSION_CODES.map((code) => [code, PERMISSION_SECTION[code] ?? null]),
      );

      expect(sqlMap).toEqual(expectedMap);
    });
  });

  test("module_enabled and get_my_modules fail closed when company context is null", async () => {
    await withRollback(async (client) => {
      // anon has no EXECUTE on the helper at all (migration 320 revokes it).
      await client.query("savepoint anon_check");
      await actAs(client, "anon");
      await expect(client.query(`select public.module_enabled('invoices')`)).rejects.toThrow(
        /permission denied for function module_enabled/,
      );
      await client.query("rollback to savepoint anon_check");

      await actAsCompanyService(client, null);
      const nullServiceCheck = await client.query<{
        invoices: boolean;
        count: number;
      }>(
        `select public.module_enabled('invoices') as invoices,
                (select count(*)::int from public.get_my_modules()) as count`,
      );
      expect(nullServiceCheck.rows[0]).toEqual({ invoices: false, count: 0 });
    });
  });

  test("get_my_modules returns DEFAULT_MODULE_ENABLED for all 17 keys when rows are absent", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);

      const rows = await runAsUser(client, A.users.admin, async () => {
        const res = await client.query<{ module_key: string; enabled: boolean }>(
          `select module_key, enabled from public.get_my_modules()`,
        );
        return res.rows;
      });

      expect(rows).toHaveLength(MODULE_KEYS.length);
      const effective = Object.fromEntries(rows.map((r) => [r.module_key, r.enabled]));
      expect(effective).toEqual(DEFAULT_MODULE_ENABLED);
    });
  });

  test.each(COMPANY_ROLES)(
    "with electricity off in company A, has_permission returns false for %s (including custom roles) while company B is unaffected",
    async (role) => {
      await withRollback(async (client) => {
        const { A, B } = await seedTwoCompanies(client);

        if (role === "collector") {
          await grantCustomRolePermission(client, A.id, A.users.collector.id, "electricity.read");
        }

        await setCompanyModule(client, A.id, "electricity", false);

        const allowedInA = await runAsUser(client, A.users[role], () =>
          queryHasPermission(client, A.users[role].id, "electricity.read"),
        );
        expect(allowedInA).toBe(false);

        const adminAlwaysOnInA = await runAsUser(client, A.users.admin, () =>
          queryHasPermission(client, A.users.admin.id, "company.read"),
        );
        expect(adminAlwaysOnInA).toBe(true);

        const adminAllowedInB = await runAsUser(client, B.users.admin, () =>
          queryHasPermission(client, B.users.admin.id, "electricity.read"),
        );
        expect(adminAllowedInB).toBe(true);
      });
    },
  );

  test("toggling a section off preserves existing data and restores access when re-enabled", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const tag = randomUUID().slice(0, 8);

      const propId = await runAsCompanyService(client, A.id, async () => {
        const { rows } = await client.query<{ id: string }>(
          `insert into public.properties (code, company_id, name_ar, name_en)
           values ($1, $2, $3, $4) returning id`,
          [`P-${tag}`, A.id, `عقار ${tag}`, `Property ${tag}`],
        );
        return rows[0].id;
      });

      await setCompanyModule(client, A.id, "properties", false);
      const whileOff = await runAsUser(client, A.users.admin, () =>
        queryHasPermission(client, A.users.admin.id, "properties.read"),
      );
      expect(whileOff).toBe(false);

      await setCompanyModule(client, A.id, "properties", true);
      const afterOn = await runAsUser(client, A.users.admin, async () => {
        const allowed = await queryHasPermission(client, A.users.admin.id, "properties.read");
        const { rows } = await client.query<{ id: string }>(
          `select id from public.properties where id = $1`,
          [propId],
        );
        return { allowed, rowCount: rows.length };
      });
      expect(afterOn).toEqual({ allowed: true, rowCount: 1 });
    });
  });

  test("company_modules RLS lets staff read only their own company and forbids writes from non-service roles", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      await setCompanyModule(client, A.id, "electricity", false);
      await setCompanyModule(client, B.id, "electricity", true);

      const visibleToA = await runAsUser(client, A.users.readonly, async () => {
        const { rows } = await client.query<{ company_id: string; enabled: boolean }>(
          `select company_id, enabled from public.company_modules where module_key = 'electricity'`,
        );
        return rows;
      });
      expect(visibleToA).toEqual([{ company_id: A.id, enabled: false }]);

      await actAsCompanyUser(client, A.users.admin);
      const adminWriteErr = (await captureRaiseError(client, () =>
        client.query(
          `update public.company_modules set enabled = true where company_id = $1 and module_key = 'electricity'`,
          [A.id],
        ),
      )) as { code?: string } | null;
      expect(adminWriteErr?.code).toBe("42501");

      await actAsCompanyService(client, A.id);
      const serviceWriteErr = (await captureRaiseError(client, () =>
        client.query(
          `insert into public.company_modules (company_id, module_key, enabled)
           values ($1, 'invoices', false)`,
          [A.id],
        ),
      )) as { code?: string } | null;
      expect(serviceWriteErr?.code).toBe("42501");
    });
  });
});
