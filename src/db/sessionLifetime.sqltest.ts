import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 231: the trigger on auth.sessions stamps not_after from
 * session_lifetime_for(). auth.sessions only exists where GoTrue has run, so
 * the role rule is tested through the function; the trigger itself was
 * verified against production's auth.sessions when 231 was applied.
 */

/** ينشئ شركة اختبار لاستضافة أدوار المستخدمين في اختبار الجلسات. */
async function seedCompany(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة جلسات ${tag}`, `Session Co ${tag}`],
  );
  return rows[0].id;
}

/** ينشئ مستخدماً ويمنحه الأدوار المذكورة ضمن الشركة المحددة. */
async function seedUser(client: PoolClient, roles: string[], companyId: string): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@example.test`],
  );
  for (const role of roles) {
    await client.query(
      `insert into public.user_roles (company_id, user_id, role) values ($1, $2, $3::public.app_role)`,
      [companyId, userId, role],
    );
  }
  return userId;
}

describe("session_lifetime_for", () => {
  test.each([
    [["tenant"], "6 mons"],
    [["admin"], "06:00:00"],
    [["accountant"], "06:00:00"],
    // A tenant who is also staff gets the stricter staff window.
    [["tenant", "accountant"], "06:00:00"],
    // No role at all must not inherit the 6-month portal window.
    [[], "06:00:00"],
  ])("roles %j → %s", async (roles, expected) => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const userId = await seedUser(client, roles, companyId);
      const { rows } = await client.query<{ lifetime: string }>(
        `select public.session_lifetime_for($1)::text as lifetime`,
        [userId],
      );
      expect(rows[0].lifetime).toBe(expected);
    });
  });
});

/**
 * يضمن وجود جدول auth.sessions داخل المعاملة، إذ لا تنشئه صورة الاختبار.
 *
 * Only the columns migration 232 reads or writes. DDL is transactional, so the
 * table disappears with the rollback wherever it was created here.
 */
async function ensureSessionsTable(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists auth.sessions (
      id uuid primary key,
      user_id uuid not null,
      created_at timestamptz not null default now(),
      not_after timestamptz
    )`);
}

describe("granting a role re-boxes the user's open sessions (migration 232)", () => {
  test.each([
    // A signed-in tenant made staff must not keep a 6-month staff session.
    ["accountant", "6 hours"],
    // Adding another tenant row must not extend or shorten anything.
    ["tenant", "6 months"],
  ])("tenant granted %s → session ends %s after sign-in", async (grantedRole, expected) => {
    await withRollback(async (client) => {
      await ensureSessionsTable(client);
      const companyId = await seedCompany(client);
      const userId = await seedUser(client, ["tenant"], companyId);
      await client.query(
        `insert into auth.sessions (id, user_id, created_at, not_after)
         values ($1, $2, now() - interval '1 hour', now() - interval '1 hour' + interval '6 months')`,
        [randomUUID(), userId],
      );

      await client.query(
        `insert into public.user_roles (company_id, user_id, role) values ($1, $2, $3::public.app_role)
         on conflict do nothing`,
        [companyId, userId, grantedRole],
      );

      // Compared as timestamps: a month-based interval subtracts back to a
      // day count ("181 days"), so the text form depends on today's date.
      const { rows } = await client.query<{ matches: boolean }>(
        `select not_after = created_at + $2::interval as matches
           from auth.sessions where user_id = $1`,
        [userId, expected],
      );
      expect(rows[0].matches).toBe(true);
    });
  });
});

describe("role grants during a backup restore (migration 233)", () => {
  test("the re-box trigger still fires with session_replication_role = replica", async () => {
    // backup_restore() rewrites user_roles in replica mode, where ordinary
    // triggers are skipped; a restored staff role must still shorten a live
    // tenant session.
    await withRollback(async (client) => {
      await ensureSessionsTable(client);
      const companyId = await seedCompany(client);
      const userId = await seedUser(client, ["tenant"], companyId);
      await client.query(
        `insert into auth.sessions (id, user_id, created_at, not_after)
         values ($1, $2, now() - interval '1 hour', now() - interval '1 hour' + interval '6 months')`,
        [randomUUID(), userId],
      );

      await client.query(`set local session_replication_role = replica`);
      await client.query(
        `insert into public.user_roles (company_id, user_id, role) values ($1, $2, 'admin')`,
        [companyId, userId],
      );

      const { rows } = await client.query<{ matches: boolean }>(
        `select not_after = created_at + interval '6 hours' as matches
           from auth.sessions where user_id = $1`,
        [userId],
      );
      expect(rows[0].matches).toBe(true);
    });
  });
});

describe("revoking a role re-boxes the user's open sessions (migration 234)", () => {
  test("a tenant whose only role is revoked keeps a 6-hour box, not 6 months", async () => {
    // A roleless account is boxed like staff by session_lifetime_for(); the
    // DELETE must apply that to a session opened while it was still a tenant.
    await withRollback(async (client) => {
      await ensureSessionsTable(client);
      const companyId = await seedCompany(client);
      const userId = await seedUser(client, ["tenant"], companyId);
      await client.query(
        `insert into auth.sessions (id, user_id, created_at, not_after)
         values ($1, $2, now() - interval '1 hour', now() - interval '1 hour' + interval '6 months')`,
        [randomUUID(), userId],
      );

      await client.query(`delete from public.user_roles where user_id = $1`, [userId]);

      const { rows } = await client.query<{ matches: boolean }>(
        `select not_after = created_at + interval '6 hours' as matches
           from auth.sessions where user_id = $1`,
        [userId],
      );
      expect(rows[0].matches).toBe(true);
    });
  });
});

describe("a backup restore keeps unchanged tenant sessions at 6 months (migrations 235–236)", () => {
  test("delete-then-reinsert of the same tenant role in replica mode ends at 6 months", async () => {
    // backup_restore() empties user_roles and reinserts the archive; a tenant
    // whose role did not change must not come out with a 6-hour session.
    await withRollback(async (client) => {
      await ensureSessionsTable(client);
      const companyId = await seedCompany(client);
      const userId = await seedUser(client, ["tenant"], companyId);
      await client.query(
        `insert into auth.sessions (id, user_id, created_at, not_after)
         values ($1, $2, now() - interval '1 hour', now() - interval '1 hour' + interval '6 months')`,
        [randomUUID(), userId],
      );

      await client.query(`set local session_replication_role = replica`);
      await client.query(`delete from public.user_roles where user_id = $1`, [userId]);
      await client.query(
        `insert into public.user_roles (company_id, user_id, role) values ($1, $2, 'tenant')`,
        [companyId, userId],
      );

      const { rows } = await client.query<{ matches: boolean }>(
        `select not_after = created_at + interval '6 months' as matches
           from auth.sessions where user_id = $1`,
        [userId],
      );
      expect(rows[0].matches).toBe(true);
    });
  });
});

describe("a role change never revives an ended session (migration 236)", () => {
  test("staff whose 6 hours ran out, made tenant-only, stays expired", async () => {
    await withRollback(async (client) => {
      await ensureSessionsTable(client);
      const companyId = await seedCompany(client);
      const userId = await seedUser(client, ["tenant", "accountant"], companyId);
      await client.query(
        `insert into auth.sessions (id, user_id, created_at, not_after)
         values ($1, $2, now() - interval '7 hours', now() - interval '1 hour')`,
        [randomUUID(), userId],
      );

      await client.query(
        `delete from public.user_roles where user_id = $1 and role = 'accountant'`,
        [userId],
      );

      const { rows } = await client.query<{ expired: boolean }>(
        `select not_after < now() as expired from auth.sessions where user_id = $1`,
        [userId],
      );
      expect(rows[0].expired).toBe(true);
    });
  });
});
