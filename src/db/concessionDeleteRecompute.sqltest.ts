import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";

import { closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

type InvoiceRow = {
  id: string;
  code: string;
  subtotal: string;
  discount: string;
  total: string;
  paid: string;
  balance: string;
  state: string;
};

/**
 * يُدخل فاتورة غير مدفوعة بمجموع فرعي وتاريخ استحقاق معلومين، دون المرور بالمولّد.
 *
 * The due date arrives as a SQL expression (`current_date + 60`) so the test
 * says "due in the future" relative to the day it runs instead of a date that
 * rots on the calendar. The billing period follows that date, so the invoice
 * always belongs to the month it is billed for.
 *
 * balance is generated from total − paid, and `paid` is checked against
 * `total`, so a test that writes money must set discount and total together.
 */
async function insertUnpaidInvoice(
  client: PoolClient,
  input: {
    contractId: string;
    companyId: string;
    tenantId: string;
    unitId: string;
    subtotal: number;
    dueDateSql: string;
    discount?: number;
    code?: string;
  },
): Promise<InvoiceRow> {
  const discount = input.discount ?? 0;
  const code = input.code ?? `INV-cdr-${randomUUID().slice(0, 8)}`;
  const { rows } = await client.query<InvoiceRow>(
    `insert into public.invoices (
       code, company_id, contract_id, tenant_id, unit_id,
       period_year, period_month, issue_date, due_date,
       subtotal, discount, total, paid, state, is_visible_to_tenant,
       idempotency_key
     )
     select $8::text, $2::uuid, $1::uuid, $3::uuid, $4::uuid,
            extract(year from d.due)::integer, extract(month from d.due)::integer,
            current_date, d.due,
            $5::numeric, $6::numeric, $7::numeric, 0, 'due', true,
            $1::text || ':' || extract(year from d.due)::text || ':'
              || extract(month from d.due)::text || ':' || substr(gen_random_uuid()::text, 1, 8)
       from (select (${input.dueDateSql})::date as due) d
     returning id, code, subtotal::text, discount::text, total::text,
               paid::text, balance::text, state::text`,
    [
      input.contractId,
      input.companyId,
      input.tenantId,
      input.unitId,
      input.subtotal,
      discount,
      input.subtotal - discount,
      code,
    ],
  );
  return rows[0];
}

/**
 * يُدخل تنازل خصم ثابت أو نسبة أو شهر مجاني على العقد.
 */
async function insertConcession(
  client: PoolClient,
  input: {
    contractId: string;
    type: "fixed_discount" | "percentage_discount" | "free_months";
    startDate: string;
    endDate: string;
    amount?: number;
    percent?: number;
    freeMonths?: number;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.concessions
       (contract_id, type, status, start_date, end_date,
        discount_amount, discount_percent, free_months)
     values ($1, $2, 'active', $3::date, $4::date, $5, $6, $7)
     returning id`,
    [
      input.contractId,
      input.type,
      input.startDate,
      input.endDate,
      input.amount ?? null,
      input.percent ?? null,
      input.freeMonths ?? 0,
    ],
  );
  return rows[0].id;
}

/**
 * يُدخل بند خصم على الفاتورة، بالشكل الذي تكتبه دالة تطبيق الخصم.
 */
async function insertConcessionItem(
  client: PoolClient,
  invoiceId: string,
  amount: number,
): Promise<void> {
  await client.query(
    `insert into public.invoice_items (
       invoice_id, line, description_ar, description_en, quantity,
       unit_price, discount_percent, amount, is_concession
     )
     values ($1, 1, 'خصم مبلغ ثابت', 'Fixed discount', 1, 0, 0, $2, true)`,
    [invoiceId, amount],
  );
}

/**
 * يربط الخصم بالفاتورة عبر الدالة الرسمية، كما تفعل الواجهة.
 */
async function applyConcession(
  client: PoolClient,
  concessionId: string,
  invoiceIds: string[],
): Promise<void> {
  await client.query(`select * from public.apply_concession_to_invoices($1, $2::uuid[])`, [
    concessionId,
    invoiceIds,
  ]);
}

/**
 * يسجّل دفعة مؤكّدة ويسدّد الفاتورة بها عبر دالة التخصيص نفسها.
 *
 * The payment is `confirmed` and the allocation goes through
 * `apply_payment_allocation`, so the invoice's `paid` and `state` are written
 * by the same code path the app uses — not by a hand-written update that would
 * let the test pass for the wrong reason.
 */
async function payInvoice(
  client: PoolClient,
  tenantId: string,
  invoiceId: string,
  amount: number,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.payments (code, tenant_id, method, amount, payment_date, status)
     values (public.next_payment_code(), $1, 'cash', $2, current_date, 'confirmed')
     returning id`,
    [tenantId, amount],
  );
  await client.query(`select * from public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
    rows[0].id,
    JSON.stringify([{ invoice_id: invoiceId, amount }]),
  ]);
}

/**
 * يقرأ صف الفاتورة بعد الكتابة للتحقق من discount و total و balance و state معاً.
 */
async function readInvoice(client: PoolClient, invoiceId: string): Promise<InvoiceRow> {
  const { rows } = await client.query<InvoiceRow>(
    `select id, code, subtotal::text, discount::text, total::text,
            paid::text, balance::text, state::text
       from public.invoices where id = $1`,
    [invoiceId],
  );
  return rows[0];
}

/**
 * عقد طويل المدى، حتى تُقبل أي فاتورة يُدخلها الاختبار على أي شهر.
 */
async function seedWideContract(client: PoolClient) {
  return seedContract(client, {
    startDate: "2020-01-01",
    endDate: "2035-12-31",
    monthlyAmount: 500,
  });
}

/**
 * Migration 250 — deleting a concession recomputes the invoice's state.
 *
 * The defect (spec §1.2, the "حذف خصم" row): the delete trigger restored
 * `total = subtotal` but left `state` alone, so an invoice the tenant had
 * settled at its discounted total kept reading `paid` while its balance was
 * back above zero. The trigger now calls `recompute_invoice_from_confirmed`
 * (218) after restoring the total, so the state follows the confirmed money.
 */
describe("deleting a concession recomputes the invoice state (migration 250)", () => {
  test("a fully paid discounted invoice drops out of 'paid' when the concession is deleted", async () => {
    await withRollback(async (client) => {
      const base = await seedWideContract(client);
      // Due in the future, so the recompute is deterministic: the overdue
      // branch needs a due date in the past.
      const invoice = await insertUnpaidInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        subtotal: 500,
        dueDateSql: "current_date + 60",
      });
      const concessionId = await insertConcession(client, {
        contractId: base.contractId,
        type: "percentage_discount",
        startDate: "2020-01-01",
        endDate: "2035-12-31",
        percent: 20,
      });
      await applyConcession(client, concessionId, [invoice.id]);

      const discounted = await readInvoice(client, invoice.id);
      expect(discounted.discount).toBe("100.000");
      expect(discounted.total).toBe("400.000");

      // Paid AFTER the discount: the tenant settled the discounted total, so
      // the invoice reads 'paid' while only 400 of the 500 is settled.
      await payInvoice(client, base.tenantId, invoice.id, 400);
      const settled = await readInvoice(client, invoice.id);
      expect(settled.state).toBe("paid");
      expect(settled.paid).toBe("400.000");
      expect(settled.balance).toBe("0.000");

      await client.query(`delete from public.concessions where id = $1`, [concessionId]);

      const after = await readInvoice(client, invoice.id);
      expect(after.discount).toBe("0.000");
      expect(after.total).toBe("500.000");
      // The money did not move: the tenant still paid 400, and the invoice
      // now owes the 100 the discount was covering.
      expect(after.paid).toBe("400.000");
      expect(Number(after.balance)).toBeGreaterThan(0);
      expect(after.state).not.toBe("paid");
      expect(after.state).toBe("partially_paid");
    });
  });

  test("a fully paid discounted invoice that is past due reads 'overdue' after the concession is deleted", async () => {
    await withRollback(async (client) => {
      const base = await seedWideContract(client);
      // Due in the past: the precedence of migration 218 puts overdue ahead of
      // partially_paid, so a partially settled past-due invoice reads overdue.
      const invoice = await insertUnpaidInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        subtotal: 500,
        dueDateSql: "current_date - 40",
      });
      const concessionId = await insertConcession(client, {
        contractId: base.contractId,
        type: "percentage_discount",
        startDate: "2020-01-01",
        endDate: "2035-12-31",
        percent: 20,
      });
      await applyConcession(client, concessionId, [invoice.id]);

      await payInvoice(client, base.tenantId, invoice.id, 400);
      const settled = await readInvoice(client, invoice.id);
      expect(settled.state).toBe("paid");

      await client.query(`delete from public.concessions where id = $1`, [concessionId]);

      const after = await readInvoice(client, invoice.id);
      expect(after.total).toBe("500.000");
      expect(after.paid).toBe("400.000");
      expect(Number(after.balance)).toBeGreaterThan(0);
      expect(after.state).not.toBe("paid");
      expect(after.state).toBe("overdue");
    });
  });

  test("deleting a free_months concession leaves the invoice untouched", async () => {
    await withRollback(async (client) => {
      const base = await seedWideContract(client);
      // A discounted invoice, so a restore would be visible in its totals:
      // without the early return the discount would be wiped and the totals
      // would go back to the subtotal.
      const invoice = await insertUnpaidInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        subtotal: 500,
        discount: 100,
        dueDateSql: "current_date + 60",
      });
      await insertConcessionItem(client, invoice.id, -100);
      const concessionId = await insertConcession(client, {
        contractId: base.contractId,
        type: "free_months",
        startDate: "2020-01-01",
        endDate: "2035-12-31",
        freeMonths: 1,
      });
      // The link is written by hand: apply_concession_to_invoices refuses to
      // bind a free month to an invoice, and this link is the only way the
      // early return inside the trigger is reached.
      await client.query(
        `insert into public.concession_invoices (concession_id, invoice_id)
         values ($1, $2)`,
        [concessionId, invoice.id],
      );

      await client.query(`delete from public.concessions where id = $1`, [concessionId]);

      const after = await readInvoice(client, invoice.id);
      expect(after.discount).toBe("100.000");
      expect(after.total).toBe("400.000");
      expect(after.paid).toBe("0.000");
      expect(after.state).toBe("due");
      const items = await client.query(
        `select 1 from public.invoice_items
          where invoice_id = $1 and is_concession = true`,
        [invoice.id],
      );
      expect(items.rowCount).toBe(1);
    });
  });
});
