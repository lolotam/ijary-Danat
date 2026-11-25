import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/** عقد بفاتورة ودفعة مؤكّدة، مع إيصال ظاهر للمستأجر. */
async function seedPaidContract(client: PoolClient) {
  const fixture = await seedContract(client, {
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    monthlyAmount: 300,
  });
  // The receipt is born visible only when the tenant is set to receive them,
  // which is what seven of the eight roof tenants have (migration 174).
  await client.query(`update public.tenants set receipt_visible_to_tenant = true where id = $1`, [
    fixture.tenantId,
  ]);
  await client.query(`select public.generate_invoices($1::uuid, 2026)`, [fixture.contractId]);
  const invoice = await client.query<{ id: string; total: string }>(
    `select id, total from public.invoices where contract_id = $1
      order by period_year, period_month limit 1`,
    [fixture.contractId],
  );
  const amount = Number(invoice.rows[0].total);
  const payment = await client.query<{ id: string }>(
    `insert into public.payments (code, tenant_id, method, amount, payment_date, status)
     values (public.next_payment_code(), $1, 'cash', $2, current_date, 'confirmed')
     returning id`,
    [fixture.tenantId, amount],
  );
  return { ...fixture, amount, invoiceId: invoice.rows[0].id, paymentId: payment.rows[0].id };
}

/** هل الإيصال ظاهر للمستأجر؟ */
async function receiptVisible(client: PoolClient, paymentId: string): Promise<boolean | null> {
  const { rows } = await client.query<{ visible_to_tenant: boolean }>(
    `select visible_to_tenant from public.receipts where payment_id = $1`,
    [paymentId],
  );
  return rows.length ? rows[0].visible_to_tenant : null;
}

/**
 * Review round 3 on PR #209. `receipts_select_allowed` authorises a tenant read
 * purely on `receipts.visible_to_tenant`, and migrations 174 and 175 only ever
 * looked at `suppress_tenant_billing_docs`. Every hidden contract in production
 * also carries that older flag today, so nothing was exposed — but migration
 * 210 exists precisely so a ninth roof contract flips one switch, and hidden
 * without suppressed would have kept serving the printable receipt over REST.
 */
describe("hiding a contract hides its receipts too (migration 214)", () => {
  test("a receipt created after the flag is set is born hidden", async () => {
    await withRollback(async (client) => {
      const fixture = await seedPaidContract(client);
      await client.query(`update public.contracts set hide_from_portal = true where id = $1`, [
        fixture.contractId,
      ]);

      // The allocation is the first moment the contract is knowable, which is
      // where migration 174 put the correction.
      await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
        fixture.paymentId,
        JSON.stringify([{ invoice_id: fixture.invoiceId, amount: fixture.amount }]),
      ]);

      expect(await receiptVisible(client, fixture.paymentId)).toBe(false);
    });
  });

  test("switching the flag on hides receipts the contract already had", async () => {
    await withRollback(async (client) => {
      const fixture = await seedPaidContract(client);
      await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
        fixture.paymentId,
        JSON.stringify([{ invoice_id: fixture.invoiceId, amount: fixture.amount }]),
      ]);
      expect(await receiptVisible(client, fixture.paymentId)).toBe(true);

      await client.query(`update public.contracts set hide_from_portal = true where id = $1`, [
        fixture.contractId,
      ]);

      expect(await receiptVisible(client, fixture.paymentId)).toBe(false);
    });
  });

  /**
   * Only ever hides, exactly as migrations 174 and 175 state.
   * `tenants.receipt_visible_to_tenant` is the office's own decision about
   * whether a tenant sees receipts at all, and these triggers have no business
   * overruling it in the permissive direction.
   */
  test("turning the flag back off does not reveal the receipt again", async () => {
    await withRollback(async (client) => {
      const fixture = await seedPaidContract(client);
      await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
        fixture.paymentId,
        JSON.stringify([{ invoice_id: fixture.invoiceId, amount: fixture.amount }]),
      ]);
      await client.query(`update public.contracts set hide_from_portal = true where id = $1`, [
        fixture.contractId,
      ]);
      await client.query(`update public.contracts set hide_from_portal = false where id = $1`, [
        fixture.contractId,
      ]);

      expect(await receiptVisible(client, fixture.paymentId)).toBe(false);
    });
  });

  // An ordinary contract must be untouched: the office's own decision to show
  // receipts still stands.
  test("an ordinary contract's receipt stays visible", async () => {
    await withRollback(async (client) => {
      const fixture = await seedPaidContract(client);
      await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
        fixture.paymentId,
        JSON.stringify([{ invoice_id: fixture.invoiceId, amount: fixture.amount }]),
      ]);

      expect(await receiptVisible(client, fixture.paymentId)).toBe(true);
    });
  });
});

/**
 * The client cannot tell "this payment settles a hidden lease" from "this
 * payment's invoices are unreadable for some other reason" — both arrive as an
 * allocation that resolves to nothing. Inferring the first from the second
 * swallowed payments out of the tenant's history, so the server answers it.
 */
describe("portal_hidden_payment_ids (migration 214)", () => {
  test("names a payment allocated entirely to a hidden contract", async () => {
    await withRollback(async (client) => {
      const fixture = await seedPaidContract(client);
      await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
        fixture.paymentId,
        JSON.stringify([{ invoice_id: fixture.invoiceId, amount: fixture.amount }]),
      ]);
      await client.query(`update public.contracts set hide_from_portal = true where id = $1`, [
        fixture.contractId,
      ]);

      const { rows } = await client.query<{ portal_hidden_payment_ids: string }>(
        `select public.portal_hidden_payment_ids($1::uuid)`,
        [fixture.tenantId],
      );
      expect(rows.map((row) => row.portal_hidden_payment_ids)).toEqual([fixture.paymentId]);
    });
  });

  test("leaves a payment whose invoice is merely flagged invisible to the tenant", async () => {
    await withRollback(async (client) => {
      const fixture = await seedPaidContract(client);
      await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
        fixture.paymentId,
        JSON.stringify([{ invoice_id: fixture.invoiceId, amount: fixture.amount }]),
      ]);
      // Nothing to do with roofs — an admin's own visibility switch.
      await client.query(`update public.invoices set is_visible_to_tenant = false where id = $1`, [
        fixture.invoiceId,
      ]);

      const { rows } = await client.query(`select public.portal_hidden_payment_ids($1::uuid)`, [
        fixture.tenantId,
      ]);
      expect(rows).toEqual([]);
    });
  });

  // The tenant's own money sitting unapplied has no lease to be hidden by.
  test("never names a payment that has no allocations at all", async () => {
    await withRollback(async (client) => {
      const fixture = await seedPaidContract(client);
      await client.query(`update public.contracts set hide_from_portal = true where id = $1`, [
        fixture.contractId,
      ]);

      const { rows } = await client.query(`select public.portal_hidden_payment_ids($1::uuid)`, [
        fixture.tenantId,
      ]);
      expect(rows).toEqual([]);
    });
  });

  /**
   * Review round 4 on PR #209. `apply_payment_allocation` only refuses
   * allocations whose total exceeds the payment, so a partly-applied payment is
   * a supported state — and hiding the whole thing would take the unapplied
   * remainder out of the tenant's sight along with the hidden part.
   */
  test("leaves a payment that still has money unapplied", async () => {
    await withRollback(async (client) => {
      const fixture = await seedPaidContract(client);
      // KWD 200 more than the invoice needs, so 200 stays unapplied.
      await client.query(`update public.payments set amount = $2 where id = $1`, [
        fixture.paymentId,
        fixture.amount + 200,
      ]);
      await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
        fixture.paymentId,
        JSON.stringify([{ invoice_id: fixture.invoiceId, amount: fixture.amount }]),
      ]);
      await client.query(`update public.contracts set hide_from_portal = true where id = $1`, [
        fixture.contractId,
      ]);

      const { rows } = await client.query(`select public.portal_hidden_payment_ids($1::uuid)`, [
        fixture.tenantId,
      ]);
      expect(rows).toEqual([]);
    });
  });

  test("leaves a payment split across a hidden and a visible lease", async () => {
    await withRollback(async (client) => {
      const fixture = await seedPaidContract(client);
      const second = await client.query<{ id: string }>(
        `insert into public.units (code, property_id, name) values ($1, $2, $3) returning id`,
        [`U-hv-${fixture.contractId.slice(0, 8)}`, fixture.propertyId, "Shop unit"],
      );
      const shop = await client.query<{ id: string }>(
        `insert into public.contracts
           (code, tenant_id, start_date, end_date, due_day, grace_days, deposit, state)
         values ($1, $2, '2026-01-01'::date, '2026-12-31'::date, 1, 0, 0, 'active'::public.contract_states)
         returning id`,
        [`C-hv-${fixture.contractId.slice(0, 8)}`, fixture.tenantId],
      );
      await client.query(
        `insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
         values ($1, $2, 300, 1)`,
        [shop.rows[0].id, second.rows[0].id],
      );
      await client.query(`select public.generate_invoices($1::uuid, 2026)`, [shop.rows[0].id]);
      const shopInvoice = await client.query<{ id: string; total: string }>(
        `select id, total from public.invoices where contract_id = $1
          order by period_year, period_month limit 1`,
        [shop.rows[0].id],
      );

      await client.query(`update public.payments set amount = $2 where id = $1`, [
        fixture.paymentId,
        fixture.amount + Number(shopInvoice.rows[0].total),
      ]);
      await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
        fixture.paymentId,
        JSON.stringify([
          { invoice_id: fixture.invoiceId, amount: fixture.amount },
          { invoice_id: shopInvoice.rows[0].id, amount: Number(shopInvoice.rows[0].total) },
        ]),
      ]);
      await client.query(`update public.contracts set hide_from_portal = true where id = $1`, [
        fixture.contractId,
      ]);

      // It settled a lease the tenant can see, so the payment stays — showing
      // only the visible half, which the client-side fold handles.
      const { rows } = await client.query(`select public.portal_hidden_payment_ids($1::uuid)`, [
        fixture.tenantId,
      ]);
      expect(rows).toEqual([]);
    });
  });
});
