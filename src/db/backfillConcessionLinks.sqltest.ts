import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";

import { closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * يُدخل فاتورة تحمل خصمًا مطبّقًا مسبقًا دون أي رابط تنازل — أي بالشكل الذي
 * كانت عليه الفواتير قبل الترحيل 127.
 *
 * The point of these tests is the pre-127 shape specifically: a non-zero
 * discount with NO concession_invoices row. Generation used to re-derive that
 * discount from the concession's date range on every regenerate; after 127 it
 * does not, and only a linked invoice is protected from regeneration.
 */
async function insertLegacyDiscountedInvoice(
  client: PoolClient,
  input: {
    contractId: string;
    companyId: string;
    tenantId: string;
    unitId: string;
    year: number;
    month: number;
    subtotal: number;
    discount: number;
  },
): Promise<{ id: string; code: string }> {
  const due = `${input.year}-${String(input.month).padStart(2, "0")}-01`;
  const { rows } = await client.query<{ id: string; code: string }>(
    `insert into public.invoices (
       code, company_id, contract_id, tenant_id, unit_id,
       period_year, period_month, issue_date, due_date,
       subtotal, discount, total, paid, state, is_visible_to_tenant,
       idempotency_key
     )
     values (
       $9, $2::uuid, $1::uuid, $3::uuid, $4::uuid,
       $5::integer, $6::integer, $7::date, $7::date,
       $8::numeric, $10::numeric, $11::numeric, 0, 'due', true,
       $1::text || ':' || $5::text || ':' || $6::text || ':' || substr(gen_random_uuid()::text, 1, 8)
     )
     returning id, code`,
    [
      input.contractId,
      input.companyId,
      input.tenantId,
      input.unitId,
      input.year,
      input.month,
      due,
      input.subtotal,
      `INV-bf-${randomUUID().slice(0, 8)}-${input.month}`,
      input.discount,
      // subtotal − discount, computed here rather than in SQL: arithmetic
      // between two untyped placeholders is ambiguous to Postgres.
      input.subtotal - input.discount,
    ],
  );
  return rows[0];
}

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

async function linkCount(client: PoolClient, invoiceId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n from public.concession_invoices where invoice_id = $1`,
    [invoiceId],
  );
  return rows[0].n;
}

describe("backfill_concession_invoice_links", () => {
  test("links a pre-127 discounted invoice to the concession covering its period", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 1000,
      });
      const concessionId = await insertConcession(client, {
        contractId: fixture.contractId,
        type: "fixed_discount",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        amount: 100,
      });
      const invoice = await insertLegacyDiscountedInvoice(client, {
        contractId: fixture.contractId,
        companyId: fixture.companyId,
        tenantId: fixture.tenantId,
        unitId: fixture.unitId,
        year: 2026,
        month: 5,
        subtotal: 1000,
        discount: 100,
      });

      expect(await linkCount(client, invoice.id)).toBe(0);

      const { rows } = await client.query<{ linked: number; left_for_review: number }>(
        `select * from public.backfill_concession_invoice_links()`,
      );

      expect(rows[0].linked).toBeGreaterThanOrEqual(1);
      expect(await linkCount(client, invoice.id)).toBe(1);

      const { rows: link } = await client.query<{ concession_id: string }>(
        `select concession_id from public.concession_invoices where invoice_id = $1`,
        [invoice.id],
      );
      expect(link[0].concession_id).toBe(concessionId);
    });
  });

  test("leaves an invoice alone when two concessions could explain its discount", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 1000,
      });
      // Two overlapping actives both cover May. Which one produced the 100 is
      // not knowable, and inventing an answer would attach money to the wrong
      // record — so the row is reported, not guessed.
      await insertConcession(client, {
        contractId: fixture.contractId,
        type: "fixed_discount",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        amount: 100,
      });
      await insertConcession(client, {
        contractId: fixture.contractId,
        type: "percentage_discount",
        startDate: "2026-04-01",
        endDate: "2026-06-30",
        percent: 10,
      });
      const invoice = await insertLegacyDiscountedInvoice(client, {
        contractId: fixture.contractId,
        companyId: fixture.companyId,
        tenantId: fixture.tenantId,
        unitId: fixture.unitId,
        year: 2026,
        month: 5,
        subtotal: 1000,
        discount: 100,
      });

      const { rows } = await client.query<{ linked: number; left_for_review: number }>(
        `select * from public.backfill_concession_invoice_links()`,
      );

      expect(rows[0].left_for_review).toBeGreaterThanOrEqual(1);
      expect(await linkCount(client, invoice.id)).toBe(0);
    });
  });

  test("is idempotent — a second run links nothing new and raises no error", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 1000,
      });
      await insertConcession(client, {
        contractId: fixture.contractId,
        type: "fixed_discount",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        amount: 100,
      });
      const invoice = await insertLegacyDiscountedInvoice(client, {
        contractId: fixture.contractId,
        companyId: fixture.companyId,
        tenantId: fixture.tenantId,
        unitId: fixture.unitId,
        year: 2026,
        month: 5,
        subtotal: 1000,
        discount: 100,
      });

      await client.query(`select * from public.backfill_concession_invoice_links()`);
      const { rows: second } = await client.query<{ linked: number }>(
        `select * from public.backfill_concession_invoice_links()`,
      );

      expect(second[0].linked).toBe(0);
      expect(await linkCount(client, invoice.id)).toBe(1);
    });
  });

  test("an invoice with no discount is never linked", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 1000,
      });
      await insertConcession(client, {
        contractId: fixture.contractId,
        type: "fixed_discount",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        amount: 100,
      });
      const invoice = await insertLegacyDiscountedInvoice(client, {
        contractId: fixture.contractId,
        companyId: fixture.companyId,
        tenantId: fixture.tenantId,
        unitId: fixture.unitId,
        year: 2026,
        month: 5,
        subtotal: 1000,
        discount: 0,
      });

      await client.query(`select * from public.backfill_concession_invoice_links()`);

      expect(await linkCount(client, invoice.id)).toBe(0);
    });
  });
});
