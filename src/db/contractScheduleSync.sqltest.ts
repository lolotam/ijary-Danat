import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { captureRaise, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 139 — `sync_contract_invoice_schedule`.
 *
 * The bug these tests exist for: a 3-year contract with all 36 invoices
 * generated, then edited to add 3 free months, lost exactly ONE invoice.
 * `reapply_contract_invoices` deletes only periods `<= date_trunc('month',
 * current_date)`, so on a contract starting this month that window holds a
 * single month.
 *
 * Every fixture here is anchored to the wall clock rather than to fixed dates,
 * because the whole defect is about the boundary between "this month" and
 * "later this year" — a hard-coded 2026-08-01 would stop exercising it the
 * moment the suite ran in a different month.
 */

/**
 * The database's own current month, not the Node process's.
 *
 * Every assertion here compares a fixture built in JavaScript against a
 * schedule computed from `current_date` inside Postgres. Those two calendars
 * are not the same clock: the pool sets no timezone, so on the night of a month
 * boundary the fixture can be building August while SQL is already in
 * September. Anchoring to the database removes the disagreement entirely rather
 * than pinning a timezone the container might not honour.
 */
let FIRST_OF_THIS_MONTH = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

beforeAll(async () => {
  await withRollback(async (client) => {
    const { rows } = await client.query<{ month_start: string }>(
      `select to_char(date_trunc('month', current_date), 'YYYY-MM-DD') as month_start`,
    );
    const [year, month] = rows[0].month_start.split("-").map(Number);
    FIRST_OF_THIS_MONTH = new Date(year, month - 1, 1);
  });
});

/** `yyyy-mm-dd` in local time; `toISOString` would shift the day across UTC. */
function iso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** First day of the month `offset` months after this one. */
function monthStart(offset: number): Date {
  return new Date(FIRST_OF_THIS_MONTH.getFullYear(), FIRST_OF_THIS_MONTH.getMonth() + offset, 1);
}

/** `"2026-8"` — the shape the period assertions compare on. */
function periodKey(offset: number): string {
  const date = monthStart(offset);
  return `${date.getFullYear()}-${date.getMonth() + 1}`;
}

/**
 * A 36-month contract starting this month, with every one of its 36 invoices
 * already generated — the state the reported contract was in.
 */
async function seedThreeYearContract(client: PoolClient, monthlyAmount = 500) {
  const start = monthStart(0);
  const end = new Date(FIRST_OF_THIS_MONTH.getFullYear(), FIRST_OF_THIS_MONTH.getMonth() + 36, 0);
  const fixture = await seedContract(client, {
    startDate: iso(start),
    endDate: iso(end),
    monthlyAmount,
  });
  // The admin "Generate" button, asking for the contract's final year.
  await client.query(`select * from public.generate_invoices($1, $2)`, [
    fixture.contractId,
    end.getFullYear(),
  ]);
  return fixture;
}

async function periodKeysOf(client: PoolClient, contractId: string): Promise<string[]> {
  const { rows } = await client.query<{ period_year: number; period_month: number }>(
    `select period_year, period_month from public.invoices
      where contract_id = $1 and state <> 'cancelled'
      order by period_year, period_month`,
    [contractId],
  );
  return rows.map((row) => `${row.period_year}-${row.period_month}`);
}

async function sync(client: PoolClient, contractId: string) {
  const { rows } = await client.query<{
    id: string;
    period_year: number;
    period_month: number;
    total: string;
    action: string;
  }>(
    `select id, period_year, period_month, total, action
       from public.sync_contract_invoice_schedule($1)`,
    [contractId],
  );
  return rows;
}

/** Adds a free-months concession the way ConcessionsDialog does. */
async function addFreeMonths(client: PoolClient, contractId: string, months: number) {
  const start = monthStart(0);
  const endOfLastFreeMonth = new Date(
    FIRST_OF_THIS_MONTH.getFullYear(),
    FIRST_OF_THIS_MONTH.getMonth() + months,
    0,
  );
  await client.query(
    `insert into public.concessions
       (contract_id, type, status, start_date, end_date, free_months)
     values ($1, 'free_months', 'active', $2::date, $3::date, $4)`,
    [contractId, iso(start), iso(endOfLastFreeMonth), months],
  );
}

async function clearFreeMonths(client: PoolClient, contractId: string) {
  await client.query(
    `delete from public.concessions where contract_id = $1 and type = 'free_months'`,
    [contractId],
  );
}

/** Rewrites the free-month count the way delete-then-add in the dialog does. */
async function setFreeMonths(client: PoolClient, contractId: string, months: number) {
  await clearFreeMonths(client, contractId);
  if (months > 0) await addFreeMonths(client, contractId, months);
  await sync(client, contractId);
}

describe("adding free months removes every freed month, not just the current one", () => {
  test("3 free months on a 36-month contract removes all three", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedThreeYearContract(client);
      expect(await periodKeysOf(client, contractId)).toHaveLength(36);

      await addFreeMonths(client, contractId, 3);
      await sync(client, contractId);

      const after = await periodKeysOf(client, contractId);
      expect(after).toHaveLength(33);
      // The reported symptom was that only the first of these disappeared.
      expect(after).not.toContain(periodKey(0));
      expect(after).not.toContain(periodKey(1));
      expect(after).not.toContain(periodKey(2));
      // Billing starts at the fourth month and the rest is untouched.
      expect(after[0]).toBe(periodKey(3));
      expect(after[after.length - 1]).toBe(periodKey(35));
    });
  });

  test("1 free month removes exactly one", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedThreeYearContract(client);
      await addFreeMonths(client, contractId, 1);
      await sync(client, contractId);

      const after = await periodKeysOf(client, contractId);
      expect(after).toHaveLength(35);
      expect(after[0]).toBe(periodKey(1));
    });
  });
});

describe("reducing free months restores the months that are billable again", () => {
  test("3 to 1 brings back the second and third months", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedThreeYearContract(client);
      await setFreeMonths(client, contractId, 3);
      expect(await periodKeysOf(client, contractId)).toHaveLength(33);

      await setFreeMonths(client, contractId, 1);

      const after = await periodKeysOf(client, contractId);
      expect(after).toHaveLength(35);
      expect(after).not.toContain(periodKey(0));
      expect(after).toContain(periodKey(1));
      expect(after).toContain(periodKey(2));
    });
  });

  test("3 to 0 brings back all three", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedThreeYearContract(client);
      await setFreeMonths(client, contractId, 3);
      await setFreeMonths(client, contractId, 0);

      expect(await periodKeysOf(client, contractId)).toHaveLength(36);
    });
  });

  test("a restored month is billed at the contract's current rent", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedThreeYearContract(client, 500);
      await setFreeMonths(client, contractId, 3);
      await setFreeMonths(client, contractId, 0);

      const { rows } = await client.query<{ total: string; subtotal: string }>(
        `select total::text, subtotal::text from public.invoices
          where contract_id = $1 and period_year = $2 and period_month = $3`,
        [contractId, monthStart(1).getFullYear(), monthStart(1).getMonth() + 1],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].total).toBe("500.000");
      expect(rows[0].subtotal).toBe("500.000");
    });
  });

  test("every step of 0-1-2-3-2-1-0 lands on the right period set", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedThreeYearContract(client);
      for (const months of [1, 2, 3, 2, 1, 0]) {
        await setFreeMonths(client, contractId, months);
        expect(await periodKeysOf(client, contractId)).toHaveLength(36 - months);
      }
    });
  });
});

describe("the sync is idempotent", () => {
  test("running it twice changes nothing and creates no duplicate", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedThreeYearContract(client);
      await addFreeMonths(client, contractId, 3);
      await sync(client, contractId);
      const first = await periodKeysOf(client, contractId);

      const second = await sync(client, contractId);

      expect(await periodKeysOf(client, contractId)).toEqual(first);
      expect(second.filter((row) => row.action === "inserted")).toHaveLength(0);
      expect(second.filter((row) => row.action === "deleted")).toHaveLength(0);
    });
  });

  test("the unique period constraint is what makes a duplicate impossible", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedThreeYearContract(client);
      await sync(client, contractId);
      await sync(client, contractId);

      const { rows } = await client.query<{ count: string }>(
        `select count(*)::text as count from (
           select period_year, period_month from public.invoices
            where contract_id = $1
            group by period_year, period_month having count(*) > 1
         ) duplicated`,
        [contractId],
      );
      expect(rows[0].count).toBe("0");
    });
  });
});

describe("money is never destroyed by a free-month change", () => {
  test("a paid invoice inside a newly-free window survives untouched", async () => {
    await withRollback(async (client) => {
      const fx = await seedThreeYearContract(client, 500);
      const { rows: target } = await client.query<{ id: string }>(
        `select id from public.invoices
          where contract_id = $1 order by period_year, period_month limit 1`,
        [fx.contractId],
      );
      await client.query(`update public.invoices set paid = 500, state = 'paid' where id = $1`, [
        target[0].id,
      ]);

      await addFreeMonths(client, fx.contractId, 3);
      const result = await sync(client, fx.contractId);

      const { rows: after } = await client.query<{ state: string; paid: string }>(
        `select state::text, paid::text from public.invoices where id = $1`,
        [target[0].id],
      );
      expect(after).toHaveLength(1);
      expect(after[0].state).toBe("paid");
      expect(result.find((row) => row.id === target[0].id)?.action).toBe("skipped");
    });
  });

  test("an invoice with a live payment request is cancelled, not deleted", async () => {
    // Deleting it would orphan the KNET link already sent to the tenant:
    // payment_requests.requested_invoice_ids is a uuid[] with no foreign key.
    await withRollback(async (client) => {
      const fx = await seedThreeYearContract(client, 500);
      const { rows: target } = await client.query<{ id: string }>(
        `select id from public.invoices
          where contract_id = $1 order by period_year, period_month limit 1`,
        [fx.contractId],
      );
      await client.query(
        `insert into public.payment_requests
           (tenant_id, amount, requested_invoice_ids, status)
         values ($1, 500, array[$2::uuid], 'pending')`,
        [fx.tenantId, target[0].id],
      );

      await addFreeMonths(client, fx.contractId, 3);
      await sync(client, fx.contractId);

      const { rows: after } = await client.query<{ state: string }>(
        `select state::text from public.invoices where id = $1`,
        [target[0].id],
      );
      expect(after).toHaveLength(1);
      expect(after[0].state).toBe("cancelled");
    });
  });

  test("a discounted invoice inside a newly-free month is reported as a conflict", async () => {
    await withRollback(async (client) => {
      const fx = await seedThreeYearContract(client, 500);
      const { rows: target } = await client.query<{ id: string }>(
        `select id from public.invoices
          where contract_id = $1 order by period_year, period_month limit 1`,
        [fx.contractId],
      );
      const { rows: concession } = await client.query<{ id: string }>(
        `insert into public.concessions
           (contract_id, type, status, start_date, end_date, discount_percent)
         values ($1, 'percentage_discount', 'active', current_date, current_date, 10)
         returning id`,
        [fx.contractId],
      );
      await client.query(`select * from public.apply_concession_to_invoices($1, $2::uuid[])`, [
        concession[0].id,
        [target[0].id],
      ]);

      await addFreeMonths(client, fx.contractId, 3);
      const result = await sync(client, fx.contractId);

      const { rows: after } = await client.query<{ discount: string; total: string }>(
        `select discount::text, total::text from public.invoices where id = $1`,
        [target[0].id],
      );
      // The discount is never silently destroyed…
      expect(after).toHaveLength(1);
      expect(after[0].discount).toBe("50.000");
      // …but a discounted, still-chargeable invoice sitting inside a month the
      // tenant was told is free is a contradiction only a human can settle, so
      // it is surfaced rather than quietly left standing.
      expect(result.find((row) => row.id === target[0].id)?.action).toBe("blocked");
    });
  });

  test("a discounted invoice on a month that stays billable is simply skipped", async () => {
    await withRollback(async (client) => {
      const fx = await seedThreeYearContract(client, 500);
      const { rows: target } = await client.query<{ id: string }>(
        `select id from public.invoices
          where contract_id = $1 order by period_year, period_month limit 1`,
        [fx.contractId],
      );
      const { rows: concession } = await client.query<{ id: string }>(
        `insert into public.concessions
           (contract_id, type, status, start_date, end_date, discount_percent)
         values ($1, 'percentage_discount', 'active', current_date, current_date, 10)
         returning id`,
        [fx.contractId],
      );
      await client.query(`select * from public.apply_concession_to_invoices($1, $2::uuid[])`, [
        concession[0].id,
        [target[0].id],
      ]);

      const result = await sync(client, fx.contractId);

      expect(result.find((row) => row.id === target[0].id)?.action).toBe("skipped");
    });
  });

  test("a cancelled invoice is not resurrected by the fill pass", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedThreeYearContract(client);
      const { rows: target } = await client.query<{ id: string }>(
        `select id from public.invoices
          where contract_id = $1 order by period_year, period_month limit 1`,
        [contractId],
      );
      await client.query(`update public.invoices set state = 'cancelled' where id = $1`, [
        target[0].id,
      ]);

      const result = await sync(client, contractId);

      const { rows } = await client.query<{ count: string }>(
        `select count(*)::text as count from public.invoices
          where contract_id = $1 and period_year = $2 and period_month = $3`,
        [contractId, monthStart(0).getFullYear(), monthStart(0).getMonth() + 1],
      );
      expect(rows[0].count).toBe("1");
      // Not resurrected — but the month IS billable and now has no live
      // invoice, so the caller is told rather than being handed a clean result
      // for a schedule that does not match the contract.
      const reported = result.filter((row) => row.id === target[0].id);
      // Exactly one row, or a caller reading the first would conclude all was
      // well: the prune and fill passes both see this invoice.
      expect(reported).toHaveLength(1);
      expect(reported[0].action).toBe("blocked");
    });
  });

  test("a cancelled invoice on a month that is now free is simply skipped", async () => {
    // Its month is finished with, so there is nothing for a human to resolve.
    await withRollback(async (client) => {
      const { contractId } = await seedThreeYearContract(client);
      const { rows: target } = await client.query<{ id: string }>(
        `select id from public.invoices
          where contract_id = $1 order by period_year, period_month limit 1`,
        [contractId],
      );
      await client.query(`update public.invoices set state = 'cancelled' where id = $1`, [
        target[0].id,
      ]);
      await addFreeMonths(client, contractId, 1);

      const result = await sync(client, contractId);

      const reported = result.filter((row) => row.id === target[0].id);
      expect(reported).toHaveLength(1);
      expect(reported[0].action).toBe("skipped");
    });
  });
});

describe("the horizon bounds the fill pass", () => {
  test("a contract generated only to this month gains no future invoice", async () => {
    // The rule migrations 94/97 established: future invoices exist only because
    // an admin explicitly asked for them.
    await withRollback(async (client) => {
      const start = monthStart(0);
      const end = new Date(
        FIRST_OF_THIS_MONTH.getFullYear(),
        FIRST_OF_THIS_MONTH.getMonth() + 36,
        0,
      );
      const { contractId } = await seedContract(client, {
        startDate: iso(start),
        endDate: iso(end),
        monthlyAmount: 500,
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);
      const before = await periodKeysOf(client, contractId);
      expect(before).toEqual([periodKey(0)]);

      await sync(client, contractId);

      expect(await periodKeysOf(client, contractId)).toEqual(before);
    });
  });

  test("the recorded horizon does not fall when its months are freed", async () => {
    // The reason it is a column and not a max() over the invoices: a sync that
    // deletes the furthest rows would otherwise destroy the evidence of how far
    // the schedule reached, and reducing free months could never restore them.
    await withRollback(async (client) => {
      const { contractId } = await seedThreeYearContract(client);
      const { rows: before } = await client.query<{ horizon: string }>(
        `select invoices_generated_through::text as horizon from public.contracts where id = $1`,
        [contractId],
      );
      expect(before[0].horizon).toBe(iso(monthStart(35)));

      await setFreeMonths(client, contractId, 3);

      const { rows: after } = await client.query<{ horizon: string }>(
        `select invoices_generated_through::text as horizon from public.contracts where id = $1`,
        [contractId],
      );
      expect(after[0].horizon).toBe(before[0].horizon);
    });
  });

  test("generating a range whose every month is free still records the horizon", async () => {
    // The horizon has to record the range the generator was ASKED to cover,
    // not the range it inserted rows for. Derived from surviving invoices
    // alone it would never move here — and reducing the free months afterwards
    // could not restore months the operator had already generated through.
    await withRollback(async (client) => {
      const start = monthStart(0);
      const end = new Date(
        FIRST_OF_THIS_MONTH.getFullYear(),
        FIRST_OF_THIS_MONTH.getMonth() + 36,
        0,
      );
      const { contractId } = await seedContract(client, {
        startDate: iso(start),
        endDate: iso(end),
        monthlyAmount: 500,
      });
      await addFreeMonths(client, contractId, 36);

      await client.query(`select * from public.generate_invoices($1, $2)`, [
        contractId,
        end.getFullYear(),
      ]);
      expect(await periodKeysOf(client, contractId)).toHaveLength(0);

      const { rows } = await client.query<{ horizon: string | null }>(
        `select invoices_generated_through::text as horizon from public.contracts where id = $1`,
        [contractId],
      );
      expect(rows[0].horizon).toBe(iso(monthStart(35)));

      // …and that recorded horizon is what lets every month come back.
      await setFreeMonths(client, contractId, 0);
      expect(await periodKeysOf(client, contractId)).toHaveLength(36);
    });
  });

  test("the fill pass stops at the contract's end date", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedThreeYearContract(client);
      await client.query(
        `update public.contracts set invoices_generated_through = $2::date where id = $1`,
        [contractId, iso(monthStart(60))],
      );

      await sync(client, contractId);

      const after = await periodKeysOf(client, contractId);
      expect(after).toHaveLength(36);
      expect(after[after.length - 1]).toBe(periodKey(35));
    });
  });
});

describe("free months are counted in whole calendar months", () => {
  test("a contract starting mid-month frees exactly the requested count", async () => {
    // start + N months - 1 day, compared on date_trunc('month'), used to make
    // 3 requested free months cover 4 calendar months.
    await withRollback(async (client) => {
      const start = new Date(FIRST_OF_THIS_MONTH.getFullYear(), FIRST_OF_THIS_MONTH.getMonth(), 15);
      const end = new Date(
        FIRST_OF_THIS_MONTH.getFullYear(),
        FIRST_OF_THIS_MONTH.getMonth() + 12,
        14,
      );
      const { contractId } = await seedContract(client, {
        startDate: iso(start),
        endDate: iso(end),
        monthlyAmount: 500,
      });
      await client.query(`select * from public.generate_invoices($1, $2)`, [
        contractId,
        end.getFullYear(),
      ]);
      const before = await periodKeysOf(client, contractId);

      // The legacy range a mid-month contract used to store: start + 3 months
      // - 1 day, which lands inside the FOURTH calendar month.
      const legacyEnd = new Date(
        FIRST_OF_THIS_MONTH.getFullYear(),
        FIRST_OF_THIS_MONTH.getMonth() + 3,
        14,
      );
      await client.query(
        `insert into public.concessions
           (contract_id, type, status, start_date, end_date, free_months)
         values ($1, 'free_months', 'active', $2::date, $3::date, 3)`,
        [contractId, iso(start), iso(legacyEnd)],
      );
      await sync(client, contractId);

      const after = await periodKeysOf(client, contractId);
      expect(before.length - after.length).toBe(3);
      expect(after).toContain(periodKey(3));
    });
  });

  test("a legacy concession with no recorded count still uses its date range", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedThreeYearContract(client);
      const monthAfterNext = new Date(
        FIRST_OF_THIS_MONTH.getFullYear(),
        FIRST_OF_THIS_MONTH.getMonth() + 2,
        0,
      );
      // free_months defaults to 0 — the shape every pre-139 row has.
      await client.query(
        `insert into public.concessions
           (contract_id, type, status, start_date, end_date)
         values ($1, 'free_months', 'active', $2::date, $3::date)`,
        [contractId, iso(monthStart(0)), iso(monthAfterNext)],
      );
      await sync(client, contractId);

      const after = await periodKeysOf(client, contractId);
      expect(after).not.toContain(periodKey(0));
      expect(after).not.toContain(periodKey(1));
      expect(after).toContain(periodKey(2));
    });
  });
});

describe("guards", () => {
  test("an archived contract raises before anything is mutated", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedThreeYearContract(client);
      const before = await periodKeysOf(client, contractId);
      await client.query(`update public.contracts set archived_at = now() where id = $1`, [
        contractId,
      ]);

      const message = await captureRaise(client, () =>
        client.query(`select * from public.sync_contract_invoice_schedule($1)`, [contractId]),
      );
      expect(message).toMatch(/archived/i);
      expect(await periodKeysOf(client, contractId)).toEqual(before);
    });
  });

  test("a contract with no units raises rather than billing zero", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedThreeYearContract(client);
      await client.query(`delete from public.contract_units where contract_id = $1`, [contractId]);

      const message = await captureRaise(client, () =>
        client.query(`select * from public.sync_contract_invoice_schedule($1)`, [contractId]),
      );
      expect(message).toMatch(/no units/i);
    });
  });

  test("an unknown contract raises", async () => {
    await withRollback(async (client) => {
      const message = await captureRaise(client, () =>
        client.query(`select * from public.sync_contract_invoice_schedule($1)`, [
          "00000000-0000-0000-0000-000000000000",
        ]),
      );
      expect(message).toMatch(/not found/i);
    });
  });
});
