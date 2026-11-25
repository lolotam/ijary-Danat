import { afterAll, describe, expect, test } from "vitest";

import { captureRaise, closePool, withRollback } from "@/db/testDb";
import {
  insertPartial,
  invoiceState,
  migrationBody,
  ownedPayments,
  scenario,
} from "@/db/partialPaymentFixtures";

afterAll(closePool);

describe("migration 191 is re-runnable and refuses a broken ledger", () => {
  test("re-running migration 191 is a no-op on a healthy database", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200 });
      const beforeId = (await ownedPayments(client, partialId))[0].id;

      await client.query(migrationBody("191_partial_payment_resync_on_edit.sql"));

      expect((await ownedPayments(client, partialId))[0].id).toBe(beforeId);
      expect(Number((await invoiceState(client, fx.invoices[0].id)).paid)).toBe(200);
    });
  });

  test("the preflight raises on a fixture with a mismatched allocation", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200 });
      const paymentId = (await ownedPayments(client, partialId))[0].id;
      await client.query(
        `update public.payment_allocations set amount = 50 where payment_id = $1`,
        [paymentId],
      );

      const error = await captureRaise(client, () =>
        client.query(migrationBody("191_partial_payment_resync_on_edit.sql")),
      );
      expect(error).toMatch(/partial_payment_resync_preflight_failed/);
      expect(error).toContain(paymentId);
    });
  });
});
