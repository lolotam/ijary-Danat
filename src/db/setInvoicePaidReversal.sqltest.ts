import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * ينشئ فاتورة الشهر الأول بتاريخ استحقاق أمس لتثبيت حالة التأخر دون الاعتماد على يوم التشغيل.
 */
async function firstInvoice(client: PoolClient) {
  const fx = await seedContract(client, {
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    monthlyAmount: 300,
    graceDays: 0,
  });
  await client.query("select public.generate_invoices_for_year($1, 2026, true)", [fx.contractId]);
  const { rows } = await client.query<{ id: string; total: string }>(
    `update public.invoices set due_date = current_date - 1
     where contract_id = $1 and period_month = 1 returning id, total`,
    [fx.contractId],
  );
  expect(rows).toHaveLength(1);
  return { ...fx, invoiceId: rows[0].id, total: Number(rows[0].total) };
}

/**
 * يمر بالسداد النقدي ثم العكس الحقيقي كي تبقى تخصيصات العكس الموجبة التي سببت الخلل.
 */
async function reversedInvoice(client: PoolClient) {
  const fx = await firstInvoice(client);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.payments
       (code, company_id, tenant_id, unit_id, account_type, method, amount,
        currency, payment_date, status)
     values (public.next_payment_code(), $1, $2, $3, 'commercial_account',
             'cash', $4, 'KWD', current_date, 'confirmed') returning id`,
    [fx.companyId, fx.tenantId, fx.unitId, fx.total],
  );
  await client.query("select public.apply_payment_allocation($1::uuid, $2::jsonb)", [
    rows[0].id,
    JSON.stringify([{ invoice_id: fx.invoiceId, amount: fx.total }]),
  ]);
  expect(await invoiceMoney(client, fx.invoiceId)).toEqual({
    total: fx.total,
    paid: fx.total,
    balance: 0,
    state: "paid",
  });
  await client.query("select public.reverse_payment($1::uuid, $2)", [
    rows[0].id,
    "Cash payment returned — regression 246",
  ]);
  return fx;
}

/**
 * يقرأ القيم المخزنة فعلياً ويحوّل مبالغ numeric للمقارنة العددية دون محاكاة قاعدة البيانات.
 */
async function invoiceMoney(client: PoolClient, invoiceId: string) {
  const { rows } = await client.query<{
    total: string;
    paid: string;
    balance: string;
    state: string;
  }>("select total, paid, balance, state from public.invoices where id = $1", [invoiceId]);
  expect(rows).toHaveLength(1);
  return {
    total: Number(rows[0].total),
    paid: Number(rows[0].paid),
    balance: Number(rows[0].balance),
    state: rows[0].state,
  };
}

describe("set_invoice_paid excludes reversed allocations (migration 246)", () => {
  test("a full cash payment reversed through the RPC leaves zero paid", async () => {
    await withRollback(async (client) => {
      const fx = await reversedInvoice(client);
      expect(await invoiceMoney(client, fx.invoiceId)).toEqual({
        total: fx.total,
        paid: 0,
        balance: fx.total,
        state: "overdue",
      });
    });
  });

  test("marking paid after reversal counts exactly one invoice total", async () => {
    await withRollback(async (client) => {
      const fx = await reversedInvoice(client);
      await client.query("select * from public.set_invoice_paid($1, true, 'cash', null)", [
        fx.invoiceId,
      ]);
      expect(await invoiceMoney(client, fx.invoiceId)).toEqual({
        total: fx.total,
        paid: fx.total,
        balance: 0,
        state: "paid",
      });
    });
  });

  test("marking unpaid after reversal and manual settlement clears all paid money", async () => {
    await withRollback(async (client) => {
      const fx = await reversedInvoice(client);
      await client.query("select * from public.set_invoice_paid($1, true, 'cash', null)", [
        fx.invoiceId,
      ]);
      await client.query("select * from public.set_invoice_paid($1, false, null, null)", [
        fx.invoiceId,
      ]);
      expect(await invoiceMoney(client, fx.invoiceId)).toEqual({
        total: fx.total,
        paid: 0,
        balance: fx.total,
        state: "overdue",
      });
    });
  });

  test("marking paid then unpaid without a reversal preserves the ordinary flow", async () => {
    await withRollback(async (client) => {
      const fx = await firstInvoice(client);
      await client.query("select * from public.set_invoice_paid($1, true, 'cash', null)", [
        fx.invoiceId,
      ]);
      expect(await invoiceMoney(client, fx.invoiceId)).toEqual({
        total: fx.total,
        paid: fx.total,
        balance: 0,
        state: "paid",
      });
      await client.query("select * from public.set_invoice_paid($1, false, null, null)", [
        fx.invoiceId,
      ]);
      expect(await invoiceMoney(client, fx.invoiceId)).toEqual({
        total: fx.total,
        paid: 0,
        balance: fx.total,
        state: "overdue",
      });
    });
  });
});
