import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { actAs, actAsSuperuser, captureRaise, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * RLS + grants for public.generated_reports delete path (migration 98).
 *
 * The load-bearing case is staff without reports.delete: RLS denies silently
 * (zero rows affected), not a raise — that is what the bulk-delete UI would
 * have shipped as a green success that deleted nothing before the policy.
 */

async function seedUserWithRole(client: PoolClient, role: string): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@example.test`],
  );
  await client.query(
    `insert into public.user_roles (user_id, role) values ($1, $2::public.app_role)`,
    [userId, role],
  );
  return userId;
}

async function seedGeneratedReport(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.generated_reports (html_content, sent)
     values ('<p>fixture</p>', false)
     returning id`,
  );
  return rows[0].id;
}

describe("generated_reports delete RLS (migration 98)", () => {
  test("staff without reports.delete deletes zero rows (row still exists)", async () => {
    // Accountant is staff (is_staff) and may read/export reports, but does not
    // hold reports.delete. Assert the row survives — do not assert a raise.
    await withRollback(async (client) => {
      const reportId = await seedGeneratedReport(client);
      const accountant = await seedUserWithRole(client, "accountant");
      await actAs(client, "authenticated", accountant);

      const deleted = await client.query(
        `delete from public.generated_reports where id = $1 returning id`,
        [reportId],
      );
      expect(deleted.rows).toHaveLength(0);

      await actAsSuperuser(client);
      const still = await client.query(`select id from public.generated_reports where id = $1`, [
        reportId,
      ]);
      expect(still.rows).toHaveLength(1);
    });
  });

  test("user with reports.delete can delete the row", async () => {
    await withRollback(async (client) => {
      const reportId = await seedGeneratedReport(client);
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const deleted = await client.query(
        `delete from public.generated_reports where id = $1 returning id`,
        [reportId],
      );
      expect(deleted.rows).toHaveLength(1);

      await actAsSuperuser(client);
      const gone = await client.query(`select id from public.generated_reports where id = $1`, [
        reportId,
      ]);
      expect(gone.rows).toHaveLength(0);
    });
  });

  test("anon cannot select or delete", async () => {
    await withRollback(async (client) => {
      const reportId = await seedGeneratedReport(client);
      await actAs(client, "anon");

      expect(
        await captureRaise(client, () =>
          client.query(`select 1 from public.generated_reports where id = $1`, [reportId]),
        ),
      ).toMatch(/permission denied/i);

      expect(
        await captureRaise(client, () =>
          client.query(`delete from public.generated_reports where id = $1`, [reportId]),
        ),
      ).toMatch(/permission denied/i);
    });
  });

  test("authenticated INSERT into generated_reports is rejected (privilege, not RLS)", async () => {
    // Privilege error (SQLSTATE 42501 / "permission denied") — not an RLS
    // filter. Migration 98 revokes ALL from authenticated then re-grants only
    // select + delete; INSERT is intentionally gone because every write goes
    // through service_role. Contrast the delete-without-permission case above,
    // which correctly asserts zero-rows-affected: DELETE is granted, so the
    // statement runs and RLS filters the row. INSERT is not granted, so the
    // statement fails at the privilege gate before RLS. That distinction is
    // exactly the trap this suite exists to document.
    await withRollback(async (client) => {
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const raised = await captureRaise(client, () =>
        client.query(
          `insert into public.generated_reports (html_content, sent)
           values ('<p>should-not-insert</p>', false)`,
        ),
      );
      expect(raised).toMatch(/permission denied/i);
    });
  });
});
