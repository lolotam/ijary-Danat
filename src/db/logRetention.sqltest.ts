import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import {
  actAs,
  actAsSuperuser,
  captureRaise,
  closePool,
  seedCompanyUser,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/** ينشئ شركة اختبارية معزولة لاختبارات الاحتفاظ بالسجلات. */
async function seedCompany(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة سجلات ${tag}`, `Retention Co ${tag}`],
  );
  return rows[0].id;
}

/** يضبط الجلسة على دور `company_service` بسياق شركة محددة لتشغيل مهام التنظيف المجدولة. */
async function actAsCompanyService(client: PoolClient, companyId: string): Promise<void> {
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ role: "company_service", company_id: companyId }),
  ]);
  await client.query("select set_config('role', 'company_service', true)");
}

/**
 * يزرع صفوف تدقيق وإشعارات بأعمار محددة بالأيام، بعلامة تميّزها عن بيانات البذور.
 *
 * The database is not empty at rest, so every count below is scoped to the
 * marker this test wrote rather than to the whole table.
 */
async function seedAgedRows(client: PoolClient, companyId: string, marker: string): Promise<void> {
  for (const age of [1, 10, 40]) {
    await client.query(
      `insert into public.audit_logs (company_id, action, entity_type, created_at)
       values ($1, $2, 'test', now() - make_interval(days => $3))`,
      [companyId, marker, age],
    );
    for (const state of ["sent", "queued"]) {
      await client.query(
        `insert into public.notifications (company_id, audience, type, channel, locale, state, subject, created_at)
         values ($1, 'tenant', 'receipt', 'email', 'ar', $2::public.notification_states, $3,
                 now() - make_interval(days => $4))`,
        [companyId, state, marker, age],
      );
    }
  }
}

/** يعدّ الصفوف المتبقية من البذرة: التدقيق، والإشعارات حسب الحالة. */
async function remaining(client: PoolClient, marker: string) {
  const audit = await client.query<{ n: number }>(
    `select count(*)::int as n from public.audit_logs where action = $1`,
    [marker],
  );
  const notifications = await client.query<{ state: string; n: number }>(
    `select state::text, count(*)::int as n from public.notifications
      where subject = $1 group by state order by state`,
    [marker],
  );
  return {
    audit: audit.rows[0].n,
    notifications: Object.fromEntries(notifications.rows.map((row) => [row.state, row.n])),
  };
}

/**
 * Migration 242 — automatic retention for audit_logs and notifications.
 * Spec: docs/specs/log-retention-and-audit-filters.md.
 */
describe("log retention (migration 242)", () => {
  test("an admin setting audit retention deletes older rows at once and audits it", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const marker = `test.retention.${randomUUID()}`;
      await seedAgedRows(client, companyId, marker);
      const adminId = await seedCompanyUser(client, companyId, "admin");

      await actAs(client, "authenticated", adminId);
      const { rows } = await client.query<{ result: { deleted: number } }>(
        `select public.set_log_retention('audit', 7) as result`,
      );
      await actAsSuperuser(client);

      expect(rows[0].result.deleted).toBeGreaterThanOrEqual(2);
      expect((await remaining(client, marker)).audit).toBe(1);
      const audit = await client.query<{ after: { log: string; days: number } }>(
        `select after from public.audit_logs
          where company_id = $1 and action = 'log_retention.update'
          order by created_at desc limit 1`,
        [companyId],
      );
      expect(audit.rows[0].after).toMatchObject({ log: "audit", days: 7 });
    });
  });

  test("notification retention never deletes a queued row, however old", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const marker = `test.retention.${randomUUID()}`;
      await seedAgedRows(client, companyId, marker);
      const adminId = await seedCompanyUser(client, companyId, "admin");

      await actAs(client, "authenticated", adminId);
      await client.query(`select public.set_log_retention('notifications', 30)`);
      await actAsSuperuser(client);

      expect((await remaining(client, marker)).notifications).toEqual({ queued: 3, sent: 2 });
    });
  });

  test("only an admin may shorten the audit trail", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const accountantId = await seedCompanyUser(client, companyId, "accountant");

      await actAs(client, "authenticated", accountantId);
      const error = await captureRaise(client, () =>
        client.query(`select public.set_log_retention('audit', 7)`),
      );
      await actAsSuperuser(client);

      expect(error).toMatch(/only an admin/i);
    });
  });

  test("a value outside the allowed windows is refused", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const adminId = await seedCompanyUser(client, companyId, "admin");

      await actAs(client, "authenticated", adminId);
      const error = await captureRaise(client, () =>
        client.query(`select public.set_log_retention('audit', 30)`),
      );
      await actAsSuperuser(client);

      expect(error).toMatch(/7, 14, 21 or 28/);
    });
  });

  test("the generic company update cannot change the window", async () => {
    await withRollback(async (client) => {
      const error = await captureRaise(client, () =>
        client.query(`update public.companies set audit_log_retention_days = 7`),
      );
      expect(error).toMatch(/set_log_retention/);
    });
  });

  test("the cron entry point applies both windows and is service_role only", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const marker = `test.retention.${randomUUID()}`;
      await seedAgedRows(client, companyId, marker);
      const adminId = await seedCompanyUser(client, companyId, "admin");
      await actAs(client, "authenticated", adminId);
      await client.query(`select public.set_log_retention('audit', null)`);
      await client.query(`select public.set_log_retention('notifications', null)`);
      await actAsSuperuser(client);
      await client.query(`select set_config('app.log_retention_update', 'on', true)`);
      await client.query(
        `update public.companies
            set audit_log_retention_days = 14, notification_log_retention_days = 7
          where id = $1`,
        [companyId],
      );

      await actAsCompanyService(client, companyId);
      await client.query(`select public.purge_expired_logs()`);
      await actAsSuperuser(client);

      expect(await remaining(client, marker)).toEqual({
        audit: 2,
        notifications: { queued: 3, sent: 1 },
      });

      const { rows } = await client.query<{ role: string; allowed: boolean }>(
        `select r as role,
                has_function_privilege(r, 'public.purge_expired_logs()', 'execute') as allowed
           from unnest(array['anon', 'authenticated', 'service_role']) as r`,
      );
      expect(Object.fromEntries(rows.map((row) => [row.role, row.allowed]))).toEqual({
        anon: false,
        authenticated: false,
        service_role: true,
      });
    });
  });

  test("filter options read through RLS: a tenant sees empty lists", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const tenantUserId = await seedCompanyUser(client, companyId, "tenant");

      await actAs(client, "authenticated", tenantUserId);
      const { rows } = await client.query<{ options: Record<string, unknown[]> }>(
        `select public.audit_log_filter_options() as options`,
      );
      await actAsSuperuser(client);

      expect(rows[0].options).toEqual({ actors: [], roles: [], actions: [], entity_types: [] });
    });
  });
});
