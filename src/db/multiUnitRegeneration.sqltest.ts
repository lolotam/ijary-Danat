import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { closePool, seedContract, withRollback } from "@/db/testDb";

/** An extra vacant unit under the same property, for growing a contract. */
async function addUnit(client: PoolClient, propertyId: string): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const unit = await client.query<{ id: string }>(
    `insert into public.units (code, property_id, name) values ($1, $2, $3) returning id`,
    [`U-extra-${tag}`, propertyId, `Extra unit ${tag}`],
  );
  return unit.rows[0].id;
}

async function invoiceUnitId(client: PoolClient, contractId: string): Promise<string | null> {
  const result = await client.query<{ unit_id: string | null }>(
    `select unit_id from public.invoices where contract_id = $1`,
    [contractId],
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0].unit_id;
}

afterAll(closePool);

/**
 * Task 11 — regeneration must keep per-unit rent-line attribution.
 *
 * Migration 112 taught generate_invoices_for_year to emit one invoice_items
 * rent line per unit, sourced from public.contract_units. Migration 116 gives
 * regenerate_contract_invoices (and the contract_period_amounts helper it
 * calls) the same treatment. Left alone, regenerating a three-unit
 * contract's invoice would replace its three attributed rent lines with one
 * line carrying the correct total and a NULL unit_id — the total still
 * balances, so nothing raises, and per-property revenue reporting silently
 * stops working. This test guards exactly that regression.
 */

describe("regeneration keeps per-unit attribution", () => {
  test("rebuilds three rent lines, not one combined line", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });
      await client.query(`select * from public.generate_invoices_for_year($1, 2026, true)`, [
        fixture.contractId,
      ]);
      await client.query(`select * from public.regenerate_contract_invoices($1)`, [
        fixture.contractId,
      ]);

      const invoice = await client.query<{ id: string; total: string }>(
        `select id, total from public.invoices where contract_id = $1`,
        [fixture.contractId],
      );
      expect(invoice.rowCount).toBe(1);
      expect(Number(invoice.rows[0].total)).toBe(1200);

      const items = await client.query<{ unit_id: string | null; amount: string }>(
        `select unit_id, amount from public.invoice_items
          where invoice_id = $1 and is_concession = false order by line`,
        [invoice.rows[0].id],
      );
      // The defect this guards: regeneration collapsing three attributed lines
      // into one un-attributed line with the correct total. Nothing fails, and
      // per-property revenue reporting silently stops working.
      expect(items.rowCount).toBe(3);
      expect(items.rows.every((r) => r.unit_id !== null)).toBe(true);
      expect(items.rows.map((r) => Number(r.amount))).toEqual([400, 400, 400]);
    });
  });
});

/**
 * Final review I2. Migration 112 writes `invoices.unit_id` only on INSERT, and
 * its `on conflict ... do nothing` means an existing invoice is never
 * revisited — so before migration 119 the column froze for the life of the
 * invoice while the rent lines beneath it were rebuilt on every regeneration.
 *
 * The fixture above cannot catch this: it is three-unit from creation, so
 * `invoices.unit_id` is NULL before and after and the transition is never
 * exercised. These two tests exercise the transitions in both directions.
 *
 * Why it is not cosmetic: `set_invoice_paid` (migration 108) copies
 * `invoices.unit_id` into `payments.unit_id`. A consolidated invoice still
 * naming one of its units stamps the whole payment as belonging to that unit.
 */
describe("regeneration refreshes invoices.unit_id", () => {
  test("1 -> N: adding a second unit clears the invoice's single-unit attribution", async () => {
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
      expect(await invoiceUnitId(client, fixture.contractId)).toBe(fixture.unitId);

      const extraUnitId = await addUnit(client, fixture.propertyId);
      await client.query(
        `insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
         values ($1, $2, 300, 2)`,
        [fixture.contractId, extraUnitId],
      );
      await client.query(`select * from public.regenerate_contract_invoices($1)`, [
        fixture.contractId,
      ]);

      // The defect: the invoice still named the original unit while carrying
      // rent lines for two, so a payment against it was stamped to one unit.
      expect(await invoiceUnitId(client, fixture.contractId)).toBeNull();

      const items = await client.query<{ unit_id: string | null }>(
        `select unit_id from public.invoice_items
          where invoice_id = (select id from public.invoices where contract_id = $1)
            and is_concession = false order by line`,
        [fixture.contractId],
      );
      expect(items.rows.map((r) => r.unit_id)).toEqual([fixture.unitId, extraUnitId]);
    });
  });

  test("N -> 1: dropping down to one unit restores the invoice's attribution", async () => {
    await withRollback(async (client: PoolClient) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 300 }],
      });
      await client.query(`select * from public.generate_invoices_for_year($1, 2026, true)`, [
        fixture.contractId,
      ]);
      expect(await invoiceUnitId(client, fixture.contractId)).toBeNull();

      await client.query(
        `delete from public.contract_units where contract_id = $1 and line_order = 2`,
        [fixture.contractId],
      );
      await client.query(`select * from public.regenerate_contract_invoices($1)`, [
        fixture.contractId,
      ]);

      // The mirror defect: stayed NULL when it should now name the survivor.
      expect(await invoiceUnitId(client, fixture.contractId)).toBe(fixture.unitIds[0]);
    });
  });
});
