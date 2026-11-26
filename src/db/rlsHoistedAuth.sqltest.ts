import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/** الجداول العامة غير المقيدة بشركة والمسموح لسياساتها بعدم استدعاء current_company_id(). */
const GLOBAL_OR_PLATFORM_TABLES = [
  "permissions",
  "reserved_slugs",
  "platform_admins",
  "platform_audit_log",
  "impersonation_sessions",
] as const;

/**
 * Migration 243 & multi-company conversion (T020) — every RLS policy in `public`
 * (and `storage.objects`) evaluates its auth/company helpers once per statement,
 * `current_company_id()` stays `STABLE`, and `company_service` cannot bypass or
 * reach any company-scoped table policy that omits `current_company_id`.
 */
describe("RLS auth checks are hoisted and cover current_company_id / company_service (T020)", () => {
  test("no public policy calls auth.uid() outside a scalar sub-select", async () => {
    await withRollback(async (client) => {
      await client.query("set local search_path = pg_catalog");
      const { rows } = await client.query<{ policy: string }>(
        `select c.relname || '.' || p.polname as policy
           from pg_policy p
           join pg_class c on c.oid = p.polrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
                || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
                ~ '(?<!SELECT )auth\\.uid\\(\\)'
          order by 1`,
      );
      expect(rows.map((row) => row.policy)).toEqual([]);
    });
  });

  test("no public or storage.objects policy calls auth.role(), auth.jwt(), current_company_id(), or is_platform_admin() outside a scalar sub-select", async () => {
    await withRollback(async (client) => {
      await client.query("set local search_path = pg_catalog");
      const { rows } = await client.query<{ policy: string }>(
        `select n.nspname || '.' || c.relname || '.' || p.polname as policy
           from pg_policy p
           join pg_class c on c.oid = p.polrelid
           join pg_namespace n on n.oid = c.relnamespace
          where (n.nspname = 'public' or (n.nspname = 'storage' and c.relname = 'objects'))
            and (
              coalesce(pg_get_expr(p.polqual, p.polrelid), '')
              || ' '
              || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
            ) ~ '(?<!SELECT )(?:auth\\.(?:uid|role|jwt)|public\\.(?:current_company_id|is_platform_admin))\\(\\)|(?<!SELECT )(?<!public\\.)(?:current_company_id|is_platform_admin)\\(\\)'
          order by 1`,
      );
      expect(rows.map((row) => row.policy)).toEqual([]);
    });
  });

  test("public.current_company_id() is STABLE so hoisted scalar sub-selects evaluate once per statement", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ provolatile: string; prosecdef: boolean }>(
        `select p.provolatile, p.prosecdef
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'current_company_id'`,
      );
      expect(rows).toEqual([{ provolatile: "s", prosecdef: true }]);
    });
  });

  test("company_service cannot bypass RLS and every applicable public policy references current_company_id", async () => {
    await withRollback(async (client) => {
      const { rows: roleRows } = await client.query<{
        rolbypassrls: boolean;
        rolsuper: boolean;
        inherits_service_role: boolean;
      }>(
        `select rolbypassrls,
                rolsuper,
                pg_has_role('company_service', 'service_role', 'MEMBER') as inherits_service_role
           from pg_roles
          where rolname = 'company_service'`,
      );
      expect(roleRows).toEqual([
        { rolbypassrls: false, rolsuper: false, inherits_service_role: false },
      ]);

      await client.query("set local search_path = pg_catalog");
      const { rows: unscopedPolicies } = await client.query<{ policy: string }>(
        `select c.relname || '.' || p.polname as policy
           from pg_policy p
           join pg_class c on c.oid = p.polrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and not (c.relname = any($1::text[]))
            and (
              0 = any(p.polroles)
              or 'company_service'::regrole::oid = any(p.polroles)
            )
            and (
              coalesce(pg_get_expr(p.polqual, p.polrelid), '')
              || ' '
              || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
            ) !~ 'current_company_id\\(\\)'
          order by 1`,
        [GLOBAL_OR_PLATFORM_TABLES],
      );
      expect(unscopedPolicies.map((row) => row.policy)).toEqual([]);
    });
  });
});
