import { afterAll, describe, expect, test } from "vitest";

import { captureRaise, closePool, withRollback } from "@/db/testDb";
import { insertPartial, invoiceState, ownedPayments, scenario } from "@/db/partialPaymentFixtures";

afterAll(closePool);

describe("editing a settled partial payment re-syncs the settlement", () => {
  test("amount down on a fully paid invoice with one partial reopens it", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const total = Number(invoice.total);
      const partialId = await insertPartial(client, fx, { amount: total });
      expect((await invoiceState(client, invoice.id)).state).toBe("paid");

      await client.query(`update public.partial_payments set amount = $2 where id = $1`, [
        partialId,
        total - 50,
      ]);

      const after = await invoiceState(client, invoice.id);
      expect(after.state).toBe("overdue"); // past-due fixture: overdue outranks a partial (migration 218);
      expect(Number(after.paid)).toBe(total - 50);

      const status = await client.query<{ status: string }>(
        `select status from public.partial_payments where id = $1`,
        [partialId],
      );
      expect(status.rows[0].status).toBe("incomplete");
    });
  });

  test("SET amount = amount leaves the payment id unchanged", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200 });
      const beforeId = (await ownedPayments(client, partialId))[0].id;

      await client.query(`update public.partial_payments set amount = amount where id = $1`, [
        partialId,
      ]);

      expect((await ownedPayments(client, partialId))[0].id).toBe(beforeId);
    });
  });

  test("amount above balance + own credit is refused and nothing moves", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const total = Number(invoice.total);
      const partialId = await insertPartial(client, fx, { amount: 200 });
      const beforePayment = (await ownedPayments(client, partialId))[0];

      const error = await captureRaise(client, () =>
        client.query(`update public.partial_payments set amount = $2 where id = $1`, [
          partialId,
          total + 1,
        ]),
      );
      expect(error).toMatch(/partial_payment_exceeds_balance/);

      expect(Number((await ownedPayments(client, partialId))[0].amount)).toBe(200);
      expect((await ownedPayments(client, partialId))[0].id).toBe(beforePayment.id);
      const allocation = await client.query<{ amount: string }>(
        `select amount from public.payment_allocations where payment_id = $1`,
        [beforePayment.id],
      );
      expect(Number(allocation.rows[0].amount)).toBe(200);
      expect(Number((await invoiceState(client, invoice.id)).paid)).toBe(200);
    });
  });

  test("same-invoice reduction succeeds while an earlier month is open", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      await insertPartial(client, fx, { amount: Number(fx.invoices[0].total) });
      const later = await insertPartial(client, fx, {
        amount: 200,
        invoiceId: fx.invoices[1].id,
      });
      await client.query(`delete from public.partial_payments where invoice_id = $1`, [
        fx.invoices[0].id,
      ]);
      expect(Number((await invoiceState(client, fx.invoices[0].id)).paid)).toBe(0);

      await client.query(`update public.partial_payments set amount = 150 where id = $1`, [later]);

      expect(Number((await ownedPayments(client, later))[0].amount)).toBe(150);
      expect(Number((await invoiceState(client, fx.invoices[1].id)).paid)).toBe(150);
    });
  });

  test("transfer to a later month that reopens the earlier one is out of order", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      // 200 fits the later month's balance, so the balance guard passes and the
      // chronological guard is what refuses: moving it reopens January.
      const first = await insertPartial(client, fx, { amount: 200 });

      const error = await captureRaise(client, () =>
        client.query(`update public.partial_payments set invoice_id = $2 where id = $1`, [
          first,
          fx.invoices[1].id,
        ]),
      );
      expect(error).toMatch(/partial_payment_invoice_out_of_order/);
    });
  });

  test("transfer to an earlier unpaid month succeeds and recomputes both", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const first = await insertPartial(client, fx, { amount: Number(fx.invoices[0].total) });
      const later = await insertPartial(client, fx, {
        amount: 100,
        invoiceId: fx.invoices[1].id,
      });
      await client.query(`delete from public.partial_payments where id = $1`, [first]);

      await client.query(
        `update public.partial_payments set invoice_id = $2, contract_id = $3 where id = $1`,
        [later, fx.invoices[0].id, fx.contractId],
      );

      expect(Number((await invoiceState(client, fx.invoices[0].id)).paid)).toBe(100);
      expect(Number((await invoiceState(client, fx.invoices[1].id)).paid)).toBe(0);
    });
  });

  test("unlink reverts, recomputes, and leaves status untouched", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const partialId = await insertPartial(client, fx, { amount: 200 });
      const before = await client.query<{ status: string }>(
        `select status from public.partial_payments where id = $1`,
        [partialId],
      );

      await client.query(`update public.partial_payments set invoice_id = null where id = $1`, [
        partialId,
      ]);

      expect(await ownedPayments(client, partialId)).toHaveLength(0);
      expect(Number((await invoiceState(client, invoice.id)).paid)).toBe(0);
      const after = await client.query<{ status: string }>(
        `select status from public.partial_payments where id = $1`,
        [partialId],
      );
      expect(after.rows[0].status).toBe(before.rows[0].status);
    });
  });

  test("unlink from a cancelled invoice is refused", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200 });
      await client.query(`update public.invoices set state = 'cancelled' where id = $1`, [
        fx.invoices[0].id,
      ]);

      const error = await captureRaise(client, () =>
        client.query(`update public.partial_payments set invoice_id = null where id = $1`, [
          partialId,
        ]),
      );
      expect(error).toMatch(/partial_payment_invoice_terminal_state/);
      expect(await ownedPayments(client, partialId)).toHaveLength(1);
    });
  });

  test("linking an unlinked row settles it", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200, invoiceId: null });
      expect(await ownedPayments(client, partialId)).toHaveLength(0);

      await client.query(
        `update public.partial_payments set invoice_id = $2, contract_id = $3 where id = $1`,
        [partialId, fx.invoices[0].id, fx.contractId],
      );

      expect(await ownedPayments(client, partialId)).toHaveLength(1);
      expect(Number((await invoiceState(client, fx.invoices[0].id)).paid)).toBe(200);
    });
  });

  test("paid_date change updates the payment date and the receipt snapshot", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200 });
      const beforeId = (await ownedPayments(client, partialId))[0].id;

      await client.query(
        `update public.partial_payments set paid_date = '2026-01-20' where id = $1`,
        [partialId],
      );

      const after = (await ownedPayments(client, partialId))[0];
      expect(after.id).not.toBe(beforeId);
      expect(after.payment_date.slice(0, 10)).toBe("2026-01-20");

      const receipt = await client.query<{ html_snapshot: string | null }>(
        `select html_snapshot from public.receipts where payment_id = $1`,
        [after.id],
      );
      expect(receipt.rows).toHaveLength(1);
      expect(receipt.rows[0].html_snapshot).toMatch(/<ul><li>/);
    });
  });

  test("a note-only change leaves the payment id unchanged", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200 });
      const beforeId = (await ownedPayments(client, partialId))[0].id;

      await client.query(`update public.partial_payments set note = 'typo fix' where id = $1`, [
        partialId,
      ]);

      expect((await ownedPayments(client, partialId))[0].id).toBe(beforeId);
    });
  });

  test("editing one of two partials leaves the other payment, allocation and receipt", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const first = await insertPartial(client, fx, { amount: 100 });
      const second = await insertPartial(client, fx, { amount: 150 });
      const untouched = (await ownedPayments(client, second))[0];
      const untouchedReceipt = await client.query<{ id: string; html_snapshot: string | null }>(
        `select id, html_snapshot from public.receipts where payment_id = $1`,
        [untouched.id],
      );

      await client.query(`update public.partial_payments set amount = 120 where id = $1`, [first]);

      const still = (await ownedPayments(client, second))[0];
      expect(still.id).toBe(untouched.id);
      expect(Number(still.amount)).toBe(150);
      const allocation = await client.query<{ amount: string }>(
        `select amount from public.payment_allocations where payment_id = $1`,
        [still.id],
      );
      expect(Number(allocation.rows[0].amount)).toBe(150);
      const receipt = await client.query<{ id: string; html_snapshot: string | null }>(
        `select id, html_snapshot from public.receipts where payment_id = $1`,
        [still.id],
      );
      expect(receipt.rows[0].id).toBe(untouchedReceipt.rows[0].id);
      expect(receipt.rows[0].html_snapshot).toBe(untouchedReceipt.rows[0].html_snapshot);
    });
  });

  test("a bulk statement updating two rows' amounts is refused", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const first = await insertPartial(client, fx, { amount: 100 });
      const second = await insertPartial(client, fx, { amount: 150 });

      const error = await captureRaise(client, () =>
        client.query(
          `update public.partial_payments set amount = amount + 1 where id = any($1::uuid[])`,
          [[first, second]],
        ),
      );
      expect(error).toMatch(/partial_payment_bulk_edit_unsupported/);
    });
  });
});
