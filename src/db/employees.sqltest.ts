import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import {
  actAs,
  actAsSuperuser,
  closePool,
  seedCompanyUser,
  setCompanyClaimContext,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/**
 * T14a — employees, their documents, and monthly salary generation.
 *
 * The assertion that matters is idempotency: a payroll job that can run twice
 * and double someone's pay is worse than one that never runs.
 */

/** ينشئ شركة اختبار ويعيد معرّفها مع تهيئة سياق الشركة. */
async function seedCompany(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة اختبار ${tag}`, `Test Co ${tag}`],
  );
  const companyId = rows[0].id;
  await setCompanyClaimContext(client, companyId);
  return companyId;
}

/** يزرع موظفاً ضمن الشركة المحددة ويعيد معرّفه. */
async function seedEmployee(
  client: PoolClient,
  companyId: string,
  overrides: { salary?: number; isActive?: boolean } = {},
) {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.employees (company_id, name, salary, is_active)
     values ($1, $2, $3, $4) returning id`,
    [companyId, `موظف ${tag}`, overrides.salary ?? 400, overrides.isActive ?? true],
  );
  return rows[0].id;
}

/** ينشئ مستخدماً بدور محدد ضمن الشركة. */
async function seedUserWithRole(
  client: PoolClient,
  companyId: string,
  role: string,
): Promise<string> {
  return seedCompanyUser(client, companyId, role, "emp");
}

/** يعيد صفوف الرواتب المولّدة للشركة والسنة والشهر المحددين. */
async function salariesFor(client: PoolClient, companyId: string, year: number, month: number) {
  const { rows } = await client.query<{ employee_id: string; amount: string }>(
    `select employee_id, amount from public.salaries
      where company_id = $1 and year = $2 and month = $3`,
    [companyId, year, month],
  );
  return rows;
}

describe("monthly salary generation", () => {
  test("running it twice produces one row per employee", async () => {
    // The cron job's whole safety property. Without the unique constraint plus
    // `on conflict do nothing`, a retried tick pays everyone twice.
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      await seedEmployee(client, companyId);
      await seedEmployee(client, companyId);

      const first = await client.query(`select * from public.generate_salaries_for_month(2026, 5)`);
      expect(first.rows).toHaveLength(2);

      const second = await client.query(
        `select * from public.generate_salaries_for_month(2026, 5)`,
      );
      expect(second.rows).toHaveLength(0);

      expect(await salariesFor(client, companyId, 2026, 5)).toHaveLength(2);
    });
  });

  test("inactive employees are skipped", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const active = await seedEmployee(client, companyId, { isActive: true });
      await seedEmployee(client, companyId, { isActive: false });

      await client.query(`select * from public.generate_salaries_for_month(2026, 6)`);

      const rows = await salariesFor(client, companyId, 2026, 6);
      expect(rows).toHaveLength(1);
      expect(rows[0].employee_id).toBe(active);
    });
  });

  test("the amount is copied, so a later raise does not rewrite history", async () => {
    // A join at read time would silently restate months already delivered — the
    // payroll equivalent of recomputing a paid invoice.
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const employee = await seedEmployee(client, companyId, { salary: 400 });
      await client.query(`select * from public.generate_salaries_for_month(2026, 7)`);
      await client.query(`update public.employees set salary = 900 where id = $1`, [employee]);

      const rows = await salariesFor(client, companyId, 2026, 7);
      expect(rows[0].amount).toBe("400.000");
    });
  });

  test("a duplicate salary row is rejected outright", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const employee = await seedEmployee(client, companyId);
      const insert = `insert into public.salaries (company_id, employee_id, year, month, amount)
                      values ($1, $2, 2026, 8, 400)`;
      await client.query(insert, [companyId, employee]);
      await expect(client.query(insert, [companyId, employee])).rejects.toThrow(
        /duplicate key|unique/i,
      );
    });
  });

  test("an out-of-range month is refused", async () => {
    await withRollback(async (client) => {
      await expect(
        client.query(`select * from public.generate_salaries_for_month(2026, 13)`),
      ).rejects.toThrow(/month is outside/i);
    });
  });
});

describe("employee documents carry an expiry date", () => {
  test("expiry_date exists and is queryable by range", async () => {
    // This column is why employee_documents is not simply tenant_documents
    // reused — tenant_documents has no expiry_date at all.
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const employee = await seedEmployee(client, companyId);
      await client.query(
        `insert into public.employee_documents (company_id, employee_id, storage_path, expiry_date)
         values ($1, $2, 'employee-documents/a.pdf', '2026-09-30')`,
        [companyId, employee],
      );
      await client.query(
        `insert into public.employee_documents (company_id, employee_id, storage_path, expiry_date)
         values ($1, $2, 'employee-documents/b.pdf', null)`,
        [companyId, employee],
      );

      const { rows } = await client.query(
        `select id from public.employee_documents
          where company_id = $1 and expiry_date between '2026-09-01' and '2026-10-31'`,
        [companyId],
      );
      expect(rows).toHaveLength(1);
    });
  });

  test("tenant_documents still has no expiry_date, which is the reason this table exists", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `select count(*)::text as count from information_schema.columns
          where table_name = 'tenant_documents' and column_name = 'expiry_date'`,
      );
      expect(rows[0].count).toBe("0");
    });
  });
});

describe("RLS", () => {
  test("a signed-in non-staff user sees no employees and no salaries", async () => {
    // Salary figures must never reach a tenant portal user.
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const employee = await seedEmployee(client, companyId);
      await client.query(
        `insert into public.salaries (company_id, employee_id, year, month, amount)
         values ($1, $2, 2026, 9, 400)`,
        [companyId, employee],
      );

      await actAs(client, "authenticated", randomUUID());
      expect((await client.query(`select id from public.employees`)).rows).toHaveLength(0);
      expect((await client.query(`select id from public.salaries`)).rows).toHaveLength(0);
    });
  });

  test("anon sees nothing", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      await seedEmployee(client, companyId);
      await actAs(client, "anon");
      expect((await client.query(`select id from public.employees`)).rows).toHaveLength(0);
    });
  });

  test("an accountant may record but not delete", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const accountant = await seedUserWithRole(client, companyId, "accountant");
      await actAs(client, "authenticated", accountant);

      const created = await client.query<{ id: string }>(
        `insert into public.employees (name, salary) values ('موظف', 500) returning id`,
      );
      expect(created.rows).toHaveLength(1);

      const deleted = await client.query(
        `delete from public.employees where id = $1 returning id`,
        [created.rows[0].id],
      );
      expect(deleted.rows).toHaveLength(0);

      await actAsSuperuser(client);
      const still = await client.query(`select id from public.employees where id = $1`, [
        created.rows[0].id,
      ]);
      expect(still.rows).toHaveLength(1);
    });
  });

  test("an admin can delete an employee, cascading their documents", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const employee = await seedEmployee(client, companyId);
      await client.query(
        `insert into public.employee_documents (company_id, employee_id, storage_path)
         values ($1, $2, 'employee-documents/a.pdf')`,
        [companyId, employee],
      );
      const admin = await seedUserWithRole(client, companyId, "admin");

      await actAs(client, "authenticated", admin);
      const deleted = await client.query(
        `delete from public.employees where id = $1 returning id`,
        [employee],
      );
      expect(deleted.rows).toHaveLength(1);

      await actAsSuperuser(client);
      const docs = await client.query(
        `select id from public.employee_documents where employee_id = $1`,
        [employee],
      );
      expect(docs.rows).toHaveLength(0);
    });
  });
});
