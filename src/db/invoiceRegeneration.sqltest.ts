import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { captureRaise, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * T15 — regenerating a contract's invoices without destroying invoice identity.
 *
 * The defining risk is not arithmetic, it is UUID churn:
 * `payment_requests.requested_invoice_ids` is a `uuid[]` with no foreign key, so
 * a delete-and-recreate silently orphans any KNET link already sent to a tenant.
 * Nothing in the database complains; the tenant pays and the money lands against
 * no invoice. Only a real database can demonstrate that.
 */

/** A contract whose whole span is in the past, so every period is generated. */
async function seedPastContract(client: PoolClient, monthlyAmount = 500) {
  const fixture = await seedContract(client, {
    startDate: "2026-01-01",
    endDate: "2026-06-30",
    monthlyAmount,
  });
  await client.query(`select * from public.backfill_contract_invoices($1)`, [fixture.contractId]);
  return fixture;
}

async function invoicesOf(client: PoolClient, contractId: string) {
  const { rows } = await client.query<{
    id: string;
    period_month: number;
    total: string;
    paid: string;
    state: string;
  }>(
    `select id, period_month, total, paid, state from public.invoices
      where contract_id = $1 order by period_year, period_month`,
    [contractId],
  );
  return rows;
}

async function regenerate(client: PoolClient, contractId: string) {
  const { rows } = await client.query<{
    id: string;
    period_month: number;
    total: string;
    action: string;
  }>(`select id, period_month, total, action from public.regenerate_contract_invoices($1)`, [
    contractId,
  ]);
  return rows;
}

describe("regeneration updates in place", () => {
  test("changing monthly_amount updates unpaid invoice totals", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedPastContract(client, 500);
      expect((await invoicesOf(client, contractId))[0].total).toBe("500.000");

      await client.query(
        `update public.contract_units set monthly_amount = 750 where contract_id = $1`,
        [contractId],
      );
      await regenerate(client, contractId);

      const after = await invoicesOf(client, contractId);
      expect(after.length).toBeGreaterThan(0);
      for (const invoice of after) expect(invoice.total).toBe("750.000");
    });
  });

  test("invoice UUIDs are stable across regeneration", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedPastContract(client);
      const before = (await invoicesOf(client, contractId)).map((i) => i.id).sort();

      await client.query(
        `update public.contract_units set monthly_amount = 900 where contract_id = $1`,
        [contractId],
      );
      await regenerate(client, contractId);

      const after = (await invoicesOf(client, contractId)).map((i) => i.id).sort();
      expect(after).toEqual(before);
    });
  });

  test("a pending payment request still resolves after regeneration", async () => {
    // THE discriminating test. Comparing UUID *sets* can pass by luck if the
    // diff happens to regenerate the same number of rows; this asserts the one
    // specific id a tenant is mid-payment against still exists, and that its
    // total actually moved (proving regeneration ran rather than no-opped).
    await withRollback(async (client) => {
      const { contractId, tenantId } = await seedPastContract(client, 500);
      const invoices = await invoicesOf(client, contractId);
      const target = invoices[0];

      await client.query(
        `insert into public.payment_requests
           (tenant_id, amount, requested_invoice_ids, status)
         values ($1, $2, array[$3::uuid], 'pending')`,
        [tenantId, target.total, target.id],
      );

      await client.query(
        `update public.contract_units set monthly_amount = 640 where contract_id = $1`,
        [contractId],
      );
      await regenerate(client, contractId);

      const { rows } = await client.query<{ id: string; total: string }>(
        `select i.id, i.total from public.invoices i
          join public.payment_requests pr on i.id = any (pr.requested_invoice_ids)
         where pr.status = 'pending'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(target.id);
      expect(rows[0].total).toBe("640.000");
    });
  });

  test("regeneration is idempotent", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedPastContract(client);
      await client.query(
        `update public.contract_units set monthly_amount = 610 where contract_id = $1`,
        [contractId],
      );
      await regenerate(client, contractId);
      const first = await invoicesOf(client, contractId);

      await regenerate(client, contractId);
      const second = await invoicesOf(client, contractId);
      expect(second).toEqual(first);

      // Items must not accumulate — the delete-before-insert in the UPDATE
      // branch is what stops concession lines piling up on every run.
      const { rows } = await client.query<{ count: string }>(
        `select count(*)::text as count from public.invoice_items ii
          join public.invoices i on i.id = ii.invoice_id
         where i.contract_id = $1 and i.period_month = $2`,
        [contractId, first[0].period_month],
      );
      expect(rows[0].count).toBe("1");
    });
  });
});

describe("regeneration never touches settled money", () => {
  test("a paid invoice keeps its total and is reported as skipped", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedPastContract(client, 500);
      const invoices = await invoicesOf(client, contractId);
      const target = invoices[0];
      await client.query(`update public.invoices set paid = 500, state = 'paid' where id = $1`, [
        target.id,
      ]);

      await client.query(
        `update public.contract_units set monthly_amount = 900 where contract_id = $1`,
        [contractId],
      );
      const result = await regenerate(client, contractId);

      const after = await invoicesOf(client, contractId);
      const untouched = after.find((i) => i.id === target.id)!;
      expect(untouched.total).toBe("500.000");
      expect(untouched.paid).toBe("500.000");
      expect(result.find((r) => r.id === target.id)?.action).toBe("skipped");
    });
  });

  // Migration 52 wrote invoices.paid directly with no backing allocations, and
  // the next set_invoice_paid recomputed paid from surviving allocations and
  // silently zeroed it. This asserts regeneration leaves the two in agreement.
  test("paid still equals the sum of its allocations afterwards", async () => {
    await withRollback(async (client) => {
      const { contractId, tenantId } = await seedPastContract(client, 500);
      const target = (await invoicesOf(client, contractId))[0];

      const payment = await client.query<{ id: string }>(
        `insert into public.payments (tenant_id, amount, method, status, payment_date)
         values ($1, 500, 'cash', 'confirmed', current_date) returning id`,
        [tenantId],
      );
      await client.query(
        `insert into public.payment_allocations (payment_id, invoice_id, amount)
         values ($1, $2, 500)`,
        [payment.rows[0].id, target.id],
      );
      // There is no trigger on payment_allocations — `invoices.paid` is written
      // by the payment engine (applyAllocation / set_invoice_paid), so the
      // fixture has to establish the same state the application would.
      await client.query(`update public.invoices set paid = 500, state = 'paid' where id = $1`, [
        target.id,
      ]);

      await client.query(
        `update public.contract_units set monthly_amount = 700 where contract_id = $1`,
        [contractId],
      );
      await regenerate(client, contractId);

      const { rows } = await client.query<{ paid: string; allocated: string }>(
        `select i.paid::text as paid,
                coalesce((select sum(pa.amount) from public.payment_allocations pa
                           where pa.invoice_id = i.id), 0)::text as allocated
           from public.invoices i where i.id = $1`,
        [target.id],
      );
      expect(rows[0].paid).toBe(rows[0].allocated);
    });
  });
});

describe("periods that should no longer exist", () => {
  test("a genuinely clean out-of-range invoice is deleted", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedPastContract(client);
      const before = await invoicesOf(client, contractId);
      expect(before.length).toBeGreaterThan(3);

      await client.query(`update public.contracts set end_date = '2026-03-31' where id = $1`, [
        contractId,
      ]);
      const result = await regenerate(client, contractId);

      expect(result.some((r) => r.action === "deleted")).toBe(true);
      const after = await invoicesOf(client, contractId);
      expect(after.every((i) => i.period_month <= 3)).toBe(true);
    });
  });

  test("an out-of-range invoice carrying an allocation is cancelled, not deleted", async () => {
    await withRollback(async (client) => {
      const { contractId, tenantId } = await seedPastContract(client, 500);
      const invoices = await invoicesOf(client, contractId);
      const doomed = invoices[invoices.length - 1];

      const payment = await client.query<{ id: string }>(
        `insert into public.payments (tenant_id, amount, method, status, payment_date)
         values ($1, 500, 'cash', 'confirmed', current_date) returning id`,
        [tenantId],
      );
      await client.query(
        `insert into public.payment_allocations (payment_id, invoice_id, amount)
         values ($1, $2, 500)`,
        [payment.rows[0].id, doomed.id],
      );

      await client.query(`update public.contracts set end_date = '2026-02-28' where id = $1`, [
        contractId,
      ]);
      await regenerate(client, contractId);

      const { rows } = await client.query<{ state: string }>(
        `select state from public.invoices where id = $1`,
        [doomed.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe("cancelled");
    });
  });

  test("an out-of-range invoice with a PENDING payment request is cancelled, not deleted", async () => {
    // paid = 0 and no allocation, so every guard reapply_contract_invoices has
    // would happily delete this row — while a tenant is mid-payment against it.
    await withRollback(async (client) => {
      const { contractId, tenantId } = await seedPastContract(client, 500);
      const invoices = await invoicesOf(client, contractId);
      const doomed = invoices[invoices.length - 1];

      await client.query(
        `insert into public.payment_requests
           (tenant_id, amount, requested_invoice_ids, status)
         values ($1, 500, array[$2::uuid], 'pending')`,
        [tenantId, doomed.id],
      );

      await client.query(`update public.contracts set end_date = '2026-02-28' where id = $1`, [
        contractId,
      ]);
      await regenerate(client, contractId);

      const { rows } = await client.query<{ state: string }>(
        `select state from public.invoices where id = $1`,
        [doomed.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe("cancelled");
    });
  });

  test("a failed payment request does not protect a clean invoice", async () => {
    await withRollback(async (client) => {
      const { contractId, tenantId } = await seedPastContract(client, 500);
      const invoices = await invoicesOf(client, contractId);
      const doomed = invoices[invoices.length - 1];

      await client.query(
        `insert into public.payment_requests
           (tenant_id, amount, requested_invoice_ids, status)
         values ($1, 500, array[$2::uuid], 'failed')`,
        [tenantId, doomed.id],
      );

      await client.query(`update public.contracts set end_date = '2026-02-28' where id = $1`, [
        contractId,
      ]);
      await regenerate(client, contractId);

      const { rows } = await client.query(`select 1 from public.invoices where id = $1`, [
        doomed.id,
      ]);
      expect(rows).toHaveLength(0);
    });
  });
});

/**
 * Admin Generate for the rest of the year creates months after "today".
 * Regeneration used to delete those as "beyond horizon" — migration 94 keeps them.
 */
describe("future invoices survive regeneration (migration 94)", () => {
  test("an unpaid period after the current month is kept, not deleted", async () => {
    await withRollback(async (client) => {
      // Contract spans past → far future so a future month always exists relative
      // to wall-clock current_date, regardless of when the suite runs.
      const { contractId } = await seedContract(client, {
        startDate: "2020-01-01",
        endDate: "2035-12-31",
        monthlyAmount: 400,
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);

      const futureYear = new Date().getFullYear() + 1;
      await client.query(`select * from public.generate_invoices_for_year($1, $2, false)`, [
        contractId,
        futureYear,
      ]);

      const { rows: before } = await client.query<{ id: string; period_year: number }>(
        `select id, period_year from public.invoices
          where contract_id = $1 and period_year = $2
          order by period_month`,
        [contractId, futureYear],
      );
      expect(before.length).toBeGreaterThan(0);
      const beforeIds = before.map((row) => row.id).sort();

      await client.query(
        `update public.contract_units set monthly_amount = 450 where contract_id = $1`,
        [contractId],
      );
      await regenerate(client, contractId);

      const { rows: after } = await client.query<{ id: string; total: string }>(
        `select id, total from public.invoices
          where contract_id = $1 and period_year = $2
          order by period_month`,
        [contractId, futureYear],
      );
      expect(after.map((row) => row.id).sort()).toEqual(beforeIds);
      for (const invoice of after) expect(invoice.total).toBe("450.000");
    });
  });

  test("a paid future invoice keeps paid status and total when regenerating", async () => {
    // Migration 95: early skip for paid rows — never cancel/delete/overwrite.
    await withRollback(async (client) => {
      const { contractId } = await seedContract(client, {
        startDate: "2020-01-01",
        endDate: "2035-12-31",
        monthlyAmount: 500,
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);

      const futureYear = new Date().getFullYear() + 1;
      await client.query(`select * from public.generate_invoices_for_year($1, $2, false)`, [
        contractId,
        futureYear,
      ]);

      const { rows: futures } = await client.query<{ id: string; total: string }>(
        `select id, total from public.invoices
          where contract_id = $1 and period_year = $2
          order by period_month limit 1`,
        [contractId, futureYear],
      );
      expect(futures).toHaveLength(1);
      const paidId = futures[0].id;

      await client.query(`update public.invoices set paid = total, state = 'paid' where id = $1`, [
        paidId,
      ]);

      await client.query(
        `update public.contract_units set monthly_amount = 999 where contract_id = $1`,
        [contractId],
      );
      // Shorten the contract so the paid future month is "out of range" — old
      // code cancelled it; paid rows must still skip.
      await client.query(`update public.contracts set end_date = '2024-12-31' where id = $1`, [
        contractId,
      ]);
      const result = await regenerate(client, contractId);

      const { rows } = await client.query<{
        id: string;
        total: string;
        paid: string;
        state: string;
      }>(`select id, total, paid, state from public.invoices where id = $1`, [paidId]);
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe("paid");
      expect(rows[0].paid).toBe(rows[0].total);
      expect(rows[0].total).toBe("500.000");
      expect(result.find((r) => r.id === paidId)?.action).toBe("skipped");
    });
  });
});

describe("concessions", () => {
  test("contract_period_amounts agrees with what the generator billed", async () => {
    // After migration 127 neither path applies percentage/fixed discounts by
    // date range — those bind through apply_concession_to_invoices. The two
    // must still agree, or regenerate would rewrite a generated invoice.
    await withRollback(async (client) => {
      const { contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-06-30",
        monthlyAmount: 1000,
      });
      await client.query(
        `insert into public.concessions
           (contract_id, type, status, start_date, end_date, discount_percent)
         values ($1, 'percentage_discount', 'active', '2026-01-01', '2026-06-30', 10)`,
        [contractId],
      );
      await client.query(
        `insert into public.concessions
           (contract_id, type, status, start_date, end_date, discount_amount)
         values ($1, 'fixed_discount', 'active', '2026-01-01', '2026-06-30', 50)`,
        [contractId],
      );
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);

      const generated = (await invoicesOf(client, contractId))[0];
      const { rows } = await client.query<{ total: string }>(
        `select total::text from public.contract_period_amounts($1, $2::date)`,
        [contractId, "2026-01-01"],
      );
      expect(rows[0].total).toBe(generated.total);
      expect(generated.total).toBe("1000.000");
    });
  });

  test("regeneration does not apply date-range percentage discounts", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-06-30",
        monthlyAmount: 1000,
      });
      await client.query(
        `insert into public.concessions
           (contract_id, type, status, start_date, end_date, discount_percent)
         values ($1, 'percentage_discount', 'active', '2026-01-01', '2026-06-30', 25)`,
        [contractId],
      );
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);

      await client.query(
        `update public.contract_units set monthly_amount = 2000 where contract_id = $1`,
        [contractId],
      );
      await regenerate(client, contractId);

      const after = await invoicesOf(client, contractId);
      expect(after[0].total).toBe("2000.000");
    });
  });

  test("a period newly covered by free months is removed", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedPastContract(client);
      const before = await invoicesOf(client, contractId);
      expect(before.some((i) => i.period_month === 2)).toBe(true);

      await client.query(
        `insert into public.concessions
           (contract_id, type, status, start_date, end_date)
         values ($1, 'free_months', 'active', '2026-02-01', '2026-02-28')`,
        [contractId],
      );
      await regenerate(client, contractId);

      const after = await invoicesOf(client, contractId);
      expect(after.some((i) => i.period_month === 2)).toBe(false);
    });
  });
});

describe("missing periods", () => {
  test("extending the contract inserts the newly covered months", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-02-28",
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);
      expect(await invoicesOf(client, contractId)).toHaveLength(2);

      await client.query(`update public.contracts set end_date = '2026-05-31' where id = $1`, [
        contractId,
      ]);
      const result = await regenerate(client, contractId);

      expect(result.filter((r) => r.action === "inserted").length).toBeGreaterThan(0);
      expect((await invoicesOf(client, contractId)).length).toBe(5);
    });
  });

  test("a cancelled invoice is not resurrected", async () => {
    // Bringing a cancelled financial record back is a human decision.
    await withRollback(async (client) => {
      const { contractId } = await seedPastContract(client);
      const target = (await invoicesOf(client, contractId))[0];
      await client.query(`update public.invoices set state = 'cancelled' where id = $1`, [
        target.id,
      ]);

      await regenerate(client, contractId);

      const { rows } = await client.query<{ state: string; count: string }>(
        `select state::text, count(*)::text as count from public.invoices
          where contract_id = $1 and id = $2 group by state`,
        [contractId, target.id],
      );
      expect(rows[0].state).toBe("cancelled");
      expect(rows[0].count).toBe("1");
    });
  });
});

describe("the premise this migration rests on", () => {
  test("requested_invoice_ids has no foreign key, so a delete really does orphan it", async () => {
    // The premise of this whole migration. If a FK were ever added,
    // delete-and-recreate would become safe and the UPSERT-diff could be
    // simplified — so assert the premise rather than trusting a comment.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `select count(*)::text as count
           from information_schema.table_constraints tc
          where tc.table_name = 'payment_requests'
            and tc.constraint_type = 'FOREIGN KEY'
            and tc.constraint_name ilike '%requested_invoice%'`,
      );
      expect(rows[0].count).toBe("0");
    });
  });
});

/**
 * Migration 97 — reapply matches regenerate on future months:
 * preserve in-term future unpaid invoices; never create them.
 */
async function reapply(client: PoolClient, contractId: string) {
  await client.query(`select * from public.reapply_contract_invoices($1)`, [contractId]);
}

async function futurePeriodKeys(client: PoolClient, contractId: string) {
  const { rows } = await client.query<{ period_year: number; period_month: number }>(
    `select period_year, period_month from public.invoices
      where contract_id = $1
        and make_date(period_year, period_month, 1)
              > date_trunc('month', current_date)::date
      order by period_year, period_month`,
    [contractId],
  );
  return rows.map((r) => `${r.period_year}-${r.period_month}`);
}

describe("reapply aligns with regenerate on future months (migration 97)", () => {
  test("an in-term future unpaid invoice survives reapply with the same id and total", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedContract(client, {
        startDate: "2020-01-01",
        endDate: "2035-12-31",
        monthlyAmount: 400,
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);

      const futureYear = new Date().getFullYear() + 1;
      await client.query(`select * from public.generate_invoices_for_year($1, $2, false)`, [
        contractId,
        futureYear,
      ]);

      const { rows: before } = await client.query<{
        id: string;
        total: string;
        period_month: number;
      }>(
        `select id, total::text as total, period_month from public.invoices
          where contract_id = $1 and period_year = $2
          order by period_month limit 1`,
        [contractId, futureYear],
      );
      expect(before).toHaveLength(1);
      const target = before[0];

      await reapply(client, contractId);

      const { rows: after } = await client.query<{ id: string; total: string }>(
        `select id, total::text as total from public.invoices where id = $1`,
        [target.id],
      );
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(target.id);
      expect(after[0].total).toBe(target.total);
    });
  });

  test("reapply creates no invoice for a future month that did not already have one", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedContract(client, {
        startDate: "2020-01-01",
        endDate: "2035-12-31",
        monthlyAmount: 400,
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);

      // One future year only — later years of the contract stay empty.
      const futureYear = new Date().getFullYear() + 1;
      await client.query(`select * from public.generate_invoices_for_year($1, $2, false)`, [
        contractId,
        futureYear,
      ]);

      const beforeCount = (await futurePeriodKeys(client, contractId)).length;
      expect(beforeCount).toBeGreaterThan(0);

      await reapply(client, contractId);

      const afterKeys = await futurePeriodKeys(client, contractId);
      expect(afterKeys.length).toBe(beforeCount);
      // A later year that was never generated must still be empty.
      const laterYear = futureYear + 1;
      const { rows: later } = await client.query(
        `select 1 from public.invoices
          where contract_id = $1 and period_year = $2`,
        [contractId, laterYear],
      );
      expect(later).toHaveLength(0);
    });
  });

  test("reapply still deletes an unpaid past due row outside the contract term", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2026-03-01",
        endDate: "2026-06-30",
        monthlyAmount: 500,
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [fx.contractId]);

      // Period before contract start — out of term, past relative to any wall clock
      // after March 2026. reapply must still wipe unpaid due/overdue past rows.
      const { rows: inserted } = await client.query<{ id: string }>(
        `insert into public.invoices (
           code, company_id, contract_id, tenant_id, unit_id,
           period_year, period_month, issue_date, due_date,
           subtotal, discount, total, paid, state, is_visible_to_tenant,
           idempotency_key
         ) values (
           'INV-out-' || substr($1::text, 1, 8),
           $2::uuid, $1::uuid, $3::uuid, $4::uuid,
           2026, 1, '2026-01-01', '2026-01-01',
           500, 0, 500, 0, 'due', true,
           $1::text || ':2026:1'
         ) returning id`,
        [fx.contractId, fx.companyId, fx.tenantId, fx.unitId],
      );
      expect(inserted).toHaveLength(1);

      await reapply(client, fx.contractId);

      const { rows } = await client.query(`select 1 from public.invoices where id = $1`, [
        inserted[0].id,
      ]);
      expect(rows).toHaveLength(0);
    });
  });

  test("reapply still raises on an archived contract (guard before delete)", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-06-30",
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);
      const before = await invoicesOf(client, contractId);
      expect(before.length).toBeGreaterThan(0);

      await client.query(`update public.contracts set archived_at = now() where id = $1`, [
        contractId,
      ]);

      const message = await captureRaise(client, () =>
        client.query(`select * from public.reapply_contract_invoices($1)`, [contractId]),
      );
      expect(message).toMatch(/archived/i);

      const after = await invoicesOf(client, contractId);
      expect(after.map((i) => i.id).sort()).toEqual(before.map((i) => i.id).sort());
    });
  });

  test("regenerate and reapply produce the same set of future periods", async () => {
    await withRollback(async (client) => {
      // Two identical contracts: one path regenerate, one reapply.
      const common = {
        startDate: "2020-01-01",
        endDate: "2035-12-31",
        monthlyAmount: 420,
      } as const;
      const a = await seedContract(client, common);
      const b = await seedContract(client, { ...common, companyId: a.companyId });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [a.contractId]);
      await client.query(`select * from public.backfill_contract_invoices($1)`, [b.contractId]);

      const futureYear = new Date().getFullYear() + 1;
      await client.query(`select * from public.generate_invoices_for_year($1, $2, false)`, [
        a.contractId,
        futureYear,
      ]);
      await client.query(`select * from public.generate_invoices_for_year($1, $2, false)`, [
        b.contractId,
        futureYear,
      ]);

      await regenerate(client, a.contractId);
      await reapply(client, b.contractId);

      expect(await futurePeriodKeys(client, a.contractId)).toEqual(
        await futurePeriodKeys(client, b.contractId),
      );
    });
  });
});

describe("evaluate_portal_payable_invoices shows every unpaid (migration 97)", () => {
  test("returns more than 6 unpaid invoices and only the first is selectable", async () => {
    await withRollback(async (client) => {
      // Eight past months so wall-clock current_date is always after the span.
      const fx = await seedContract(client, {
        startDate: "2025-01-01",
        endDate: "2025-08-31",
        monthlyAmount: 300,
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [fx.contractId]);

      const { rows: invoices } = await client.query<{ id: string }>(
        `select id from public.invoices
          where contract_id = $1 order by period_year, period_month`,
        [fx.contractId],
      );
      expect(invoices.length).toBeGreaterThan(6);

      const { rows: payable } = await client.query<{
        invoice_id: string;
        is_selectable: boolean;
        sequence_order: number;
      }>(
        `select invoice_id, is_selectable, sequence_order
            from public.evaluate_portal_payable_invoices($1)
           order by sequence_order`,
        [fx.tenantId],
      );

      expect(payable.length).toBe(invoices.length);
      expect(payable.length).toBeGreaterThan(6);
      expect(payable[0].is_selectable).toBe(true);
      for (const row of payable.slice(1)) {
        expect(row.is_selectable).toBe(false);
      }
    });
  });
});
