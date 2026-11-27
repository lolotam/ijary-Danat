import { afterAll, describe, expect, test } from "vitest";

import { actAsSuperuser, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * الجداول المعفاة من عمود `company_id` لأنها جداول منصة عامة أو جدول الشركات نفسه.
 *
 * `companies` uses its own primary key `id` rather than `company_id`, and is
 * checked separately for forced RLS, `current_company_id()` policies, and zero
 * `DELETE` grants.
 */
const TABLES_WITHOUT_COMPANY_ID_ALLOWLIST = new Set<string>([
  "companies",
  "permissions",
  "reserved_slugs",
  "platform_admins",
  "platform_audit_log",
  "platform_gateway_launch",
  "impersonation_sessions",
]);

/** جداول المنصة التي لا تفرض سياسات `current_company_id()` بل صلاحية المنصة. */
const PLATFORM_GLOBAL_TABLES = new Set<string>([
  "permissions",
  "reserved_slugs",
  "platform_admins",
  "platform_audit_log",
  "platform_gateway_launch",
  "impersonation_sessions",
]);

interface TableAuditRow {
  table_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  has_company_id: boolean;
  company_id_not_null: boolean;
  non_service_policy_count: number;
  policies_missing_context: string[];
}

/**
 * يتحقق من أن كل جدول عام خارج قائمة الاستثناءات يمتلك `company_id` وRLS إجبارياً وسياسات تعتمد على `current_company_id()`.
 */
describe("company isolation structure: public tables (T012)", () => {
  test("every non-allowlisted public table has non-null company_id, forced RLS, and current_company_id() policies", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);

      const { rows } = await client.query<TableAuditRow>(`
        select c.relname as table_name,
               c.relrowsecurity as rls_enabled,
               c.relforcerowsecurity as rls_forced,
               exists (
                 select 1
                   from pg_attribute a
                  where a.attrelid = c.oid
                    and a.attname = 'company_id'
                    and not a.attisdropped
               ) as has_company_id,
               exists (
                 select 1
                   from pg_attribute a
                  where a.attrelid = c.oid
                    and a.attname = 'company_id'
                    and a.attnotnull
                    and a.atttypid = 'uuid'::regtype
                    and not a.attisdropped
               ) as company_id_not_null,
               (
                 select count(*)::int
                   from pg_policy p
                  where p.polrelid = c.oid
                    and (
                      p.polroles = array[0::oid]
                      or exists (
                        select 1
                          from unnest(p.polroles) as r_oid
                          join pg_roles r on r.oid = r_oid
                         where r.rolname <> 'service_role'
                      )
                    )
               ) as non_service_policy_count,
               coalesce(
                 (
                   select array_agg(p.polname::text order by p.polname)
                     from pg_policy p
                    where p.polrelid = c.oid
                      and (
                        p.polroles = array[0::oid]
                        or exists (
                          select 1
                            from unnest(p.polroles) as r_oid
                            join pg_roles r on r.oid = r_oid
                           where r.rolname <> 'service_role'
                        )
                      )
                      and (
                        coalesce(pg_get_expr(p.polqual, p.polrelid), '')
                        || ' ' ||
                        coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
                      ) !~ 'current_company_id\\s*\\('
                 ),
                 array[]::text[]
               ) as policies_missing_context
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relkind in ('r', 'p')
         order by c.relname
      `);

      expect(rows.length).toBeGreaterThan(0);

      const failures: string[] = [];

      for (const row of rows) {
        if (!row.rls_enabled) {
          failures.push(`${row.table_name}: RLS not enabled`);
        }
        if (!row.rls_forced) {
          failures.push(`${row.table_name}: FORCE ROW LEVEL SECURITY not enabled`);
        }

        if (PLATFORM_GLOBAL_TABLES.has(row.table_name)) {
          continue;
        }

        if (
          !TABLES_WITHOUT_COMPANY_ID_ALLOWLIST.has(row.table_name) &&
          (!row.has_company_id || !row.company_id_not_null)
        ) {
          failures.push(`${row.table_name}: missing NOT NULL uuid company_id column`);
        }

        if (row.non_service_policy_count === 0) {
          failures.push(`${row.table_name}: has zero non-service_role policies`);
        }

        if (row.policies_missing_context.length > 0) {
          failures.push(
            `${row.table_name}: policies missing current_company_id(): ${row.policies_missing_context.join(", ")}`,
          );
        }
      }

      expect(failures).toEqual([]);
    });
  });

  test("no application or service role holds DELETE privilege on public.companies", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const { rows } = await client.query<{ grantee: string }>(
        `select grantee
           from information_schema.role_table_grants
          where table_schema = 'public'
            and table_name = 'companies'
            and privilege_type = 'DELETE'
            and grantee in ('PUBLIC', 'anon', 'authenticated', 'company_service', 'service_role')
          order by grantee`,
      );
      expect(rows.map((r) => r.grantee)).toEqual([]);
    });
  });
});
