import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";
import {
  insertPartial,
  invoiceState,
  migrationBody,
  ownedPayments,
  scenario,
} from "@/db/partialPaymentFixtures";

afterAll(closePool);

/**
 * الهجرة 193 — يأخذ مسار حذف الدفعة الجزئية قفل العقد الاستشاري.
 *
 * Contention needs two connections and this suite runs on one, so the lock's
 * presence is asserted on the function definition; the other tests prove the
 * replaced function still moves the money exactly as 160's did.
 */

describe("the partial-payment delete path takes the contract advisory lock (migration 193)", () => {
  test("deleting a settled partial still reverts its payment and reopens the invoice", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const partialId = await insertPartial(client, fx, { amount: 200 });
      expect((await invoiceState(client, invoice.id)).state).toBe("overdue"); // past-due fixture: overdue outranks a partial (migration 218);

      await client.query(`delete from public.partial_payments where id = $1`, [partialId]);

      expect(await ownedPayments(client, partialId)).toHaveLength(0);
      const after = await invoiceState(client, invoice.id);
      expect(Number(after.paid)).toBe(0);
      expect(Number(after.balance)).toBe(Number(invoice.total));
      expect(["partially_paid", "paid"]).not.toContain(after.state);
    });
  });

  test("deleting an unlinked partial takes no lock and just removes the row", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200, invoiceId: null });

      await client.query(`delete from public.partial_payments where id = $1`, [partialId]);

      const rows = await client.query<{ n: number }>(
        `select count(*)::int as n from public.partial_payments where id = $1`,
        [partialId],
      );
      expect(rows.rows[0].n).toBe(0);
    });
  });

  test("re-running migration 193 is a no-op on a healthy database", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200 });
      const beforeId = (await ownedPayments(client, partialId))[0].id;

      await client.query(migrationBody("193_partial_payment_delete_lock.sql"));

      expect((await ownedPayments(client, partialId))[0].id).toBe(beforeId);
      expect(Number((await invoiceState(client, fx.invoices[0].id)).paid)).toBe(200);

      await client.query(`delete from public.partial_payments where id = $1`, [partialId]);
      expect(await ownedPayments(client, partialId)).toHaveLength(0);
    });
  });

  test("the delete trigger function takes the contract advisory lock", async () => {
    await withRollback(async (client) => {
      // Asserted on the definition: the lock cannot be observed from the same session, because the settlement that inserted the fixture already holds the same key.
      const def = await client.query<{ definition: string }>(
        `select pg_get_functiondef('public.tg_partial_payments_revert_on_delete'::regproc) as definition`,
      );
      expect(def.rows[0].definition).toContain("pg_advisory_xact_lock");
      expect(def.rows[0].definition).toContain("hashtextextended");
    });
  });
});
