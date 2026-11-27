import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

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
 * ينشئ مستخدماً في `auth.users` بلا صف في `profiles`.
 *
 * A super admin is a GoTrue user with no company profile (research R16), and
 * `handle_new_user()` skips the profile when `is_platform_admin` is set in the
 * raw metadata — which is what keeps `profiles.company_id` filled.
 */
async function seedAuthUser(client: PoolClient): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2,
             '{"is_platform_admin":"true"}'::jsonb)`,
    [userId, `platform-${userId.slice(0, 8)}@example.test`],
  );
  return userId;
}

/**
 * ينشئ صف مشرف منصة للمستخدم.
 */
async function grantPlatformAdmin(
  client: PoolClient,
  userId: string,
  isActive = true,
): Promise<void> {
  await client.query(
    `insert into public.platform_admins (user_id, full_name, is_active)
     values ($1, $2, $3)`,
    [userId, `Platform Admin ${userId.slice(0, 8)}`, isActive],
  );
}

/**
 * ينتحل دور مستخدم مصادق عليه مع ادعاء العامل الثاني.
 *
 * `actAs` in testDb.ts cannot carry the `aal` claim, and the second factor is
 * half of what `is_platform_admin()` checks. The claim blob is what both the
 * test database and production read.
 */
async function actAsUserWithAal(
  client: PoolClient,
  userId: string,
  aal: string | null,
): Promise<void> {
  const claims = JSON.stringify({
    sub: userId,
    role: "authenticated",
    ...(aal ? { aal } : {}),
  });
  await client.query("select set_config('request.jwt.claims', $1, true)", [claims]);
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
  await client.query("select set_config('request.jwt.claim.role', $1, true)", ["authenticated"]);
  await client.query("select set_config('role', $1, true)", ["authenticated"]);
}

describe("is_platform_admin() needs the row and the second factor (T091)", () => {
  const ADMIN_CASES = [
    {
      name: "an active platform admin row with aal2 is a platform admin",
      hasRow: true,
      isActive: true,
      aal: "aal2",
      expected: true,
    },
    {
      name: "an active platform admin row without a second factor is not",
      hasRow: true,
      isActive: true,
      aal: null,
      expected: false,
    },
    {
      name: "an active platform admin row with aal1 is not",
      hasRow: true,
      isActive: true,
      aal: "aal1",
      expected: false,
    },
    {
      name: "aal2 without a platform admin row is not",
      hasRow: false,
      isActive: true,
      aal: "aal2",
      expected: false,
    },
    {
      name: "a deactivated platform admin row with aal2 is not",
      hasRow: true,
      isActive: false,
      aal: "aal2",
      expected: false,
    },
  ] as const;

  test.each(ADMIN_CASES)("$name", async ({ hasRow, isActive, aal, expected }) => {
    await withRollback(async (client) => {
      const userId = await seedAuthUser(client);
      if (hasRow) {
        await grantPlatformAdmin(client, userId, isActive);
      }

      await actAsUserWithAal(client, userId, aal);
      const { rows } = await client.query<{ is_admin: boolean }>(
        `select public.is_platform_admin() as is_admin`,
      );

      expect(rows[0].is_admin).toBe(expected);
    });
  });
});

describe("a super admin reads no company row through RLS (T091)", () => {
  const COMPANY_TABLES = ["companies", "profiles", "properties"] as const;

  test.each(COMPANY_TABLES)("a super admin reads no %s row", async (table) => {
    await withRollback(async (client) => {
      const userId = await seedAuthUser(client);
      await grantPlatformAdmin(client, userId);

      await actAsUserWithAal(client, userId, "aal2");
      const { rows } = await client.query<{ total: number }>(
        `select count(*)::int as total from public.${table}`,
      );

      expect(rows[0].total).toBe(0);
    });
  });

  test("a super admin has no company context", async () => {
    await withRollback(async (client) => {
      const userId = await seedAuthUser(client);
      await grantPlatformAdmin(client, userId);

      await actAsUserWithAal(client, userId, "aal2");
      const { rows } = await client.query<{ cid: string | null }>(
        `select public.current_company_id() as cid`,
      );

      expect(rows[0].cid).toBeNull();
    });
  });
});

describe("platform_audit_log is insert-only (T091)", () => {
  test("service_role can append an audit row", async () => {
    await withRollback(async (client) => {
      await actAs(client, "service_role");
      const { rowCount } = await client.query(
        `insert into public.platform_audit_log (action, entity, entity_id)
         values ('company.create', 'company', $1)`,
        [randomUUID()],
      );

      expect(rowCount).toBe(1);
    });
  });

  test("the table owner cannot change an audit row", async () => {
    await withRollback(async (client) => {
      await actAs(client, "service_role");
      const { rows } = await client.query<{ id: string }>(
        `insert into public.platform_audit_log (action, entity)
         values ('company.update', 'company')
         returning id`,
      );
      const auditId = rows[0].id;

      await actAsSuperuser(client);
      const message = await captureRaise(client, () =>
        client.query(`update public.platform_audit_log set action = 'tampered' where id = $1`, [
          auditId,
        ]),
      );

      expect(message).toContain("PLATFORM_AUDIT_LOG_IMMUTABLE");
    });
  });

  test("the table owner cannot delete an audit row", async () => {
    await withRollback(async (client) => {
      await actAs(client, "service_role");
      const { rows } = await client.query<{ id: string }>(
        `insert into public.platform_audit_log (action, entity)
         values ('company.update', 'company')
         returning id`,
      );
      const auditId = rows[0].id;

      await actAsSuperuser(client);
      const message = await captureRaise(client, () =>
        client.query(`delete from public.platform_audit_log where id = $1`, [auditId]),
      );

      expect(message).toContain("PLATFORM_AUDIT_LOG_IMMUTABLE");
    });
  });

  test("no role holds update or delete on the audit log", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const { rows } = await client.query<{ grantee: string; privilege_type: string }>(
        `select grantee, privilege_type
           from information_schema.role_table_grants
          where table_schema = 'public'
            and table_name = 'platform_audit_log'
            and privilege_type in ('UPDATE', 'DELETE')
            and grantee in ('PUBLIC', 'anon', 'authenticated', 'company_service', 'service_role')
          order by grantee, privilege_type`,
      );

      expect(rows).toEqual([]);
    });
  });

  test("a signed-in super admin cannot write an audit row", async () => {
    await withRollback(async (client) => {
      const userId = await seedAuthUser(client);
      await grantPlatformAdmin(client, userId);

      await actAsUserWithAal(client, userId, "aal2");
      const error = await captureRaiseError(client, () =>
        client.query(
          `insert into public.platform_audit_log (action, entity) values ('company.create', 'company')`,
        ),
      );

      expect(error).toMatchObject({ code: "42501" });
    });
  });
});
