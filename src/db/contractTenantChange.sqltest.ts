import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Proves migration 190: reassigning a contract's tenant carries its invoices,
 * payments and receipts with it.
 *
 * Regression suite for the CON-00084 incident (2026-09-06): editing the tenant
 * on a contract moved `contracts.tenant_id` alone and stranded 34 invoices
 * (42,500.000 KWD, 7,500.000 of it paid), 6 payments and 6 receipts under the
 * previous tenant. `tenant_id` is denormalised onto all three, and the portal,
 * the overdue reminders and the tenant statement read those copies rather than
 * joining back through contracts — so the stale rows were what the product
 * actually displayed, and what the old tenant was still billed for.
 */

interface Seeded {
  contractId: string;
  oldTenantId: string;
  newTenantId: string;
  invoiceId: string;
  paymentId: string;
  receiptId: string;
  companyId: string;
  propertyId: string;
}

/**
 * ينشئ فاتورة للعقد المحدد باسم المستأجر المحدد.
 *
 * `paid` is written after the allocation exists, mirroring the payment engine.
 * The triggers on payment_allocations maintain payment_method (migration 108)
 * and receipt visibility (migration 174) — none of them maintains `paid`, so a
 * fixture that set it up front would leave it disagreeing with its allocations
 * the way migration 52 once did.
 */
async function seedPaidInvoice(
  client: PoolClient,
  args: { contractId: string; tenantId: string; companyId: string; unitId?: string },
): Promise<string> {
  const invoice = await client.query<{ id: string }>(
    `insert into public.invoices
       (contract_id, tenant_id, unit_id, company_id, period_year, period_month,
        issue_date, due_date, subtotal, total, state, idempotency_key)
     values ($1, $2, $3, $4, 2025, 1, '2025-01-01', '2025-01-01',
             500, 500, 'due', $5)
     returning id`,
    [args.contractId, args.tenantId, args.unitId ?? null, args.companyId, `idem-${randomUUID()}`],
  );
  return invoice.rows[0].id;
}

/**
 * يجهّز عقدًا بفاتورة ودفعة وإيصال، مع مستأجر ثانٍ جاهز للنقل إليه.
 *
 * Builds the whole invoice → payment → allocation → receipt chain, because the
 * trigger reaches payments and receipts through payment_allocations; a fixture
 * without allocations would pass while proving nothing about that join.
 *
 * The receipt is read back rather than inserted: `sync_payment_receipt`
 * (migration 05) creates one automatically for every confirmed payment, and a
 * second insert would collide with receipts' unique (payment_id).
 */
async function seedContractWithMoney(client: PoolClient): Promise<Seeded> {
  const { contractId, tenantId, unitId, companyId, propertyId } = await seedContract(client, {
    startDate: "2025-01-01",
    endDate: "2026-12-31",
    monthlyAmount: 500,
  });

  const tag = randomUUID().slice(0, 8);
  const newTenant = await client.query<{ id: string }>(
    `insert into public.tenants (code, company_id, name, lifecycle)
     values ($1, $2, $3, 'active') returning id`,
    [`T-new-${tag}`, companyId, `مستأجر جديد ${tag}`],
  );

  const invoiceId = await seedPaidInvoice(client, { contractId, tenantId, companyId, unitId });

  const payment = await client.query<{ id: string }>(
    `insert into public.payments (tenant_id, amount, method, status, payment_date)
     values ($1, 500, 'cash', 'confirmed', current_date) returning id`,
    [tenantId],
  );
  const paymentId = payment.rows[0].id;

  await client.query(
    `insert into public.payment_allocations (payment_id, invoice_id, amount)
     values ($1, $2, 500)`,
    [paymentId, invoiceId],
  );
  await client.query(`update public.invoices set paid = 500, state = 'paid' where id = $1`, [
    invoiceId,
  ]);

  const receipt = await client.query<{ id: string }>(
    `select id from public.receipts where payment_id = $1`,
    [paymentId],
  );

  return {
    contractId,
    oldTenantId: tenantId,
    newTenantId: newTenant.rows[0].id,
    invoiceId,
    paymentId,
    receiptId: receipt.rows[0].id,
    companyId,
    propertyId,
  };
}

async function tenantOf(
  client: PoolClient,
  table: "invoices" | "payments" | "receipts",
  id: string,
): Promise<string> {
  const result = await client.query<{ tenant_id: string }>(
    `select tenant_id from public.${table} where id = $1`,
    [id],
  );
  return result.rows[0].tenant_id;
}

async function moveTenant(client: PoolClient, seeded: Seeded): Promise<void> {
  await client.query(`update public.contracts set tenant_id = $1 where id = $2`, [
    seeded.newTenantId,
    seeded.contractId,
  ]);
}

describe("migration 190 — contract tenant change propagates", () => {
  test("the contract's records move to the new tenant and none stay behind", async () => {
    await withRollback(async (client) => {
      const seeded = await seedContractWithMoney(client);

      await moveTenant(client, seeded);

      expect(await tenantOf(client, "invoices", seeded.invoiceId)).toBe(seeded.newTenantId);
      expect(await tenantOf(client, "payments", seeded.paymentId)).toBe(seeded.newTenantId);
      expect(await tenantOf(client, "receipts", seeded.receiptId)).toBe(seeded.newTenantId);

      // Counts are scoped to the fixture's own tenant: the database is not
      // empty at rest, so a global count would assert nothing.
      const leftBehind = await client.query<{
        invoices: string;
        payments: string;
        receipts: string;
      }>(
        `select (select count(*) from public.invoices where tenant_id = $1) as invoices,
                (select count(*) from public.payments where tenant_id = $1) as payments,
                (select count(*) from public.receipts where tenant_id = $1) as receipts`,
        [seeded.oldTenantId],
      );
      expect(leftBehind.rows[0]).toEqual({ invoices: "0", payments: "0", receipts: "0" });
    });
  });

  // The whole point of relabelling rather than reissuing: a receipt the tenant
  // already holds must keep the number printed on it, and the ledger must not
  // shift by a single fils.
  test("amounts, allocations and receipt codes survive the move unchanged", async () => {
    await withRollback(async (client) => {
      const seeded = await seedContractWithMoney(client);

      const snapshot = `select (select code from public.receipts where id = $1) as receipt_code,
                (select amount from public.receipts where id = $1) as receipt_amount,
                (select code from public.invoices where id = $2) as invoice_code,
                (select total from public.invoices where id = $2) as invoice_total,
                (select paid from public.invoices where id = $2) as invoice_paid,
                (select amount from public.payment_allocations where invoice_id = $2) as allocated`;

      const before = await client.query(snapshot, [seeded.receiptId, seeded.invoiceId]);

      await moveTenant(client, seeded);

      const after = await client.query(snapshot, [seeded.receiptId, seeded.invoiceId]);
      expect(after.rows[0]).toEqual(before.rows[0]);
    });
  });

  // The dangerous bug this migration could have shipped: an UPDATE scoped to
  // the tenant instead of the contract, which would drag every other contract
  // that tenant holds along with the one actually being reassigned.
  test("the departing tenant's other contracts and unrelated payments stay put", async () => {
    await withRollback(async (client) => {
      const seeded = await seedContractWithMoney(client);

      const otherContract = await client.query<{ id: string }>(
        `insert into public.contracts (code, tenant_id, start_date, end_date, state)
         values ($1, $2, '2025-01-01', '2026-12-31', 'active') returning id`,
        [`C-other-${randomUUID().slice(0, 8)}`, seeded.oldTenantId],
      );
      const otherInvoiceId = await seedPaidInvoice(client, {
        contractId: otherContract.rows[0].id,
        tenantId: seeded.oldTenantId,
        companyId: seeded.companyId,
      });

      // A payment with no allocation to the moving contract — reachable only
      // by a tenant-scoped UPDATE, never by the contract-scoped one.
      const unrelatedPayment = await client.query<{ id: string }>(
        `insert into public.payments (tenant_id, amount, method, status, payment_date)
         values ($1, 250, 'cash', 'confirmed', current_date) returning id`,
        [seeded.oldTenantId],
      );

      await moveTenant(client, seeded);

      expect(await tenantOf(client, "invoices", otherInvoiceId)).toBe(seeded.oldTenantId);
      expect(await tenantOf(client, "payments", unrelatedPayment.rows[0].id)).toBe(
        seeded.oldTenantId,
      );
    });
  });
});
