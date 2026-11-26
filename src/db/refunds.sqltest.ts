import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import {
  actAs,
  actAsSuperuser,
  closePool,
  seedCompanyUser,
  seedContract,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/**
 * T13 — refunds, partial payments and insurance.
 *
 * Two of these assertions are the point of the whole batch:
 *   * archiving after a refund must never destroy financial history;
 *   * a partial payment that names no invoice must still move nothing, and
 *     neither kind may ever be summed into the budget twice.
 *
 * Migration 147 made inertness true of EVERY partial payment. Migration 160
 * deliberately narrowed it: a row naming an invoice now settles it through a
 * real payment and allocation. What survives here is the unlinked case, and the
 * budget exclusion — which is now required for correctness rather than by
 * design, because the settlement's own `payments` row is what the budget counts.
 */

const RANGE = ["2026-01-01", "2026-12-31"] as const;

async function budget(client: PoolClient) {
  const { rows } = await client.query<{ summary: Record<string, unknown> }>(
    `select public.get_budget_summary($1::date, $2::date, null, null) as summary`,
    [RANGE[0], RANGE[1]],
  );
  return rows[0].summary;
}

/** A confirmed cash payment, which is what `collections` counts. */
async function seedPayment(client: PoolClient, tenantId: string, amount: number) {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.payments (tenant_id, amount, method, status, payment_date)
     values ($1, $2, 'cash', 'confirmed', '2026-03-01') returning id`,
    [tenantId, amount],
  );
  return rows[0].id;
}

describe("refunds affect the budget", () => {
  test("a refund is reported and deducted from net", async () => {
    await withRollback(async (client) => {
      const { tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await seedPayment(client, tenantId, 1000);

      const before = await budget(client);
      expect(Number(before.collections)).toBe(1000);
      expect(Number(before.refunds)).toBe(0);
      expect(Number(before.net)).toBe(Number(before.collections) - Number(before.expenses));

      await client.query(
        `insert into public.refunds (tenant_id, amount, refund_date, post_action)
         values ($1, 250, '2026-04-01', 'store')`,
        [tenantId],
      );

      const after = await budget(client);
      expect(Number(after.refunds)).toBe(250);
      // net is now collections - expenses - refunds. Money that left the
      // business cannot be ignored by a "net" figure.
      expect(Number(after.net)).toBe(Number(before.net) - 250);
    });
  });

  test("a reversed payment is not double-counted alongside a refund", async () => {
    // reverse_payment writes POSITIVE mirror allocations, so anything summing
    // payment_allocations would count a reversal twice. Collections filter on
    // the payment row instead.
    await withRollback(async (client) => {
      const { tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const original = await seedPayment(client, tenantId, 1000);
      const mirror = await seedPayment(client, tenantId, 1000);
      await client.query(`update public.payments set reversed_by_payment_id = $1 where id = $2`, [
        mirror,
        original,
      ]);
      await client.query(`update public.payments set status = 'reversed' where id = $1`, [mirror]);

      const summary = await budget(client);
      // Neither leg counts: the original is reversed, the mirror is not
      // 'confirmed'.
      expect(Number(summary.collections)).toBe(0);
    });
  });

  test("refunds outside the range are excluded", async () => {
    await withRollback(async (client) => {
      const { tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(
        `insert into public.refunds (tenant_id, amount, refund_date, post_action)
         values ($1, 500, '2025-04-01', 'store')`,
        [tenantId],
      );
      expect(Number((await budget(client)).refunds)).toBe(0);
    });
  });
});

describe("post-refund actions", () => {
  test("archive hides the tenant and contract but keeps the financial history", async () => {
    // The decisive assertion for T13a: "deleted" means archived, never erased.
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);
      const paymentId = await seedPayment(client, tenantId, 500);
      const invoicesBefore = await client.query(
        `select id from public.invoices where contract_id = $1`,
        [contractId],
      );
      expect(invoicesBefore.rows.length).toBeGreaterThan(0);

      await client.query(`update public.tenants set archived_at = now() where id = $1`, [tenantId]);
      await client.query(`update public.contracts set archived_at = now() where id = $1`, [
        contractId,
      ]);

      const tenant = await client.query<{ archived_at: string | null }>(
        `select archived_at from public.tenants where id = $1`,
        [tenantId],
      );
      expect(tenant.rows[0].archived_at).not.toBeNull();

      const invoicesAfter = await client.query(
        `select id from public.invoices where contract_id = $1`,
        [contractId],
      );
      expect(invoicesAfter.rows.length).toBe(invoicesBefore.rows.length);
      const payment = await client.query(`select id from public.payments where id = $1`, [
        paymentId,
      ]);
      expect(payment.rows).toHaveLength(1);
    });
  });

  test("freeze stops invoice generation without hiding the contract", async () => {
    // `frozen` already exists in contract_states, and generate_invoices_for_year
    // only generates for 'active' — so freezing needs no new flag.
    await withRollback(async (client) => {
      const { contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`update public.contracts set state = 'frozen' where id = $1`, [
        contractId,
      ]);

      const { rows } = await client.query(
        `select * from public.generate_invoices_for_year($1, 2026, false)`,
        [contractId],
      );
      expect(rows).toHaveLength(0);

      const visible = await client.query<{ archived_at: string | null }>(
        `select archived_at from public.contracts where id = $1`,
        [contractId],
      );
      expect(visible.rows[0].archived_at).toBeNull();
    });
  });
});

describe("an unlinked partial payment is still inert", () => {
  test("creating one changes no invoice balance and no budget figure", async () => {
    // The isolation IS the feature for a row that names no invoice. Without this
    // test the unlinked case drifts into the money path the first time somebody
    // "improves" it.
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);
      await seedPayment(client, tenantId, 1000);

      const invoicesBefore = await client.query(
        `select id, paid, balance, state from public.invoices
          where contract_id = $1 order by period_month`,
        [contractId],
      );
      const budgetBefore = await budget(client);

      await client.query(
        `insert into public.partial_payments (tenant_id, contract_id, amount, paid_date)
         values ($1, $2, 123.456, '2026-03-01')`,
        [tenantId, contractId],
      );

      const invoicesAfter = await client.query(
        `select id, paid, balance, state from public.invoices
          where contract_id = $1 order by period_month`,
        [contractId],
      );
      expect(invoicesAfter.rows).toEqual(invoicesBefore.rows);
      expect(await budget(client)).toEqual(budgetBefore);
    });
  });

  test("it creates no payment allocation", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(
        `insert into public.partial_payments (tenant_id, contract_id, amount)
         values ($1, $2, 99)`,
        [tenantId, contractId],
      );
      const { rows } = await client.query(
        `select 1 from public.payment_allocations pa
          join public.invoices i on i.id = pa.invoice_id where i.contract_id = $1`,
        [contractId],
      );
      expect(rows).toHaveLength(0);
    });
  });

  test("a LINKED partial is counted once, through its payment and not twice", async () => {
    // get_budget_summary still excludes partial_payments by name (106:107). That
    // exclusion used to mean "this money is not real"; it now means "this money
    // is already counted", and dropping it would double every partial payment.
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`select public.generate_invoices($1::uuid, 2026)`, [contractId]);
      const target = await client.query<{ id: string }>(
        `select id from public.invoices where contract_id = $1
          order by period_year, period_month limit 1`,
        [contractId],
      );
      const before = Number((await budget(client)).collections);

      await client.query(
        `insert into public.partial_payments (tenant_id, contract_id, invoice_id, amount, paid_date)
         values ($1, $2, $3, 100, '2026-03-01')`,
        [tenantId, contractId, target.rows[0].id],
      );

      const summary = await budget(client);
      expect(summary).not.toHaveProperty("partial_payments");
      expect(Number(summary.collections) - before).toBe(100);
    });
  });
});

describe("insurance payments", () => {
  test("appear under insurance_collected, never under deposits", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        deposit: 750,
      });
      const before = await budget(client);

      await client.query(
        `insert into public.insurance_payments (tenant_id, contract_id, amount, collected_date)
         values ($1, $2, 750, '2026-02-01')`,
        [tenantId, contractId],
      );

      const after = await budget(client);
      expect(Number(after.insurance_collected)).toBe(750);
      // `deposits` already backs a shipped KPI card for BANK deposits. Insurance
      // must not leak into it.
      expect(Number(after.deposits)).toBe(Number(before.deposits));
      // Insurance is a holding, not revenue, so it does not move net either.
      expect(Number(after.net)).toBe(Number(before.net));
    });
  });

  test("one insurance record per contract", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        deposit: 500,
      });
      const insert = `insert into public.insurance_payments (tenant_id, contract_id, amount)
                      values ($1, $2, 500)`;
      await client.query(insert, [tenantId, contractId]);
      await expect(client.query(insert, [tenantId, contractId])).rejects.toThrow(
        /duplicate key|unique/i,
      );
    });
  });

  test("is a different table from public.deposits", async () => {
    await withRollback(async (client) => {
      // public.deposits has no TENANT link — that is why it cannot model
      // insurance, which is held per tenant.
      //
      // It does carry `contract_id` since migration 152, but only as one half of
      // the contract+invoice pair naming the invoice a bank deposit settles. That
      // is a pointer to a debt, not a holding: the deposit's money leaves through
      // a payment allocation, while an insurance holding sits on the books until
      // close-out. Narrowed from the original assertion, which forbade both
      // columns and would now fail for the wrong reason.
      const { rows } = await client.query<{ count: string }>(
        `select count(*)::text as count from information_schema.columns
          where table_name = 'deposits' and column_name in ('tenant_id', 'unit_id')`,
      );
      expect(rows[0].count).toBe("0");
    });
  });
});

describe("RLS", () => {
  test("a signed-in non-staff user cannot read refunds", async () => {
    await withRollback(async (client) => {
      const { tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(
        `insert into public.refunds (tenant_id, amount, post_action) values ($1, 100, 'store')`,
        [tenantId],
      );

      await actAs(client, "authenticated", randomUUID());
      const { rows } = await client.query(`select id from public.refunds`);
      expect(rows).toHaveLength(0);
    });
  });

  test("an accountant may record a refund but not delete one", async () => {
    await withRollback(async (client) => {
      const { companyId, tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const accountant = await seedCompanyUser(client, companyId, "accountant");
      await actAs(client, "authenticated", accountant);

      const inserted = await client.query<{ id: string }>(
        `insert into public.refunds (company_id, tenant_id, amount, post_action)
         values ($1, $2, 100, 'store') returning id`,
        [companyId, tenantId],
      );
      expect(inserted.rows).toHaveLength(1);

      const deleted = await client.query(`delete from public.refunds where id = $1 returning id`, [
        inserted.rows[0].id,
      ]);
      expect(deleted.rows).toHaveLength(0);

      await actAsSuperuser(client);
      const still = await client.query(`select id from public.refunds where id = $1`, [
        inserted.rows[0].id,
      ]);
      expect(still.rows).toHaveLength(1);
    });
  });

  test("an accountant's refund is kept even when its archive follow-up is refused", async () => {
    // Journey 11 step 14. An accountant may record refunds but may not archive
    // tenants, and the two must not share a fate: the money record is the part
    // that matters, so it has to survive the follow-up being refused.
    //
    // RLS refuses by updating *zero rows silently* rather than raising, which is
    // the trap — a caller that only checks for a thrown error concludes the
    // archive succeeded. This asserts on rows, not on exceptions.
    await withRollback(async (client) => {
      const { companyId, tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const accountant = await seedCompanyUser(client, companyId, "accountant");
      await actAs(client, "authenticated", accountant);

      const refund = await client.query<{ id: string }>(
        `insert into public.refunds (company_id, tenant_id, amount, post_action)
         values ($1, $2, 100, 'archive') returning id`,
        [companyId, tenantId],
      );
      expect(refund.rows).toHaveLength(1);

      const archived = await client.query(
        `update public.tenants set archived_at = now() where id = $1 returning id`,
        [tenantId],
      );
      expect(archived.rows).toHaveLength(0);

      await actAsSuperuser(client);
      const [keptRefund, tenant] = await Promise.all([
        client.query(`select id from public.refunds where id = $1`, [refund.rows[0].id]),
        client.query<{ archived_at: string | null }>(
          `select archived_at from public.tenants where id = $1`,
          [tenantId],
        ),
      ]);
      expect(keptRefund.rows).toHaveLength(1);
      expect(tenant.rows[0].archived_at).toBeNull();
    });
  });
});
