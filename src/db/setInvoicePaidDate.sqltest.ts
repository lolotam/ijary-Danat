import { afterAll, describe, expect, test } from "vitest";

import { closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 226: a manually marked payment is dated the day it was recorded.
 *
 * Before 226 set_invoice_paid wrote `least(due_date, current_date)`, so an old
 * invoice marked paid today was filed under its own months-old collection month
 * and the printed invoice showed that date as when the tenant paid.
 */
describe("set_invoice_paid payment date (migration 226)", () => {
  test("marking a long-overdue invoice paid dates the payment today, not at its due date", async () => {
    await withRollback(async (client) => {
      const base = await seedContract(client, {
        startDate: "2020-01-01",
        endDate: "2020-12-31",
        monthlyAmount: 400,
      });
      const { rows } = await client.query<{ id: string }>(
        `insert into public.invoices (
           code, company_id, contract_id, tenant_id, unit_id,
           period_year, period_month, issue_date, due_date,
           subtotal, discount, total, paid, state, is_visible_to_tenant, idempotency_key
         ) values (
           'INV-date-' || substr($1::text, 1, 8), $2::uuid, $1::uuid, $3::uuid, $4::uuid,
           2020, 1, '2020-01-01', '2020-01-01',
           400, 0, 400, 0, 'overdue', true, $1::text || ':date:2020:1'
         ) returning id`,
        [base.contractId, base.companyId, base.tenantId, base.unitId],
      );

      const paid = await client.query<{ payment_id: string }>(
        `select payment_id from public.set_invoice_paid($1::uuid, true, 'bank_transfer')`,
        [rows[0].id],
      );
      const payment = await client.query<{ is_today: boolean }>(
        `select payment_date = current_date as is_today from public.payments where id = $1`,
        [paid.rows[0].payment_id],
      );

      expect(payment.rows[0].is_today).toBe(true);
    });
  });
});
