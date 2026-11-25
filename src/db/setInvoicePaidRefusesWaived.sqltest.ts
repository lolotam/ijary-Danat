import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import {
  captureRaise,
  captureRaiseError,
  closePool,
  seedContract,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 194 — a written-off or cancelled invoice cannot be marked paid or
 * unpaid. INV-0007120 was laundered waived → paid → due through this RPC on
 * 2026-09-13; the unpay branch recomputes state from money and can never
 * return to `waived`.
 */

/**
 * تنشئ عقداً وفواتيره ثم تضع فاتورة الشهر الأول في الحالة المطلوبة.
 *
 * Migration 159 enforces pay-oldest-first, so every fixture acts on period 1,
 * the earliest invoice — a later period would raise about ordering instead of
 * reaching the state guard.
 */
async function firstInvoiceIn(client: PoolClient, state: string) {
  const fx = await seedContract(client, { startDate: "2026-01-01", endDate: "2026-12-31" });
  await client.query(`select public.generate_invoices_for_year($1, 2026, true)`, [fx.contractId]);
  const { rows } = await client.query<{ id: string }>(
    `update public.invoices set state = $2::public.invoice_states where contract_id = $1 and period_month = 1 returning id`,
    [fx.contractId, state],
  );
  return rows[0].id;
}

describe("set_invoice_paid on a waived or cancelled invoice", () => {
  test.each([
    { state: "waived", paid: true },
    { state: "waived", paid: false },
    { state: "cancelled", paid: true },
    { state: "cancelled", paid: false },
  ])(
    "refuses p_paid=$paid on a $state invoice and leaves its state alone",
    async ({ state, paid }) => {
      await withRollback(async (client) => {
        const id = await firstInvoiceIn(client, state);
        const message = await captureRaise(client, () =>
          client.query(`select * from public.set_invoice_paid($1, $2, 'cash', null)`, [id, paid]),
        );
        expect(message).toMatch(/cannot be marked paid or unpaid/);
        const after = await client.query(`select state from public.invoices where id = $1`, [id]);
        expect(after.rows[0].state).toBe(state);
      });
    },
  );

  test("the refusal carries SQLSTATE 22023", async () => {
    await withRollback(async (client) => {
      const id = await firstInvoiceIn(client, "waived");
      const error = await captureRaiseError(client, () =>
        client.query(`select * from public.set_invoice_paid($1, true, 'cash', null)`, [id]),
      );
      expect(error).toMatchObject({ code: "22023" });
    });
  });

  test("a due invoice still marks paid", async () => {
    await withRollback(async (client) => {
      const id = await firstInvoiceIn(client, "due");
      await client.query(`select * from public.set_invoice_paid($1, true, 'cash', null)`, [id]);
      const after = await client.query(`select state from public.invoices where id = $1`, [id]);
      expect(after.rows[0].state).toBe("paid");
    });
  });
});
