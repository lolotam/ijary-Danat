import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

interface InvoiceFixture {
  contractId: string;
  companyId: string;
  tenantId: string;
  unitId: string;
}

/**
 * يُدخل فاتورة بحالة ومبلغ وتاريخ استحقاق معلومين، ويعيد معرّفها.
 *
 * Direct insert rather than generate_invoices: the precedence question is
 * about what recompute *reads* (due_date + grace vs confirmed allocations),
 * not about generation, and a hand-built row states the inputs outright.
 */
async function insertInvoice(
  client: PoolClient,
  fx: InvoiceFixture,
  options: { dueDateSql: string; total: number; state: string; tag: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.invoices (
       code, company_id, contract_id, tenant_id, unit_id,
       period_year, period_month, issue_date, due_date,
       subtotal, discount, total, paid, state, is_visible_to_tenant, idempotency_key
     )
     values (
       'INV-rec218-' || substr(gen_random_uuid()::text, 1, 8),
       $2::uuid, $1::uuid, $3::uuid, $4::uuid,
       2026, 1, current_date, ${options.dueDateSql},
       $5, 0, $5, 0, $6::public.invoice_states, true,
       $1::text || ':rec218:${options.tag}:' || substr(gen_random_uuid()::text, 1, 8)
     )
     returning id`,
    [fx.contractId, fx.companyId, fx.tenantId, fx.unitId, options.total, options.state],
  );
  return rows[0].id;
}

/**
 * يسجّل دفعة مؤكّدة مع تخصيصها على الفاتورة، دون إعادة الحساب.
 *
 * No recompute here on purpose: the caller invokes
 * `recompute_invoice_from_confirmed` explicitly, so the asserted state can
 * only come from the function under test — not from an insert trigger.
 */
async function payConfirmed(
  client: PoolClient,
  tenantId: string,
  invoiceId: string,
  amount: number,
): Promise<void> {
  const payment = await client.query<{ id: string }>(
    `insert into public.payments (tenant_id, amount, method, status, payment_date)
     values ($1, $2, 'cash', 'confirmed', current_date) returning id`,
    [tenantId, amount],
  );
  await client.query(
    `insert into public.payment_allocations (payment_id, invoice_id, amount)
     values ($1, $2, $3)`,
    [payment.rows[0].id, invoiceId, amount],
  );
}

/**
 * حالة الفاتورة ومبلغها المسدَّد ورصيدها المولَّد.
 */
async function invoiceState(client: PoolClient, invoiceId: string) {
  const { rows } = await client.query<{ state: string; paid: string; balance: string }>(
    `select state, paid, balance from public.invoices where id = $1`,
    [invoiceId],
  );
  return rows[0];
}

/**
 * Migration 218 — `recompute_invoice_from_confirmed` ranks overdue above
 * partially_paid, matching `apply_payment_allocation` (217) and the nightly
 * `evaluate_overdue` (82). Before it, a same-day partial payment flickered to
 * `partially_paid` until midnight flipped it to `overdue`.
 */
describe("recompute_invoice_from_confirmed precedence (migration 218)", () => {
  test("a past-due invoice with a partial payment recomputes to overdue with the partial paid", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2025-01-01",
        endDate: "2026-12-31",
        graceDays: 7,
      });
      // due_date + grace (7 days) is still in the past: overdue, not partial.
      const invoiceId = await insertInvoice(client, fx, {
        dueDateSql: "current_date - 10",
        total: 500,
        state: "due",
        tag: "overdue",
      });
      await payConfirmed(client, fx.tenantId, invoiceId, 200);

      await client.query(`select public.recompute_invoice_from_confirmed($1)`, [invoiceId]);

      const after = await invoiceState(client, invoiceId);
      expect(after.state).toBe("overdue");
      expect(Number(after.paid)).toBe(200);
      expect(Number(after.balance)).toBe(300);
    });
  });

  test("a future-due invoice with a partial payment recomputes to partially_paid", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2025-01-01",
        endDate: "2026-12-31",
      });
      const invoiceId = await insertInvoice(client, fx, {
        dueDateSql: "current_date + 60",
        total: 500,
        state: "due",
        tag: "partial",
      });
      await payConfirmed(client, fx.tenantId, invoiceId, 200);

      await client.query(`select public.recompute_invoice_from_confirmed($1)`, [invoiceId]);

      const after = await invoiceState(client, invoiceId);
      expect(after.state).toBe("partially_paid");
      expect(Number(after.paid)).toBe(200);
      expect(Number(after.balance)).toBe(300);
    });
  });

  test("a fully paid invoice recomputes to paid", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2025-01-01",
        endDate: "2026-12-31",
      });
      const invoiceId = await insertInvoice(client, fx, {
        dueDateSql: "current_date - 40",
        total: 400,
        state: "due",
        tag: "full",
      });
      await payConfirmed(client, fx.tenantId, invoiceId, 250);
      await payConfirmed(client, fx.tenantId, invoiceId, 150);

      await client.query(`select public.recompute_invoice_from_confirmed($1)`, [invoiceId]);

      const after = await invoiceState(client, invoiceId);
      expect(after.state).toBe("paid");
      expect(Number(after.paid)).toBe(400);
      expect(Number(after.balance)).toBe(0);
    });
  });

  test("a waived invoice is left untouched", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2025-01-01",
        endDate: "2026-12-31",
      });
      const invoiceId = await insertInvoice(client, fx, {
        dueDateSql: "current_date - 40",
        total: 500,
        state: "waived",
        tag: "waived",
      });
      await payConfirmed(client, fx.tenantId, invoiceId, 200);

      await client.query(`select public.recompute_invoice_from_confirmed($1)`, [invoiceId]);

      // Early return before the paid/state write: the write-off stands as-is.
      const after = await invoiceState(client, invoiceId);
      expect(after.state).toBe("waived");
      expect(Number(after.paid)).toBe(0);
    });
  });
});
