import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { closePool, setCompanyClaimContext, withRollback } from "@/db/testDb";

afterAll(closePool);

/** ينشئ شركة اختبار ويضبط سياقها لاختبارات حذف عناصر التصنيف النظامية. */
async function seedCompany(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة تصنيف ${tag}`, `Catalog Co ${tag}`],
  );
  await setCompanyClaimContext(client, rows[0].id);
  return rows[0].id;
}

/**
 * Deleting seeded catalogue rows — inverted from the original assertion.
 *
 * Migration 60 blocked deleting any `is_system` row, because the "System" badge
 * promised protection and nothing enforced it. Migration 61 withdrew that
 * promise instead: on a real deployment 8 of the 10 expense categories are
 * seeded, so the panel refused almost everything an owner wanted to prune.
 *
 * `is_system` now means provenance, not permission. These tests pin the
 * behaviour that replaced the guard — including the part that costs something,
 * which is the last test. They go straight at the tables rather than through
 * the component, because PostgREST is reachable with the same admin JWT and a
 * button's `disabled` attribute is not evidence of anything.
 */

const CATALOGS = [
  {
    table: "public.option_list_items",
    keyColumn: "value",
    seed: `insert into public.option_list_items (company_id, list_id, value, label_ar, label_en, is_system)
           select company_id, id, $1, 'اختبار', 'Test', $2 from public.option_lists limit 1`,
  },
  {
    table: "public.expense_categories",
    keyColumn: "code",
    // `code` is not-null and carries no default.
    seed: `insert into public.expense_categories (code, name_ar, name_en, is_system)
           values ($1, $1, 'Test', $2)`,
  },
] as const;

describe("seeded catalogue rows can be deleted", () => {
  test.each(CATALOGS)(
    "$table deletes a system row instead of refusing it",
    async ({ table, seed, keyColumn }) => {
      await withRollback(async (client) => {
        await seedCompany(client);
        const key = `sys_${Date.now()}`;
        await client.query(seed, [key, true]);
        const { rowCount } = await client.query(
          `delete from ${table} where ${keyColumn} = $1 and is_system`,
          [key],
        );
        expect(rowCount).toBe(1);
      });
    },
  );

  test.each(CATALOGS)("$table still deletes a custom row", async ({ table, seed, keyColumn }) => {
    await withRollback(async (client) => {
      await seedCompany(client);
      const key = `custom_${Date.now()}`;
      await client.query(seed, [key, false]);
      const { rowCount } = await client.query(
        `delete from ${table} where ${keyColumn} = $1 and is_system = false`,
        [key],
      );
      expect(rowCount).toBe(1);
    });
  });
});

/**
 * The consequence the owner accepted when asking for this, pinned so it stays
 * true and stays bounded.
 *
 * `expenses.category_id` is ON DELETE SET NULL, so removing a category in use
 * never raises — it silently un-categorises historical expenses. Both halves
 * matter: the expense and its amount must survive (nothing financial is lost),
 * and the link must be gone (it lands in the uncategorised bucket of the budget
 * report). A future migration that switched this to ON DELETE CASCADE would
 * destroy expense records, and this test is what would catch it.
 */
test("deleting a category in use keeps the expense and clears only its category", async () => {
  await withRollback(async (client) => {
    const companyId = await seedCompany(client);
    const code = `used_${Date.now()}`;
    const { rows: category } = await client.query(
      `insert into public.expense_categories (company_id, code, name_ar, name_en, is_system)
       values ($1, $2, $2, 'Test', true) returning id`,
      [companyId, code],
    );
    const { rows: expense } = await client.query(
      `insert into public.expenses (company_id, category_id, amount) values ($1, $2, 125.500) returning id`,
      [companyId, category[0].id],
    );

    await client.query(`delete from public.expense_categories where id = $1`, [category[0].id]);

    const { rows: after } = await client.query(
      `select amount, category_id from public.expenses where id = $1`,
      [expense[0].id],
    );
    expect(after).toHaveLength(1);
    expect(Number(after[0].amount)).toBe(125.5);
    expect(after[0].category_id).toBeNull();
  });
});
