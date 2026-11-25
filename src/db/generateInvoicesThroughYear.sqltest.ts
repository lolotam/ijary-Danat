import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { captureRaise, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 120 — `generate_invoices(p_contract_id, p_through_year)` must
 * generate *through* the year it is handed, not only that one year.
 *
 * The production failure this pins (2026-08-09, contract CON-00003): a
 * 12-month contract was extended to 17 months, 2026-08-01 → 2027-12-31,
 * crossing into the next calendar year. The audit trail read
 * `invoice.generate {"input": {"throughYear": 2026}, "generated": 0}` with no
 * error, and all twelve periods of 2027 stayed missing. The admin Generate button
 * passes the year the invoices page is showing (the current year by default),
 * and the old body forwarded that single year straight to
 * `generate_invoices_for_year`. Every period of the current year already
 * existed, `on conflict ... do nothing` swallowed the inserts, and the admin
 * saw "0 generated" with no error while the next year stayed empty.
 *
 * Wall-clock matters here — the function's whole subject is "current year vs
 * later years" — so every fixture is anchored to `current_date` rather than to
 * literal dates, and the assertions are built from the same anchor.
 */

/** أول يوم في الشهر الحالي بتوقيت قاعدة البيانات، مصدر التثبيت لكل التواريخ. */
async function today(client: PoolClient) {
  const { rows } = await client.query<{ year: number; month: number }>(
    `select extract(year from current_date)::int as year,
            extract(month from current_date)::int as month`,
  );
  return rows[0];
}

/** مفاتيح (سنة، شهر) لكل فاتورة على العقد، مرتبة زمنيًا. */
async function periodKeys(client: PoolClient, contractId: string) {
  const { rows } = await client.query<{ period_year: number; period_month: number }>(
    `select period_year, period_month from public.invoices
      where contract_id = $1 order by period_year, period_month`,
    [contractId],
  );
  return rows.map((row) => `${row.period_year}-${String(row.period_month).padStart(2, "0")}`);
}

/** كل شهر من (سنة، شهر) البداية حتى ديسمبر من سنة النهاية. */
function monthsThroughDecember(fromYear: number, fromMonth: number, toYear: number) {
  const keys: string[] = [];
  for (let year = fromYear; year <= toYear; year += 1) {
    for (let month = year === fromYear ? fromMonth : 1; month <= 12; month += 1) {
      keys.push(`${year}-${String(month).padStart(2, "0")}`);
    }
  }
  return keys;
}

async function generate(client: PoolClient, contractId: string, throughYear: number | null) {
  const { rows } = await client.query<{ period_year: number; period_month: number }>(
    `select period_year, period_month from public.generate_invoices($1, $2)`,
    [contractId, throughYear],
  );
  return rows;
}

/**
 * عقد يبدأ هذا الشهر وينتهي في ديسمبر من السنة القادمة — نفس شكل العقد الذي
 * أظهر الخلل في الإنتاج (١٧ شهرًا تعبر حدّ السنة).
 */
async function seedCrossYearContract(client: PoolClient) {
  const { year, month } = await today(client);
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const fixture = await seedContract(client, {
    startDate: start,
    endDate: `${year + 1}-12-31`,
    monthlyAmount: 500,
  });
  return { ...fixture, year, month };
}

describe("generate_invoices generates through the target year (migration 120)", () => {
  test("a target year beyond the current one fills every month in between", async () => {
    await withRollback(async (client) => {
      const { contractId, year, month } = await seedCrossYearContract(client);

      await generate(client, contractId, year + 1);

      // The regression: the old body produced next year's twelve months only,
      // leaving the rest of THIS year — the months between the contract start
      // and 31 December — permanently unreachable from the admin button.
      expect(await periodKeys(client, contractId)).toEqual(
        monthsThroughDecember(year, month, year + 1),
      );
    });
  });

  test("a target of the current year still stops at 31 December", async () => {
    await withRollback(async (client) => {
      const { contractId, year, month } = await seedCrossYearContract(client);

      await generate(client, contractId, year);

      // Widening the request is the admin's call, never the function's: asking
      // for this year must not quietly bill next year too.
      expect(await periodKeys(client, contractId)).toEqual(
        monthsThroughDecember(year, month, year),
      );
    });
  });

  test("re-running with the same target adds nothing", async () => {
    await withRollback(async (client) => {
      const { contractId, year } = await seedCrossYearContract(client);

      const first = await generate(client, contractId, year + 1);
      const second = await generate(client, contractId, year + 1);

      expect(first.length).toBeGreaterThan(0);
      expect(second).toHaveLength(0);
    });
  });

  test("a target past every contract's end date still generates that contract's own schedule", async () => {
    await withRollback(async (client) => {
      const { contractId, year, month } = await seedCrossYearContract(client);

      // Over-asking must be safe, not empty: the old body forwarded 2200 to
      // generate_invoices_for_year, whose loop predicate needs
      // `end_date >= make_date(2200, 1, 1)`, so it returned nothing at all.
      //
      // This does NOT prove the horizon clamp — the clamp changes how many
      // years the loop walks, not which rows come out, so the assertion below
      // is identical with and without it. The clamp is a cost guard against
      // walking to the schema's 2200 ceiling; nothing observable from SQL
      // distinguishes it, and a timing assertion would be flaky.
      const rows = await generate(client, contractId, 2200);

      expect(rows).toHaveLength(monthsThroughDecember(year, month, year + 1).length);
      expect(await periodKeys(client, contractId)).toEqual(
        monthsThroughDecember(year, month, year + 1),
      );
    });
  });

  test("a target year outside the supported range raises", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedCrossYearContract(client);

      const message = await captureRaise(client, () => generate(client, contractId, 2201));

      expect(message).toMatch(/supported range/i);
    });
  });

  test("an archived contract does not extend the horizon of a portfolio-wide run", async () => {
    await withRollback(async (client) => {
      const { contractId, year } = await seedCrossYearContract(client);
      await client.query(`update public.contracts set archived_at = now() where id = $1`, [
        contractId,
      ]);

      // Migration 82 makes an archived contract billable by no path. It must
      // not stretch the year loop either — the direct-id call raises rather
      // than silently returning an empty set.
      const message = await captureRaise(client, () => generate(client, contractId, year + 1));

      expect(message).toMatch(/archived/i);
    });
  });
});
