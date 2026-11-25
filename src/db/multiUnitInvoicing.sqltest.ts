import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { captureRaise, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * A contract with no `contract_units` rows at all.
 *
 * Migration 110 defaulted `contracts.monthly_amount` to 0 and 118 dropped the
 * NOT NULL `unit_id`, so this shape became insertable for the first time —
 * which is exactly what final-review M1 flags.
 */
async function seedUnitlessContract(client: PoolClient, tenantId: string): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const contract = await client.query<{ id: string }>(
    `insert into public.contracts
       (code, tenant_id, start_date, end_date, due_day, grace_days, deposit, state)
     values ($1, $2, '2026-01-01', '2026-12-31', 1, 0, 0, 'active')
     returning id`,
    [`C-unitless-${tag}`, tenantId],
  );
  return contract.rows[0].id;
}

describe("consolidated invoicing", () => {
  it("bills three units as one invoice with three rent lines", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-03-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });
      await client.query(`select * from public.generate_invoices_for_year($1, 2026, true)`, [
        fixture.contractId,
      ]);

      const invoices = await client.query(
        `select id, total, unit_id, period_month from public.invoices
          where contract_id = $1 order by period_month`,
        [fixture.contractId],
      );
      expect(invoices.rowCount).toBe(3);
      expect(Number(invoices.rows[0].total)).toBe(1200);
      // Several units -> the invoice belongs to no single unit.
      expect(invoices.rows[0].unit_id).toBeNull();

      const items = await client.query(
        `select unit_id, amount, line from public.invoice_items
          where invoice_id = $1 and is_concession = false order by line`,
        [invoices.rows[0].id],
      );
      expect(items.rowCount).toBe(3);
      expect(items.rows.map((r) => Number(r.amount))).toEqual([400, 400, 400]);
      expect(new Set(items.rows.map((r) => r.unit_id)).size).toBe(3);
      expect(items.rows.every((r) => r.unit_id !== null)).toBe(true);
    });
  });

  it("still stamps invoices.unit_id for a single-unit contract", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        state: "active",
        monthlyAmount: 500,
      });
      await client.query(`select * from public.generate_invoices_for_year($1, 2026, true)`, [
        fixture.contractId,
      ]);
      const invoice = await client.query(
        `select unit_id, total from public.invoices where contract_id = $1`,
        [fixture.contractId],
      );
      expect(invoice.rows[0].unit_id).toBe(fixture.unitId);
      expect(Number(invoice.rows[0].total)).toBe(500);
    });
  });

  it("is idempotent — generating twice does not duplicate lines", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });
      await client.query(`select * from public.generate_invoices_for_year($1, 2026, true)`, [
        fixture.contractId,
      ]);
      await client.query(`select * from public.generate_invoices_for_year($1, 2026, true)`, [
        fixture.contractId,
      ]);
      const counts = await client.query(
        `select (select count(*) from public.invoices where contract_id = $1)::int invoices,
                (select count(*) from public.invoice_items ii
                  join public.invoices i on i.id = ii.invoice_id
                 where i.contract_id = $1)::int items`,
        [fixture.contractId],
      );
      expect(counts.rows[0].invoices).toBe(1);
      expect(counts.rows[0].items).toBe(2);
    });
  });

  it("generation leaves a multi-unit invoice undiscounted; apply binds 100 once", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });
      const { rows: concession } = await client.query<{ id: string }>(
        `insert into public.concessions
           (contract_id, type, discount_amount, start_date, end_date, status)
         values ($1, 'fixed_discount', 100, '2026-01-01', '2026-12-31', 'active')
         returning id`,
        [fixture.contractId],
      );
      await client.query(`select * from public.generate_invoices_for_year($1, 2026, true)`, [
        fixture.contractId,
      ]);
      const generated = await client.query<{
        id: string;
        subtotal: string;
        discount: string;
        total: string;
      }>(
        `select id, subtotal::text, discount::text, total::text from public.invoices where contract_id = $1`,
        [fixture.contractId],
      );
      expect(Number(generated.rows[0].subtotal)).toBe(800);
      expect(Number(generated.rows[0].discount)).toBe(0);
      expect(Number(generated.rows[0].total)).toBe(800);

      await client.query(`select * from public.apply_concession_to_invoices($1, $2::uuid[])`, [
        concession[0].id,
        [generated.rows[0].id],
      ]);
      const applied = await client.query(
        `select subtotal, discount, total from public.invoices where contract_id = $1`,
        [fixture.contractId],
      );
      expect(Number(applied.rows[0].subtotal)).toBe(800);
      expect(Number(applied.rows[0].discount)).toBe(100);
      expect(Number(applied.rows[0].total)).toBe(700);

      const items = await client.query(
        `select count(*)::int n from public.invoice_items
          where invoice_id = $1 and is_concession = true`,
        [generated.rows[0].id],
      );
      expect(items.rows[0].n).toBe(1);
    });
  });
});

/**
 * Final review M1. Before migration 119 a unit-less contract summed to a 0
 * subtotal and produced twelve zero-total invoices a year with no rent lines
 * at all — forever, silently. "Bills nothing" is a worse failure than an
 * error.
 *
 * The guard follows migration 82's established asymmetry: RAISE on the
 * direct-id path, SKIP on the bulk path, so one malformed contract cannot
 * abort a whole-portfolio generate or the nightly cron.
 */
describe("a contract with no units is refused, not billed as zero", () => {
  it("raises when generate_invoices_for_year is given its id directly", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const unitless = await seedUnitlessContract(client, fixture.tenantId);

      const message = await captureRaise(client, () =>
        client.query(`select * from public.generate_invoices_for_year($1, 2026, true)`, [unitless]),
      );
      expect(message).toMatch(/has no units/i);

      const invoices = await client.query(
        `select count(*)::int n from public.invoices where contract_id = $1`,
        [unitless],
      );
      expect(invoices.rows[0].n).toBe(0);
    });
  });

  it("raises when contract_period_amounts is asked to price it", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const unitless = await seedUnitlessContract(client, fixture.tenantId);

      const message = await captureRaise(client, () =>
        client.query(`select * from public.contract_period_amounts($1, '2026-01-01'::date)`, [
          unitless,
        ]),
      );
      // The defect: it returned subtotal 0 / total 0, indistinguishable from a
      // genuinely free period.
      expect(message).toMatch(/has no units/i);
    });
  });

  it("is skipped, not raised on, by a bulk portfolio generate", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const unitless = await seedUnitlessContract(client, fixture.tenantId);

      // Must complete: raising here would abort the nightly cron for every
      // other contract in the portfolio.
      await client.query(`select * from public.generate_invoices_for_year(null, 2026, false)`);

      const counts = await client.query(
        `select (select count(*) from public.invoices where contract_id = $1)::int unitless,
                (select count(*) from public.invoices where contract_id = $2)::int healthy`,
        [unitless, fixture.contractId],
      );
      expect(counts.rows[0].unitless).toBe(0);
      expect(counts.rows[0].healthy).toBeGreaterThan(0);
    });
  });
});
