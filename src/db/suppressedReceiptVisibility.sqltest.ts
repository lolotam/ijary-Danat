import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 174 — a suppressed contract's receipt never reaches the tenant.
 *
 * Run against the database rather than through a server function on purpose:
 * the hole this closes was that `tg_sync_payment_receipt` writes
 * `visible_to_tenant = true` from the TENANT's default the instant a payment is
 * confirmed, before any allocation exists — so no amount of care in the webhook
 * could have caught it. The correction has to hold for every writer, and only a
 * database test proves that.
 */

/**
 * عقد بفواتير، ومستأجر إيصالاته ظاهرة له افتراضياً.
 *
 * `receipt_visible_to_tenant = true` is the case that matters: seven of the
 * eight production roof tenants have it, and it is what makes the receipt
 * arrive already visible. A fixture defaulting it to false would let this whole
 * file pass against the broken schema.
 */
async function scenario(client: PoolClient, suppressed: boolean) {
  const fx = await seedContract(client, {
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    monthlyAmount: 500,
  });
  await client.query(`update public.tenants set receipt_visible_to_tenant = true where id = $1`, [
    fx.tenantId,
  ]);
  await client.query(
    `update public.contracts set suppress_tenant_billing_docs = $2 where id = $1`,
    [fx.contractId, suppressed],
  );
  await client.query(`select public.generate_invoices($1::uuid, 2026)`, [fx.contractId]);
  const invoice = await client.query<{ id: string; total: string }>(
    `select id, total from public.invoices where contract_id = $1
      order by period_year, period_month limit 1`,
    [fx.contractId],
  );
  return { ...fx, invoice: invoice.rows[0] };
}

/** يؤكد دفعة ثم يخصّصها للفاتورة — نفس ترتيب البوابة: الدفعة أولاً ثم التخصيص. */
async function payAndAllocate(client: PoolClient, fx: Awaited<ReturnType<typeof scenario>>) {
  const payment = await client.query<{ id: string }>(
    `insert into public.payments (tenant_id, amount, currency, method, status, payment_date)
     values ($1, $2, 'KWD', 'knet', 'confirmed', current_date) returning id`,
    [fx.tenantId, fx.invoice.total],
  );
  const paymentId = payment.rows[0].id;

  const bornVisible = await client.query<{ visible_to_tenant: boolean }>(
    `select visible_to_tenant from public.receipts where payment_id = $1`,
    [paymentId],
  );

  await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
    paymentId,
    JSON.stringify([{ invoice_id: fx.invoice.id, amount: Number(fx.invoice.total) }]),
  ]);

  const afterAllocation = await client.query<{ visible_to_tenant: boolean }>(
    `select visible_to_tenant from public.receipts where payment_id = $1`,
    [paymentId],
  );

  return {
    bornVisible: bornVisible.rows[0]?.visible_to_tenant,
    afterAllocation: afterAllocation.rows[0]?.visible_to_tenant,
  };
}

describe("a suppressed contract's receipt is hidden once the allocation names it", () => {
  test("the receipt is born visible — this is the hole, and it must stay reproduced", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client, true);
      const { bornVisible } = await payAndAllocate(client, fx);
      // If this ever reads false the trigger in migration 05 changed, and the
      // rest of this file would pass for the wrong reason.
      expect(bornVisible).toBe(true);
    });
  });

  test("allocating to a suppressed contract's invoice hides the receipt", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client, true);
      const { afterAllocation } = await payAndAllocate(client, fx);
      expect(afterAllocation).toBe(false);
    });
  });

  test("an ordinary contract's receipt stays visible", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client, false);
      const { bornVisible, afterAllocation } = await payAndAllocate(client, fx);
      expect(bornVisible).toBe(true);
      expect(afterAllocation).toBe(true);
    });
  });

  // The trigger must only ever hide. Writing `true` would override an office
  // decision to withhold a receipt on a perfectly ordinary contract.
  test("a withheld receipt on an ordinary contract is not revealed", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 500,
      });
      await client.query(
        `update public.tenants set receipt_visible_to_tenant = false where id = $1`,
        [fx.tenantId],
      );
      await client.query(`select public.generate_invoices($1::uuid, 2026)`, [fx.contractId]);
      const invoice = await client.query<{ id: string; total: string }>(
        `select id, total from public.invoices where contract_id = $1
          order by period_year, period_month limit 1`,
        [fx.contractId],
      );
      const { bornVisible, afterAllocation } = await payAndAllocate(client, {
        ...fx,
        invoice: invoice.rows[0],
      });
      expect(bornVisible).toBe(false);
      expect(afterAllocation).toBe(false);
    });
  });
});

describe("enabling suppression on an existing contract hides the receipts it already has", () => {
  // Migration 175. The ninth roof contract: its allocations already exist, so
  // 174's allocation trigger can never fire for them and 173's backfill has
  // long since run. Without this the admin toggle would look like it worked.
  test("a receipt allocated before the flag was set is hidden when it is set", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client, false);
      const { afterAllocation } = await payAndAllocate(client, fx);
      expect(afterAllocation).toBe(true);

      await client.query(
        `update public.contracts set suppress_tenant_billing_docs = true where id = $1`,
        [fx.contractId],
      );

      const hidden = await client.query<{ visible_to_tenant: boolean }>(
        `select r.visible_to_tenant from public.receipts r
           join public.payment_allocations pa on pa.payment_id = r.payment_id
           join public.invoices i on i.id = pa.invoice_id
          where i.contract_id = $1`,
        [fx.contractId],
      );
      expect(hidden.rows.map((row) => row.visible_to_tenant)).toEqual([false]);
    });
  });

  // Only ever hides. `tenants.receipt_visible_to_tenant` is the office's call
  // about whether the tenant sees receipts at all, and turning suppression off
  // must not overrule it in the permissive direction.
  test("turning suppression back off does not reveal the receipts again", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client, false);
      await payAndAllocate(client, fx);
      await client.query(
        `update public.contracts set suppress_tenant_billing_docs = true where id = $1`,
        [fx.contractId],
      );
      await client.query(
        `update public.contracts set suppress_tenant_billing_docs = false where id = $1`,
        [fx.contractId],
      );

      const after = await client.query<{ visible_to_tenant: boolean }>(
        `select r.visible_to_tenant from public.receipts r
           join public.payment_allocations pa on pa.payment_id = r.payment_id
           join public.invoices i on i.id = pa.invoice_id
          where i.contract_id = $1`,
        [fx.contractId],
      );
      expect(after.rows.map((row) => row.visible_to_tenant)).toEqual([false]);
    });
  });

  // An unrelated contract's receipts must not be caught by the sweep.
  test("another contract's receipts are untouched", async () => {
    await withRollback(async (client) => {
      const mine = await scenario(client, false);
      await payAndAllocate(client, mine);
      const other = await scenario(client, false);
      const otherResult = await payAndAllocate(client, other);
      expect(otherResult.afterAllocation).toBe(true);

      await client.query(
        `update public.contracts set suppress_tenant_billing_docs = true where id = $1`,
        [mine.contractId],
      );

      const untouched = await client.query<{ visible_to_tenant: boolean }>(
        `select r.visible_to_tenant from public.receipts r
           join public.payment_allocations pa on pa.payment_id = r.payment_id
           join public.invoices i on i.id = pa.invoice_id
          where i.contract_id = $1`,
        [other.contractId],
      );
      expect(untouched.rows.map((row) => row.visible_to_tenant)).toEqual([true]);
    });
  });
});
