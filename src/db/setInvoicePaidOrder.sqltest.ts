import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";

import { captureRaise, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * يُدخل فاتورة في فترة محددة، مدفوعة أو غير مدفوعة.
 *
 * Unique (contract_id, period_year, period_month) is the live constraint, so
 * each call must use a distinct period on the same contract.
 */
async function insertInvoice(
  client: PoolClient,
  input: {
    contractId: string;
    companyId: string;
    tenantId: string;
    unitId: string;
    year: number;
    month: number;
    total?: number;
    paid?: number;
    state?: string;
  },
): Promise<string> {
  const total = input.total ?? 500;
  const paid = input.paid ?? 0;
  const state = input.state ?? (paid >= total ? "paid" : "due");
  const due = `${input.year}-${String(input.month).padStart(2, "0")}-01`;
  const { rows } = await client.query<{ id: string }>(
    `insert into public.invoices (
       code, company_id, contract_id, tenant_id, unit_id,
       period_year, period_month, issue_date, due_date,
       subtotal, discount, total, paid, state, is_visible_to_tenant,
       idempotency_key
     )
     values (
       'INV-ord-' || substr($1::text, 1, 8) || '-' || $5::text || '-' || $6::text,
       $2::uuid, $1::uuid, $3::uuid, $4::uuid,
       $5::integer, $6::integer, $7::date, $7::date,
       $8, 0, $8, $9, $10::public.invoice_states, true,
       $1::text || ':ord:' || $5::text || ':' || $6::text || ':' || substr(gen_random_uuid()::text, 1, 8)
     )
     returning id`,
    [
      input.contractId,
      input.companyId,
      input.tenantId,
      input.unitId,
      input.year,
      input.month,
      due,
      total,
      paid,
      state,
    ],
  );
  return rows[0].id;
}

/**
 * يُنشئ عقدًا ثانيًا لنفس المستأجر على وحدة جديدة تحت نفس العقار.
 */
async function addContractForTenant(
  client: PoolClient,
  base: { companyId: string; propertyId: string; tenantId: string },
  options: { startDate: string; endDate: string; monthlyAmount?: number },
): Promise<{ contractId: string; unitId: string }> {
  const tag = randomUUID().slice(0, 8);
  const unit = await client.query<{ id: string }>(
    `insert into public.units (code, property_id, name) values ($1, $2, $3) returning id`,
    [`U-ord-${tag}`, base.propertyId, `Unit B ${tag}`],
  );
  const unitId = unit.rows[0].id;
  const contract = await client.query<{ id: string }>(
    `insert into public.contracts
       (code, tenant_id, start_date, end_date, due_day, grace_days, deposit, state)
     values ($1, $2, $3::date, $4::date, 1, 0, 0, 'active'::public.contract_states)
     returning id`,
    [`C-ord-${tag}`, base.tenantId, options.startDate, options.endDate],
  );
  const contractId = contract.rows[0].id;
  await client.query(
    `insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
     values ($1, $2, $3, 1)`,
    [contractId, unitId, options.monthlyAmount ?? 500],
  );
  return { contractId, unitId };
}

describe("set_invoice_paid chronological order (migration 129)", () => {
  test("refuses to mark paid when the same contract has an earlier unpaid invoice", async () => {
    await withRollback(async (client) => {
      const base = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 400,
      });
      await insertInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        year: 2026,
        month: 1,
      });
      const february = await insertInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        year: 2026,
        month: 2,
      });

      const message = await captureRaise(client, () =>
        client.query(`select public.set_invoice_paid($1::uuid, true, 'bank_transfer')`, [february]),
      );

      expect(message).toMatch(/chronological order/i);
    });
  });

  test("allows mark-paid when the only earlier unpaid invoice is on a different contract", async () => {
    await withRollback(async (client) => {
      const base = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 400,
      });
      const contractB = await addContractForTenant(client, base, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 450,
      });
      await insertInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        year: 2026,
        month: 1,
      });
      const februaryB = await insertInvoice(client, {
        contractId: contractB.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: contractB.unitId,
        year: 2026,
        month: 2,
      });

      const message = await captureRaise(client, () =>
        client.query(`select public.set_invoice_paid($1::uuid, true, 'bank_transfer')`, [
          februaryB,
        ]),
      );

      expect(message).toBeNull();
    });
  });

  test("allows marking an invoice unpaid even when earlier invoices are unpaid", async () => {
    await withRollback(async (client) => {
      const base = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 400,
      });
      await insertInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        year: 2026,
        month: 1,
      });
      const february = await insertInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        year: 2026,
        month: 2,
        paid: 400,
        total: 400,
        state: "paid",
      });

      const message = await captureRaise(client, () =>
        client.query(`select public.set_invoice_paid($1::uuid, false)`, [february]),
      );

      expect(message).toBeNull();
    });
  });
});
