import { afterAll, describe, expect, test } from "vitest";

import { actAsSuperuser, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * قائمة دوال `SECURITY DEFINER` العامّة المستثناة من ذكر `current_company_id`
 * لأنها إما تُنشئ السياق نفسه أو تتعامل مع جلسات المصادقة أو وصْف البنية فقط.
 */
const DEFINER_ALLOWLIST = new Set<string>([
  "current_company_id",
  "is_platform_admin",
  "tg_guard_company_slug",
  "tg_gateway_connections_guard_live",
  // Storage limit trigger: takes the company from the object path, which the
  // storage policies of migration 304 tie to the caller's company (migration 327).
  "tg_enforce_storage_limit",
  // Super admin overview: reads across companies and refuses every caller that
  // `is_platform_admin()` does not recognise (migration 325).
  "platform_overview_totals",
  "platform_company_health",
  "auth_sessions_set_not_after",
  "rebox_user_sessions",
  "user_roles_shorten_sessions",
  // Global sign-out after a password reset or change: deletes the GoTrue
  // sessions of one user, executable by service_role only (migration 321).
  "revoke_user_sessions",
  // Seeds a new company's defaults from platform.default_rows; it names the
  // company it fills and is executable by service_role only (migration 317).
  "seed_company_defaults",
  "session_lifetime_for",
  "backup_excluded_tables",
  "backup_protected_tables",
  "backup_table_names",
  "backup_schema_fingerprint",
  // The company-scoped door of the outbox: the money functions file their
  // event for the company of the row they changed, and they own the row's
  // company — so the function names it instead of reading it from the session.
  "enqueue_job_for_company",
]);

interface DefinerRow {
  signature: string;
  proname: string;
  body: string;
}

/**
 * يزيل تعليقات SQL من جسم الدالة حتى لا يمرّر تعليق عابر اختبار التحقق من `current_company_id()`.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * يتحقق من أن كل دالة `SECURITY DEFINER` في `public` تذكر `current_company_id` أو تقع ضمن قائمة المنصة المستثناة.
 */
describe("company isolation structure: security definer functions (T013)", () => {
  test("every public SECURITY DEFINER function references current_company_id or is allow-listed", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);

      const { rows } = await client.query<DefinerRow>(`
        select p.oid::regprocedure::text as signature,
               p.proname,
               p.prosrc as body
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prosecdef
           and not exists (
             select 1
               from pg_depend d
              where d.objid = p.oid
                and d.deptype = 'e'
           )
         order by 1
      `);

      expect(rows.length).toBeGreaterThan(0);

      const offending: string[] = [];
      for (const fn of rows) {
        if (DEFINER_ALLOWLIST.has(fn.proname)) continue;
        const code = stripSqlComments(fn.body);
        // `current_company_id_strict()` (T052j) calls `current_company_id()` and
        // raises COMPANY_REQUIRED when it is null, so it counts as scoping.
        if (!/\bcurrent_company_id(?:_strict)?\s*\(/i.test(code)) {
          offending.push(fn.signature);
        }
      }

      expect(offending).toEqual([]);
    });
  });

  // Regression (T052p): inside SECURITY DEFINER `current_user` is the owner, so
  // `current_user in ('authenticated', ...)` never matches and the guard is dead.
  test("no public SECURITY DEFINER function compares current_user with a role list", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);

      const { rows } = await client.query<DefinerRow>(`
        select p.oid::regprocedure::text as signature, p.proname, p.prosrc as body
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prosecdef
         order by 1
      `);

      const offending = rows
        .filter((fn) => /\bcurrent_user\s+(?:not\s+)?in\s*\(/i.test(stripSqlComments(fn.body)))
        .map((fn) => fn.signature);
      expect(offending).toEqual([]);
    });
  });
});
