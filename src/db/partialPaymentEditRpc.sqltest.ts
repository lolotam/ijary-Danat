import { afterAll, describe, expect, test } from "vitest";

import {
  actAs,
  actAsSuperuser,
  captureRaise,
  closePool,
  seedContract,
  withRollback,
} from "@/db/testDb";
import {
  editPartial,
  insertPartial,
  invoiceState,
  ownedPayments,
  scenario,
  seedUserWithRole,
} from "@/db/partialPaymentFixtures";

afterAll(closePool);

describe("edit_partial_payment carries the whole dialog through the resync", () => {
  test("amount up via RPC replaces the owned payment and marks it corrected", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const partialId = await insertPartial(client, fx, { amount: 200 });
      const beforeId = (await ownedPayments(client, partialId))[0].id;

      await editPartial(client, partialId, { amount: 300 });

      const payments = await ownedPayments(client, partialId);
      expect(payments).toHaveLength(1);
      expect(payments[0].id).not.toBe(beforeId);
      expect(Number(payments[0].amount)).toBe(300);
      expect(payments[0].note).toMatch(/\(corrected\)$/);

      const allocation = await client.query<{ amount: string; invoice_id: string }>(
        `select amount, invoice_id from public.payment_allocations where payment_id = $1`,
        [payments[0].id],
      );
      expect(allocation.rows).toHaveLength(1);
      expect(Number(allocation.rows[0].amount)).toBe(300);
      expect(allocation.rows[0].invoice_id).toBe(invoice.id);

      const after = await invoiceState(client, invoice.id);
      expect(Number(after.paid)).toBe(300);

      const receipts = await client.query<{ payment_id: string }>(
        `select payment_id from public.receipts where payment_id = any($1::uuid[])`,
        [[beforeId, payments[0].id]],
      );
      expect(receipts.rows.map((row) => row.payment_id)).toEqual([payments[0].id]);
    });
  });

  test("the RPC returns the row as the resync left it, not the pre-trigger tuple", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const total = Number(invoice.total);
      const partialId = await insertPartial(client, fx, { amount: total });

      const result = await editPartial(client, partialId, { amount: total - 50 });

      const returned = result.rows[0].edit_partial_payment as { status: string; amount: string };
      expect(returned.status).toBe("incomplete");
      expect(Number(returned.amount)).toBe(total - 50);
      const stored = await client.query<{ status: string }>(
        `select status from public.partial_payments where id = $1`,
        [partialId],
      );
      expect(stored.rows[0].status).toBe(returned.status);
    });
  });

  test("the RPC persists a status change on an unlinked row", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200, invoiceId: null });

      await editPartial(client, partialId, { amount: 200, status: "complete" });

      const row = await client.query<{ status: string }>(
        `select status from public.partial_payments where id = $1`,
        [partialId],
      );
      expect(row.rows[0].status).toBe("complete");
    });
  });

  test("the RPC leaves a linked row's status to the invoice", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200 });

      await editPartial(client, partialId, { amount: 200, status: "complete" });

      const row = await client.query<{ status: string }>(
        `select status from public.partial_payments where id = $1`,
        [partialId],
      );
      expect(row.rows[0].status).toBe("incomplete");
    });
  });

  test("the RPC moves an unlinked row to another contract", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const other = await seedContract(client, {
        companyId: fx.companyId,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const partialId = await insertPartial(client, fx, { amount: 200, invoiceId: null });

      await client.query(
        `select public.edit_partial_payment($1, 200, '2026-01-10', null, null, $2, $3, null, null, 'incomplete')`,
        [partialId, other.tenantId, other.contractId],
      );

      const row = await client.query<{ contract_id: string; tenant_id: string }>(
        `select contract_id, tenant_id from public.partial_payments where id = $1`,
        [partialId],
      );
      expect(row.rows[0].contract_id).toBe(other.contractId);
      expect(row.rows[0].tenant_id).toBe(other.tenantId);
    });
  });

  test("the RPC refuses an invoice that belongs to a different contract than the link", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const other = await seedContract(client, {
        companyId: fx.companyId,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const partialId = await insertPartial(client, fx, { amount: 200 });

      const error = await captureRaise(client, () =>
        client.query(
          `select public.edit_partial_payment($1, 200, '2026-01-10', $2, null, $3, $4, null, null, null)`,
          [partialId, fx.invoices[0].id, other.tenantId, other.contractId],
        ),
      );
      expect(error).toMatch(/partial_payment_invoice_(contract|tenant)_mismatch/);
    });
  });

  test("a role without partial_payments.update cannot call the edit RPC", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200 });
      const readonly = await seedUserWithRole(client, "readonly");
      await actAs(client, "authenticated", readonly);

      const error = await captureRaise(client, () =>
        editPartial(client, partialId, { amount: 220 }),
      );

      await actAsSuperuser(client);
      expect(error).toMatch(/Permission denied|42501/i);
      expect(Number((await ownedPayments(client, partialId))[0].amount)).toBe(200);
    });
  });
});
