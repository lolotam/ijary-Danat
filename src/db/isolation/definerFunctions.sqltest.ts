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
  "auth_sessions_set_not_after",
  "rebox_user_sessions",
  "user_roles_shorten_sessions",
  "session_lifetime_for",
  "backup_excluded_tables",
  "backup_protected_tables",
  "backup_table_names",
  "backup_schema_fingerprint",
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
        if (!/\bcurrent_company_id\s*\(/i.test(code)) {
          offending.push(fn.signature);
        }
      }

      expect(offending).toEqual([]);
    });
  });
});
