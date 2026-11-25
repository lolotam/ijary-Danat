import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";

import {
  captureRaise,
  captureRaiseError,
  closePool,
  seedContract,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

type InvoiceRow = {
  id: string;
  code: string;
  subtotal: string;
  discount: string;
  total: string;
  paid: string;
  balance: string;
  period_year: number;
  period_month: number;
};

/**
 * يُدخل فاتورة غير مدفوعة بمجموع فرعي معلوم، دون المرور بالمولّد.
 *
 * balance is generated from total − paid. Tests that write money must set
 * discount and total together so subtotal − discount = total.
 */
async function insertUnpaidInvoice(
  client: PoolClient,
  input: {
    contractId: string;
    companyId: string;
    tenantId: string;
    unitId: string;
    year: number;
    month: number;
    subtotal: number;
    code?: string;
  },
): Promise<InvoiceRow> {
  const due = `${input.year}-${String(input.month).padStart(2, "0")}-01`;
  const code = input.code ?? `INV-ci-${randomUUID().slice(0, 8)}-${input.month}`;
  const { rows } = await client.query<InvoiceRow>(
    `insert into public.invoices (
       code, company_id, contract_id, tenant_id, unit_id,
       period_year, period_month, issue_date, due_date,
       subtotal, discount, total, paid, state, is_visible_to_tenant,
       idempotency_key
     )
     values (
       $9, $2::uuid, $1::uuid, $3::uuid, $4::uuid,
       $5::integer, $6::integer, $7::date, $7::date,
       $8, 0, $8, 0, 'due', true,
       $1::text || ':' || $5::text || ':' || $6::text || ':' || substr(gen_random_uuid()::text, 1, 8)
     )
     returning id, code, subtotal::text, discount::text, total::text,
               paid::text, balance::text, period_year, period_month`,
    [
      input.contractId,
      input.companyId,
      input.tenantId,
      input.unitId,
      input.year,
      input.month,
      due,
      input.subtotal,
      code,
    ],
  );
  return rows[0];
}

/**
 * يُدخل تنازل خصم ثابت أو نسبة على العقد.
 */
async function insertConcession(
  client: PoolClient,
  input: {
    contractId: string;
    type: "fixed_discount" | "percentage_discount";
    startDate: string;
    endDate: string;
    amount?: number;
    percent?: number;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.concessions
       (contract_id, type, status, start_date, end_date, discount_amount, discount_percent)
     values ($1, $2, 'active', $3::date, $4::date, $5, $6)
     returning id`,
    [
      input.contractId,
      input.type,
      input.startDate,
      input.endDate,
      input.amount ?? null,
      input.percent ?? null,
    ],
  );
  return rows[0].id;
}

/**
 * يقرأ صف الفاتورة بعد الكتابة للتحقق من discount و total و balance معاً.
 */
async function readInvoice(client: PoolClient, invoiceId: string): Promise<InvoiceRow> {
  const { rows } = await client.query<InvoiceRow>(
    `select id, code, subtotal::text, discount::text, total::text,
            paid::text, balance::text, period_year, period_month
       from public.invoices where id = $1`,
    [invoiceId],
  );
  return rows[0];
}

describe("apply_concession_to_invoices", () => {
  test("a fixed 100 discount keeps the code, writes discount and total together", async () => {
    await withRollback(async (client) => {
      const base = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 500,
      });
      const invoice = await insertUnpaidInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        year: 2026,
        month: 3,
        subtotal: 500,
        code: "INV-ci-keep-0000250",
      });
      const concessionId = await insertConcession(client, {
        contractId: base.contractId,
        type: "fixed_discount",
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        amount: 100,
      });

      await client.query(`select * from public.apply_concession_to_invoices($1, $2::uuid[])`, [
        concessionId,
        [invoice.id],
      ]);

      const after = await readInvoice(client, invoice.id);
      expect(after.code).toBe("INV-ci-keep-0000250");
      expect(after.subtotal).toBe("500.000");
      expect(after.discount).toBe("100.000");
      expect(after.total).toBe("400.000");
      expect(after.balance).toBe("400.000");
      expect(Number(after.subtotal) - Number(after.discount)).toBe(Number(after.total));

      const items = await client.query<{ amount: string; is_concession: boolean }>(
        `select amount::text, is_concession from public.invoice_items
          where invoice_id = $1 and is_concession = true`,
        [invoice.id],
      );
      expect(items.rows).toHaveLength(1);
      expect(items.rows[0].amount).toBe("-100.000");
    });
  });

  test("a second concession_invoices row for the same invoice raises unique violation", async () => {
    await withRollback(async (client) => {
      const base = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 500,
      });
      const invoice = await insertUnpaidInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        year: 2026,
        month: 3,
        subtotal: 500,
      });
      const first = await insertConcession(client, {
        contractId: base.contractId,
        type: "fixed_discount",
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        amount: 100,
      });
      const second = await insertConcession(client, {
        contractId: base.contractId,
        type: "fixed_discount",
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        amount: 200,
      });
      await client.query(
        `insert into public.concession_invoices (concession_id, invoice_id)
                          values ($1, $2)`,
        [first, invoice.id],
      );

      const error = await captureRaiseError(client, () =>
        client.query(
          `insert into public.concession_invoices (concession_id, invoice_id) values ($1, $2)`,
          [second, invoice.id],
        ),
      );
      expect(error).toMatchObject({ code: "23505" });
    });
  });

  test("deleting the concession restores discount and total and frees the invoice", async () => {
    await withRollback(async (client) => {
      const base = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 500,
      });
      const invoice = await insertUnpaidInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        year: 2026,
        month: 3,
        subtotal: 500,
        code: "INV-restore-1",
      });
      const concessionId = await insertConcession(client, {
        contractId: base.contractId,
        type: "fixed_discount",
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        amount: 100,
      });
      await client.query(`select * from public.apply_concession_to_invoices($1, $2::uuid[])`, [
        concessionId,
        [invoice.id],
      ]);

      await client.query(`delete from public.concessions where id = $1`, [concessionId]);

      const after = await readInvoice(client, invoice.id);
      expect(after.code).toBe("INV-restore-1");
      expect(after.discount).toBe("0.000");
      expect(after.total).toBe("500.000");
      expect(after.balance).toBe("500.000");

      const links = await client.query(
        `select 1 from public.concession_invoices where invoice_id = $1`,
        [invoice.id],
      );
      expect(links.rowCount).toBe(0);

      const replacement = await insertConcession(client, {
        contractId: base.contractId,
        type: "fixed_discount",
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        amount: 50,
      });
      await client.query(`select * from public.apply_concession_to_invoices($1, $2::uuid[])`, [
        replacement,
        [invoice.id],
      ]);
      const reapplied = await readInvoice(client, invoice.id);
      expect(reapplied.discount).toBe("50.000");
      expect(reapplied.total).toBe("450.000");
    });
  });

  test("reapply_contract_invoices does not delete a discounted invoice", async () => {
    await withRollback(async (client) => {
      const base = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 500,
      });
      const invoice = await insertUnpaidInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        year: 2026,
        month: 3,
        subtotal: 500,
        code: "INV-keep-me",
      });
      const concessionId = await insertConcession(client, {
        contractId: base.contractId,
        type: "fixed_discount",
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        amount: 100,
      });
      await client.query(`select * from public.apply_concession_to_invoices($1, $2::uuid[])`, [
        concessionId,
        [invoice.id],
      ]);

      await client.query(`select * from public.reapply_contract_invoices($1)`, [base.contractId]);

      const after = await readInvoice(client, invoice.id);
      expect(after.code).toBe("INV-keep-me");
      expect(after.discount).toBe("100.000");
      expect(after.total).toBe("400.000");
    });
  });

  test("applying to a partially-paid invoice is rejected", async () => {
    await withRollback(async (client) => {
      const base = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 500,
      });
      const invoice = await insertUnpaidInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        year: 2026,
        month: 3,
        subtotal: 500,
      });
      await client.query(
        `update public.invoices set paid = 50, state = 'partially_paid' where id = $1`,
        [invoice.id],
      );
      const concessionId = await insertConcession(client, {
        contractId: base.contractId,
        type: "fixed_discount",
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        amount: 100,
      });

      const message = await captureRaise(client, () =>
        client.query(`select * from public.apply_concession_to_invoices($1, $2::uuid[])`, [
          concessionId,
          [invoice.id],
        ]),
      );
      expect(message).toMatch(/not fully unpaid/i);

      const after = await readInvoice(client, invoice.id);
      expect(after.discount).toBe("0.000");
      expect(after.total).toBe("500.000");
    });
  });

  test("applying to an invoice on a different contract is rejected", async () => {
    await withRollback(async (client) => {
      const a = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 500,
      });
      const b = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 400,
      });
      const foreign = await insertUnpaidInvoice(client, {
        contractId: b.contractId,
        companyId: b.companyId,
        tenantId: b.tenantId,
        unitId: b.unitId,
        year: 2026,
        month: 3,
        subtotal: 400,
      });
      const concessionId = await insertConcession(client, {
        contractId: a.contractId,
        type: "fixed_discount",
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        amount: 100,
      });

      const message = await captureRaise(client, () =>
        client.query(`select * from public.apply_concession_to_invoices($1, $2::uuid[])`, [
          concessionId,
          [foreign.id],
        ]),
      );
      expect(message).toMatch(/does not belong/i);
      expect((await readInvoice(client, foreign.id)).discount).toBe("0.000");
    });
  });

  test("non-contiguous selected months (Jan and Mar, not Feb) both receive the discount", async () => {
    await withRollback(async (client) => {
      const base = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 500,
      });
      const january = await insertUnpaidInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        year: 2026,
        month: 1,
        subtotal: 500,
      });
      const february = await insertUnpaidInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        year: 2026,
        month: 2,
        subtotal: 500,
      });
      const march = await insertUnpaidInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        year: 2026,
        month: 3,
        subtotal: 500,
      });
      const concessionId = await insertConcession(client, {
        contractId: base.contractId,
        type: "fixed_discount",
        startDate: "2026-01-01",
        endDate: "2026-03-31",
        amount: 100,
      });

      await client.query(`select * from public.apply_concession_to_invoices($1, $2::uuid[])`, [
        concessionId,
        [january.id, march.id],
      ]);

      expect((await readInvoice(client, january.id)).discount).toBe("100.000");
      expect((await readInvoice(client, january.id)).total).toBe("400.000");
      expect((await readInvoice(client, march.id)).discount).toBe("100.000");
      expect((await readInvoice(client, march.id)).total).toBe("400.000");
      expect((await readInvoice(client, february.id)).discount).toBe("0.000");
      expect((await readInvoice(client, february.id)).total).toBe("500.000");
    });
  });
});

describe("generate_invoices_for_year no longer applies date-range discounts", () => {
  test("two overlapping percentage concessions apply neither at generation time", async () => {
    await withRollback(async (client) => {
      const base = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-06-30",
        monthlyAmount: 1000,
      });
      await insertConcession(client, {
        contractId: base.contractId,
        type: "percentage_discount",
        startDate: "2026-01-01",
        endDate: "2026-06-30",
        percent: 10,
      });
      await insertConcession(client, {
        contractId: base.contractId,
        type: "percentage_discount",
        startDate: "2026-01-01",
        endDate: "2026-06-30",
        percent: 20,
      });

      await client.query(`select * from public.generate_invoices_for_year($1, 2026, true)`, [
        base.contractId,
      ]);

      const { rows } = await client.query<InvoiceRow>(
        `select id, code, subtotal::text, discount::text, total::text,
                paid::text, balance::text, period_year, period_month
           from public.invoices
          where contract_id = $1
          order by period_month`,
        [base.contractId],
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.discount).toBe("0.000");
        expect(row.total).toBe(row.subtotal);
        expect(row.total).toBe("1000.000");
      }

      const concessionItems = await client.query(
        `select 1 from public.invoice_items ii
           join public.invoices i on i.id = ii.invoice_id
          where i.contract_id = $1 and ii.is_concession = true`,
        [base.contractId],
      );
      expect(concessionItems.rowCount).toBe(0);
    });
  });
});
