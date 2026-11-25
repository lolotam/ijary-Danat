import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import {
  addExtraCharge,
  expectItemsToSumToSubtotal,
  generateYear,
  invoiceForMonth,
  itemsOf,
  makeJanuaryFree,
  seedYearContract,
  THIS_YEAR,
} from "@/db/extraChargeFixtures";
import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 170 — a free month generates nothing at all.
 *
 * Operator's revision of 2026-08-30, reversing migration 168: a free month
 * waives the rent AND the recurring service charges of migration 163. "The
 * total of these free months will be zero." Every free month is in scope,
 * wherever it falls in the term.
 *
 * 170 is a byte-for-byte restore of the four function bodies 164/165 shipped,
 * so these tests are really asserting that the restore is complete — a single
 * surviving 168 splice would leave one of the four paths still emitting an
 * extras-only invoice, and nothing would error.
 *
 * The invariant is NOT "a free month has no invoice". It is: no NEW invoice is
 * generated for a free period, and only a clean, fully-unpaid, undiscounted
 * invoice is removed when a period becomes free. The last two tests below are
 * about that distinction, which is where real money would be destroyed.
 */

describe("a free period generates nothing", () => {
  // One contract — 500 rent, a 50 cleaning charge, January free — read twice.
  // The billed month is not a formality: it catches the opposite error, a
  // revert that went too far and stopped billing extras entirely, which the
  // free month's own assertion cannot see.
  test("the free month gets no invoice while the billed month still gets its extras", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client, 500);
      await addExtraCharge(client, contractId, 50);
      await makeJanuaryFree(client, contractId);

      await generateYear(client, contractId);

      expect(await invoiceForMonth(client, contractId, 1)).toBeUndefined();

      const february = await invoiceForMonth(client, contractId, 2);
      expect(Number(february.subtotal)).toBe(550);
      await expectItemsToSumToSubtotal(client, february.id);
      expect(await itemsOf(client, february.id)).toHaveLength(2);
    });
  });

  test("a free month on a contract with no charges also gets nothing", async () => {
    // Unchanged by 168 and by 170. Here so that a future edit which makes the
    // free-month skip conditional on anything at all fails immediately.
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client, 500);
      await makeJanuaryFree(client, contractId);

      await generateYear(client, contractId);

      expect(await invoiceForMonth(client, contractId, 1)).toBeUndefined();
      expect(Number((await invoiceForMonth(client, contractId, 2)).subtotal)).toBe(500);
    });
  });

  test.each(["regenerate_contract_invoices", "sync_contract_invoice_schedule"] as const)(
    "%s removes a clean unpaid invoice whose month has become free",
    async (repairFn) => {
      // Both repair paths, because 165 carries them as separate copies of the
      // same rule and 168 had to edit each independently. Under 168 this
      // invoice was repriced down to its service charges and kept; under 170 it
      // goes, because the month should hold no invoice at all.
      await withRollback(async (client) => {
        const { contractId } = await seedYearContract(client, 500);
        await addExtraCharge(client, contractId, 50);
        await generateYear(client, contractId);
        expect(Number((await invoiceForMonth(client, contractId, 1)).subtotal)).toBe(550);

        await makeJanuaryFree(client, contractId);
        await client.query(`select * from public.${repairFn}($1)`, [contractId]);

        expect(await invoiceForMonth(client, contractId, 1)).toBeUndefined();
        // The rest of the year is untouched — a repair that removed the free
        // month by removing everything would pass the assertion above.
        expect(Number((await invoiceForMonth(client, contractId, 2)).subtotal)).toBe(550);
      });
    },
  );

  test("sync does not re-create the free month it just removed", async () => {
    // The fill half runs after the prune half in the same call. If only the
    // prune half honoured the free period, sync would delete the invoice and
    // immediately insert a new one — churning a fresh code every run while
    // looking correct in any single-value assertion.
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client, 500);
      await addExtraCharge(client, contractId, 50);
      await makeJanuaryFree(client, contractId);
      await generateYear(client, contractId);

      await client.query(`select * from public.sync_contract_invoice_schedule($1)`, [contractId]);
      await client.query(`select * from public.sync_contract_invoice_schedule($1)`, [contractId]);

      expect(await invoiceForMonth(client, contractId, 1)).toBeUndefined();
    });
  });

  test("contract_period_amounts prices rent plus extras again, free or not", async () => {
    // 168 taught the shared pricer to zero the rent inside a free period. 170
    // takes that back out, which is correct only because a free period no
    // longer has an invoice for it to price. Asserted directly so the revert is
    // visible at the pricer rather than inferred from the callers.
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client, 500);
      await addExtraCharge(client, contractId, 50);
      await makeJanuaryFree(client, contractId);

      const { rows } = await client.query<{ month: number; subtotal: string }>(
        `select 1 as month, subtotal from public.contract_period_amounts($1, $2::date)
         union all
         select 2, subtotal from public.contract_period_amounts($1, $3::date)
         order by month`,
        [contractId, `${THIS_YEAR}-01-01`, `${THIS_YEAR}-02-01`],
      );
      expect(rows.map((row) => Number(row.subtotal))).toEqual([550, 550]);
    });
  });
});

describe("money and human decisions survive a month becoming free", () => {
  /** يسجّل الفاتورة كمدفوعة بالكامل، كما يفعل مسار الدفع. */
  async function markPaid(client: PoolClient, invoiceId: string) {
    await client.query(`update public.invoices set paid = total, state = 'paid' where id = $1`, [
      invoiceId,
    ]);
  }

  test.each(["regenerate_contract_invoices", "sync_contract_invoice_schedule"] as const)(
    "%s leaves a PAID invoice standing when its month becomes free",
    async (repairFn) => {
      // The reason "a free month has no invoice" must never be written as the
      // invariant: the tenant paid this one. `contractScheduleSync.sqltest.ts`
      // pins the same protection without service charges; this is the version
      // that matters after 163, because the invoice being protected now carries
      // an extra-charge line the repair path would otherwise have to price.
      await withRollback(async (client) => {
        const { contractId } = await seedYearContract(client, 500);
        await addExtraCharge(client, contractId, 50);
        await generateYear(client, contractId);
        const january = await invoiceForMonth(client, contractId, 1);
        await markPaid(client, january.id);

        await makeJanuaryFree(client, contractId);
        await client.query(`select * from public.${repairFn}($1)`, [contractId]);

        const after = await invoiceForMonth(client, contractId, 1);
        expect(after).toBeDefined();
        expect(after.id).toBe(january.id);
        expect(Number(after.subtotal)).toBe(550);
        expect(after.state).toBe("paid");
        expect(await itemsOf(client, after.id)).toHaveLength(2);
      });
    },
  );

  test("a discounted invoice in a newly-free month is preserved, not deleted", async () => {
    // A concession link makes the invoice off-limits to regeneration (165:91):
    // an invoice the tenant was told is discounted and a month the tenant was
    // told is free are a contradiction only a human can settle.
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client, 500);
      await addExtraCharge(client, contractId, 50);
      await generateYear(client, contractId);
      const january = await invoiceForMonth(client, contractId, 1);

      const { rows } = await client.query<{ id: string }>(
        `insert into public.concessions
           (contract_id, type, status, start_date, end_date, discount_percent)
         values ($1, 'percentage_discount', 'active', $2::date, $3::date, 10)
         returning id`,
        [contractId, `${THIS_YEAR}-01-01`, `${THIS_YEAR}-12-31`],
      );
      await client.query(`select * from public.apply_concession_to_invoices($1, $2::uuid[])`, [
        rows[0].id,
        [january.id],
      ]);

      await makeJanuaryFree(client, contractId);
      await client.query(`select * from public.regenerate_contract_invoices($1)`, [contractId]);

      const after = await invoiceForMonth(client, contractId, 1);
      expect(after).toBeDefined();
      expect(after.id).toBe(january.id);
      expect(Number(after.discount)).toBe(50);
    });
  });
});
