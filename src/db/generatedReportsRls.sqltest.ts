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

/**
 * RLS + grants for public.generated_reports delete path (migration 98).
 *
 * The load-bearing case is staff without reports.delete: RLS denies silently
 * (zero rows affected), not a raise — that is what the bulk-delete UI would
 * have shipped as a green success that deleted nothing before the policy.
 */

/** ينشئ شركة اختبارية معزولة لاختبارات صلاحيات التقارير المولّدة. */
async function seedCompany(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة تقارير ${tag}`, `Reports Co ${tag}`],
  );
  return rows[0].id;
}

/** يزرع صف تقرير مولّد مرتبطاً بشركة محددة. */
async function seedGeneratedReport(client: PoolClient, companyId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.generated_reports (company_id, html_content, sent)
     values ($1, '<p>fixture</p>', false)
     returning id`,
    [companyId],
  );
  return rows[0].id;
}

describe("generated_reports delete RLS (migration 98)", () => {
  test("staff without reports.delete deletes zero rows (row still exists)", async () => {
    // Accountant is staff (is_staff) and may read/export reports, but does not
    // hold reports.delete. Assert the row survives — do not assert a raise.
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const reportId = await seedGeneratedReport(client, companyId);
      const accountant = await seedCompanyUser(client, companyId, "accountant");
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
      const companyId = await seedCompany(client);
      const reportId = await seedGeneratedReport(client, companyId);
      const admin = await seedCompanyUser(client, companyId, "admin");
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
      const companyId = await seedCompany(client);
      const reportId = await seedGeneratedReport(client, companyId);
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
      const companyId = await seedCompany(client);
      const admin = await seedCompanyUser(client, companyId, "admin");
      await actAs(client, "authenticated", admin);

      const raised = await captureRaise(client, () =>
        client.query(
          `insert into public.generated_reports (company_id, html_content, sent)
           values ($1, '<p>should-not-insert</p>', false)`,
          [companyId],
        ),
      );
      expect(raised).toMatch(/permission denied/i);
    });
  });
});
