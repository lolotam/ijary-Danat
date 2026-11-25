import { afterAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

import { closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

const MIGRATION = readFileSync("db/migrations/195_due_day_first.sql", "utf8");

/**
 * Migration 195 — rent is due on the 1st of its month. 67 of 70 production
 * contracts carried 15 as typed data; the bulk update moves them and every
 * unpaid invoice they own, and leaves settled money and closed contracts alone.
 */

/**
 * تواريخ استحقاق فواتير العقد مرتبة حسب الشهر.
 */
async function dueDates(client: import("pg").PoolClient, contractId: string) {
  const { rows } = await client.query<{ period_month: number; due_date: string }>(
    `select period_month, to_char(due_date, 'YYYY-MM-DD') as due_date from public.invoices where contract_id = $1 order by period_month`,
    [contractId],
  );
  return new Map(rows.map((r) => [r.period_month, r.due_date] as const));
}

describe("migration 195 due day", () => {
  test("moves open contracts and their unpaid invoices to the 1st, idempotently", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        dueDay: 15,
      });
      await client.query(`select public.generate_invoices_for_year($1, 2026, true)`, [
        fx.contractId,
      ]);
      await client.query(
        `update public.invoices set state = 'paid', paid = total where contract_id = $1 and period_month = 1`,
        [fx.contractId],
      );
      await client.query(
        `update public.invoices set state = 'waived' where contract_id = $1 and period_month = 2`,
        [fx.contractId],
      );

      await client.query(MIGRATION);
      await client.query(MIGRATION);

      const contract = await client.query(`select due_day from public.contracts where id = $1`, [
        fx.contractId,
      ]);
      expect(contract.rows[0].due_day).toBe(1);
      const dates = await dueDates(client, fx.contractId);
      expect(dates.get(1)).toBe("2026-01-15");
      expect(dates.get(2)).toBe("2026-02-15");
      expect(dates.get(3)).toBe("2026-03-01");
    });
  });

  test("a terminated contract keeps its due day", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2025-01-01",
        endDate: "2025-12-31",
        dueDay: 15,
        state: "terminated",
      });
      await client.query(MIGRATION);
      const contract = await client.query(`select due_day from public.contracts where id = $1`, [
        fx.contractId,
      ]);
      expect(contract.rows[0].due_day).toBe(15);
    });
  });

  test("a terminated contract already on day 1 keeps its historical invoice dates", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2025-01-01",
        endDate: "2025-12-31",
        dueDay: 1,
        state: "terminated",
      });
      await client.query(`select public.generate_invoices_for_year($1, 2025, true)`, [
        fx.contractId,
      ]);
      await client.query(
        `update public.invoices set due_date = make_date(2025, period_month, 15) where contract_id = $1`,
        [fx.contractId],
      );
      await client.query(MIGRATION);
      const dates = await dueDates(client, fx.contractId);
      expect(dates.get(1)).toBe("2025-01-15");
    });
  });
});
