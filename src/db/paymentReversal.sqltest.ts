import { afterAll, describe, expect, test } from "vitest";

import { closePool, seedContract, withRollback } from "@/db/testDb";
import type { PoolClient } from "pg";

afterAll(closePool);

/**
 * reverse_payment (05_phase3_invoices_payments.sql:590-664) does not write a
 * negative counter-entry. It creates a mirror payment row with
 * status='reversed' and then inserts allocations on it with **positive**
 * amounts (:656-657) — because payment_allocations has `check (amount > 0)`.
 *
 * Consequently `sum(payment_allocations.amount)` double-counts a reversed
 * payment. Any aggregate over allocations MUST filter by payments.status /
 * reversed_by_payment_id. get_budget_summary does this correctly
 * (08_phase6_expenses_deposits_budget.sql:254); set_invoice_paid does not
 * (23_invoice_backfill_and_manual_payment.sql:285).
 *
 * Batch D's refunds table aggregates over this data, so these tests pin the
 * behaviour before that work starts.
 */

/** Contract with one generated invoice, fully paid, then reversed. */
async function reversedPaymentScenario(client: PoolClient) {
  const fx = await seedContract(client, {
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    monthlyAmount: 300,
  });

  await client.query(`select public.generate_invoices($1::uuid, 2026)`, [fx.contractId]);
  const invoice = await client.query<{ id: string; total: string }>(
    `select id, total from public.invoices where contract_id = $1
      order by period_year, period_month limit 1`,
    [fx.contractId],
  );
  const invoiceId = invoice.rows[0].id;
  const amount = Number(invoice.rows[0].total);

  const payment = await client.query<{ id: string }>(
    `insert into public.payments (code, tenant_id, method, amount, payment_date, status)
     values (public.next_payment_code(), $1, 'cash', $2, current_date, 'confirmed')
     returning id`,
    [fx.tenantId, amount],
  );
  const paymentId = payment.rows[0].id;

  await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
    paymentId,
    JSON.stringify([{ invoice_id: invoiceId, amount }]),
  ]);

  return { ...fx, invoiceId, paymentId, amount };
}

async function allocationSum(client: PoolClient, invoiceId: string, filtered: boolean) {
  const sql = filtered
    ? `select coalesce(sum(pa.amount), 0) as total
         from public.payment_allocations pa
         join public.payments p on p.id = pa.payment_id
        where pa.invoice_id = $1
          and p.status = 'confirmed' and p.reversed_by_payment_id is null`
    : `select coalesce(sum(pa.amount), 0) as total
         from public.payment_allocations pa where pa.invoice_id = $1`;
  const { rows } = await client.query<{ total: string }>(sql, [invoiceId]);
  return Number(rows[0].total);
}

describe("reverse_payment", () => {
  test("restores the invoice to unpaid", async () => {
    await withRollback(async (client) => {
      const s = await reversedPaymentScenario(client);

      const paid = await client.query<{ paid: string; state: string }>(
        `select paid, state from public.invoices where id = $1`,
        [s.invoiceId],
      );
      expect(Number(paid.rows[0].paid)).toBe(s.amount);
      expect(paid.rows[0].state).toBe("paid");

      await client.query(`select public.reverse_payment($1::uuid, $2)`, [
        s.paymentId,
        "tenant cheque bounced",
      ]);

      const after = await client.query<{ paid: string; state: string }>(
        `select paid, state from public.invoices where id = $1`,
        [s.invoiceId],
      );
      expect(Number(after.rows[0].paid)).toBe(0);
      expect(after.rows[0].state).not.toBe("paid");
    });
  });

  test("mirror allocations are positive, so a naive sum double-counts", async () => {
    await withRollback(async (client) => {
      const s = await reversedPaymentScenario(client);
      await client.query(`select public.reverse_payment($1::uuid, $2)`, [s.paymentId, "reason"]);

      // The trap: reversing money made the raw total go UP, not to zero.
      expect(await allocationSum(client, s.invoiceId, false)).toBe(s.amount * 2);

      // The correct query — this is the shape Batch D's refund aggregates and
      // any new budget key must use.
      expect(await allocationSum(client, s.invoiceId, true)).toBe(0);
    });
  });

  test("the mirror row points back at the original, which is marked reversed", async () => {
    await withRollback(async (client) => {
      const s = await reversedPaymentScenario(client);
      await client.query(`select public.reverse_payment($1::uuid, $2)`, [s.paymentId, "reason"]);

      // Direction matters for every aggregate: reversed_by_payment_id lives on
      // the MIRROR and points at the original (05:639). The original itself
      // only has its status flipped (05:665), so a query filtering solely on
      // `reversed_by_payment_id is null` would still count the original.
      const original = await client.query<{
        status: string;
        reversed_by_payment_id: string | null;
      }>(`select status, reversed_by_payment_id from public.payments where id = $1`, [s.paymentId]);
      expect(original.rows[0].status).toBe("reversed");
      expect(original.rows[0].reversed_by_payment_id).toBeNull();

      const mirror = await client.query<{ id: string; status: string; amount: string }>(
        `select id, status, amount from public.payments where reversed_by_payment_id = $1`,
        [s.paymentId],
      );
      expect(mirror.rows).toHaveLength(1);
      expect(mirror.rows[0].status).toBe("reversed");
      expect(Number(mirror.rows[0].amount)).toBe(s.amount);
    });
  });

  test("filtering on reversed_by_payment_id alone is not enough", async () => {
    await withRollback(async (client) => {
      const s = await reversedPaymentScenario(client);
      await client.query(`select public.reverse_payment($1::uuid, $2)`, [s.paymentId, "reason"]);

      // The tempting-but-wrong filter still sees the original's allocation.
      const { rows } = await client.query<{ total: string }>(
        `select coalesce(sum(pa.amount), 0) as total
           from public.payment_allocations pa
           join public.payments p on p.id = pa.payment_id
          where pa.invoice_id = $1 and p.reversed_by_payment_id is null`,
        [s.invoiceId],
      );
      expect(Number(rows[0].total)).toBe(s.amount);
    });
  });

  test("a payment cannot be reversed twice", async () => {
    await withRollback(async (client) => {
      const s = await reversedPaymentScenario(client);
      await client.query(`select public.reverse_payment($1::uuid, $2)`, [s.paymentId, "first"]);
      await expect(
        client.query(`select public.reverse_payment($1::uuid, $2)`, [s.paymentId, "second"]),
      ).rejects.toThrow();
    });
  });

  // Marking a reversed invoice paid/unpaid is covered by
  // setInvoicePaidReversal.sqltest.ts (migration 246).
  test("the reversed invoice is left correct", async () => {
    await withRollback(async (client) => {
      const s = await reversedPaymentScenario(client);
      await client.query(`select public.reverse_payment($1::uuid, $2)`, [s.paymentId, "reason"]);

      const { rows } = await client.query<{ paid: string; state: string }>(
        `select paid, state from public.invoices where id = $1`,
        [s.invoiceId],
      );
      expect(Number(rows[0].paid)).toBe(0);
      expect(["due", "overdue"]).toContain(rows[0].state);
    });
  });
});
