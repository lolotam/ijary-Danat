import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import {
  addExtraCharge,
  generateYear,
  invoiceForMonth,
  itemsOf,
  seedYearContract,
  THIS_YEAR,
} from "@/db/extraChargeFixtures";
import { captureRaise, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 171 — waiving a month's service charges when its rent is fully
 * discounted.
 *
 * Operator's revision of 2026-08-30: a 100% percentage discount, or a fixed
 * discount covering the whole rent, means "this month is free by any means", so
 * the admin is asked whether the recurring service charges of migration 163 go
 * too. Answering yes widens the discount to the full subtotal; the charge lines
 * stay on the invoice so it still records what was charged and what was
 * forgiven.
 *
 * Two properties these tests exist to hold:
 *
 *   1. The waiver is PER INVOICE. One fixed concession can cover the rent
 *      completely on one month and only partly on the next; a batch-wide flag
 *      is how the wrong month gets waived silently.
 *   2. The caller only PROPOSES. Every condition is re-derived inside the loop
 *      after `select ... for update`, so an id whose invoice no longer
 *      qualifies is ignored rather than trusted. A test that only ever passes
 *      qualifying ids cannot tell the two designs apart, which is why the
 *      partially-covered case below is the important one.
 */

type ConcessionSpec =
  | { type: "percentage_discount"; percent: number }
  | { type: "fixed_discount"; amount: number };

/** ينشئ تنازلاً ويربطه بالفواتير، مع تحديد أيها يتنازل عن مصروفاته. */
async function applyConcession(
  client: PoolClient,
  contractId: string,
  invoiceIds: string[],
  concession: ConcessionSpec,
  waiveIds: string[] = [],
) {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.concessions
       (contract_id, type, status, start_date, end_date, discount_percent, discount_amount)
     values ($1, $2::public.concession_types, 'active', $3::date, $4::date, $5, $6)
     returning id`,
    [
      contractId,
      concession.type,
      `${THIS_YEAR}-01-01`,
      `${THIS_YEAR}-12-31`,
      concession.type === "percentage_discount" ? concession.percent : null,
      concession.type === "fixed_discount" ? concession.amount : null,
    ],
  );
  await client.query(
    `select * from public.apply_concession_to_invoices($1, $2::uuid[], $3::uuid[])`,
    [rows[0].id, invoiceIds, waiveIds],
  );
  return rows[0].id;
}

/** عقد بإيجار 500 ومصروف 50، مع فواتير مولّدة. */
async function seedBilledContract(client: PoolClient) {
  const { contractId } = await seedYearContract(client, 500);
  await addExtraCharge(client, contractId, 50);
  await generateYear(client, contractId);
  return contractId;
}

describe("the waiver widens the discount to cover the service charges", () => {
  test.each([
    ["percentage_discount", { type: "percentage_discount", percent: 100 } as ConcessionSpec],
    ["fixed_discount covering the rent", { type: "fixed_discount", amount: 500 } as ConcessionSpec],
  ])("a fully-covered month waives to zero — %s", async (_label, concession) => {
    // Both routes to "the rent is entirely gone" must reach the same place,
    // because the operator's rule is about the outcome ("total free by any
    // way"), not about which control produced it.
    await withRollback(async (client) => {
      const contractId = await seedBilledContract(client);
      const january = await invoiceForMonth(client, contractId, 1);
      expect(Number(january.subtotal)).toBe(550);

      await applyConcession(client, contractId, [january.id], concession, [january.id]);

      const after = await invoiceForMonth(client, contractId, 1);
      expect(Number(after.discount)).toBe(550);
      expect(Number(after.total)).toBe(0);
    });
  });

  test("the charge lines stay on the waived invoice", async () => {
    // The operator chose widening over deleting the lines specifically so the
    // bill still records what was charged and what was forgiven.
    await withRollback(async (client) => {
      const contractId = await seedBilledContract(client);
      const january = await invoiceForMonth(client, contractId, 1);

      await applyConcession(
        client,
        contractId,
        [january.id],
        { type: "percentage_discount", percent: 100 },
        [january.id],
      );

      const items = await itemsOf(client, january.id);
      expect(items.filter((item) => item.is_extra_charge)).toHaveLength(1);
      expect(items.filter((item) => item.is_concession)).toHaveLength(1);
    });
  });

  test("without the waiver id the charges are still billed", async () => {
    // The default, and 169's behaviour: the discount covers the rent and the
    // invoice total is exactly the service charges.
    await withRollback(async (client) => {
      const contractId = await seedBilledContract(client);
      const january = await invoiceForMonth(client, contractId, 1);

      await applyConcession(client, contractId, [january.id], {
        type: "percentage_discount",
        percent: 100,
      });

      const after = await invoiceForMonth(client, contractId, 1);
      expect(Number(after.discount)).toBe(500);
      expect(Number(after.total)).toBe(50);
    });
  });
});

describe("the locked row decides, not the caller", () => {
  test("a waiver id on a PARTIALLY covered month is ignored", async () => {
    // The test that tells the two designs apart. A client that measured this
    // invoice before something changed — or simply got it wrong — must not be
    // able to waive a charge on a month whose rent is only half forgiven.
    await withRollback(async (client) => {
      const contractId = await seedBilledContract(client);
      const january = await invoiceForMonth(client, contractId, 1);

      await applyConcession(
        client,
        contractId,
        [january.id],
        { type: "percentage_discount", percent: 50 },
        [january.id],
      );

      const after = await invoiceForMonth(client, contractId, 1);
      // 50% of the 500 rent. Not 275, which is what widening to the subtotal
      // would have produced.
      expect(Number(after.discount)).toBe(250);
      expect(Number(after.total)).toBe(300);
    });
  });

  test("a waiver id on a month with no service charges changes nothing", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client, 500);
      await generateYear(client, contractId);
      const january = await invoiceForMonth(client, contractId, 1);

      await applyConcession(
        client,
        contractId,
        [january.id],
        { type: "percentage_discount", percent: 100 },
        [january.id],
      );

      const after = await invoiceForMonth(client, contractId, 1);
      expect(Number(after.discount)).toBe(500);
      expect(Number(after.total)).toBe(0);
    });
  });

  test("a mixed batch resolves each invoice independently", async () => {
    // One concession, three months, one waiver id. A batch-wide boolean would
    // waive all three; naming ids means only the month the operator ticked is
    // touched, and the untouched ones keep billing their charges.
    await withRollback(async (client) => {
      const contractId = await seedBilledContract(client);
      const [jan, feb, mar] = await Promise.all([
        invoiceForMonth(client, contractId, 1),
        invoiceForMonth(client, contractId, 2),
        invoiceForMonth(client, contractId, 3),
      ]);

      await applyConcession(
        client,
        contractId,
        [jan.id, feb.id, mar.id],
        { type: "percentage_discount", percent: 100 },
        [feb.id],
      );

      const totals = await Promise.all(
        [1, 2, 3].map(async (month) =>
          Number((await invoiceForMonth(client, contractId, month)).total),
        ),
      );
      expect(totals).toEqual([50, 0, 50]);
    });
  });

  test("an invalid invoice later in the batch rolls the earlier ones back", async () => {
    // The loop mutates as it goes. Without a single transaction, a batch that
    // fails on its third invoice would leave the first two discounted with no
    // concession the operator ever confirmed.
    await withRollback(async (client) => {
      const contractId = await seedBilledContract(client);
      const jan = await invoiceForMonth(client, contractId, 1);
      const feb = await invoiceForMonth(client, contractId, 2);
      await client.query(`update public.invoices set paid = 10 where id = $1`, [feb.id]);

      const error = await captureRaise(client, async () => {
        await applyConcession(client, contractId, [jan.id, feb.id], {
          type: "percentage_discount",
          percent: 100,
        });
      });

      expect(error).toMatch(/not fully unpaid/i);
      expect(Number((await invoiceForMonth(client, contractId, 1)).discount)).toBe(0);
    });
  });
});

describe("a fixed discount is now capped at the rent", () => {
  // 169 capped a fixed discount at the whole subtotal, so 520 against a
  // 500 + 50 invoice quietly ate 20 of the cleaning charge. 171 caps it at the
  // rent, which is what makes the waiver the only route to a discounted service
  // charge — and therefore the only auditable one. The 200 row is the control:
  // a discount below the rent must be untouched by the new cap.
  test.each([
    [520, 500, 50],
    [200, 200, 350],
  ])(
    "a fixed discount of %i takes %i and leaves %i owing",
    async (amount, expectedDiscount, expectedTotal) => {
      await withRollback(async (client) => {
        const contractId = await seedBilledContract(client);
        const january = await invoiceForMonth(client, contractId, 1);

        await applyConcession(client, contractId, [january.id], {
          type: "fixed_discount",
          amount,
        });

        const after = await invoiceForMonth(client, contractId, 1);
        expect(Number(after.discount)).toBe(expectedDiscount);
        expect(Number(after.total)).toBe(expectedTotal);
      });
    },
  );
});

describe("deleting the concession restores what was waived", () => {
  test("rent and service charges both come back", async () => {
    // The waiver is only safe because it is reversible. The delete trigger
    // (127:640) resets discount and total and removes the concession line —
    // this pins that it does so for a WIDENED discount too, restoring the full
    // 550 rather than the 500 a rent-only discount would have taken.
    await withRollback(async (client) => {
      const contractId = await seedBilledContract(client);
      const january = await invoiceForMonth(client, contractId, 1);
      const concessionId = await applyConcession(
        client,
        contractId,
        [january.id],
        { type: "percentage_discount", percent: 100 },
        [january.id],
      );
      expect(Number((await invoiceForMonth(client, contractId, 1)).total)).toBe(0);

      await client.query(`delete from public.concessions where id = $1`, [concessionId]);

      const after = await invoiceForMonth(client, contractId, 1);
      expect(Number(after.discount)).toBe(0);
      expect(Number(after.total)).toBe(550);
      expect(Number(after.subtotal)).toBe(550);

      const items = await itemsOf(client, after.id);
      expect(items.filter((item) => item.is_concession)).toHaveLength(0);
      expect(items.filter((item) => item.is_extra_charge)).toHaveLength(1);

      const { rows } = await client.query(
        `select 1 from public.concession_invoices where invoice_id = $1`,
        [after.id],
      );
      expect(rows).toHaveLength(0);
    });
  });
});
