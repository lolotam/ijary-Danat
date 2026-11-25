import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";

import {
  actAs,
  actAsSuperuser,
  captureRaise,
  closePool,
  seedContract,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

type AuditRow = {
  action: string;
  actor_id: string | null;
  after: Record<string, unknown>;
  entity_id: string;
  entity_type: string;
};

/** ينشئ مستخدمًا بدور محدد في auth.users و user_roles. */
async function seedUserWithRole(client: PoolClient, role: string): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@example.test`],
  );
  await client.query(
    `insert into public.user_roles (user_id, role) values ($1, $2::public.app_role)`,
    [userId, role],
  );
  return userId;
}

/** عقد بفاتورة واحدة ودفعة مؤكّدة بقيمتها، دون تخصيص بعد. */
async function seedUnallocatedPayment(client: PoolClient) {
  const fixture = await seedContract(client, {
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    monthlyAmount: 300,
  });
  await client.query(`select public.generate_invoices($1::uuid, 2026)`, [fixture.contractId]);
  const invoice = await client.query<{ id: string; total: string }>(
    `select id, total from public.invoices where contract_id = $1
      order by period_year, period_month limit 1`,
    [fixture.contractId],
  );
  const amount = Number(invoice.rows[0].total);
  const payment = await client.query<{ id: string }>(
    `insert into public.payments (code, tenant_id, method, amount, payment_date, status)
     values (public.next_payment_code(), $1, 'cash', $2, current_date, 'confirmed')
     returning id`,
    [fixture.tenantId, amount],
  );
  return { ...fixture, amount, invoiceId: invoice.rows[0].id, paymentId: payment.rows[0].id };
}

/** يقرأ صفوف التدقيق المكتوبة لعملية بعينها. */
async function auditRowsFor(
  client: PoolClient,
  entityId: string,
  action: string,
): Promise<AuditRow[]> {
  const { rows } = await client.query<AuditRow>(
    `select action, actor_id, after, entity_id, entity_type
       from public.audit_logs where entity_id = $1 and action = $2`,
    [entityId, action],
  );
  return rows;
}

/**
 * Review finding on PR #206. Both RPCs are granted directly to `authenticated`
 * and run their own `has_permission` check, so an authorised user can call
 * either through PostgREST — a browser console, curl, any client holding the
 * anon key and a session — and move the money without the TypeScript wrapper
 * ever running. The audit row used to live in that wrapper, so the trail went
 * empty exactly when someone went around the UI.
 *
 * Every call below deliberately bypasses the wrapper, because that is the
 * scenario. Migration 213 moved the write inside the transaction that moves the
 * money, which is the same argument `close_out_contract` already makes.
 */
describe("money RPCs write their own audit row (migration 213)", () => {
  test("apply_payment_allocation records the allocation when called directly", async () => {
    await withRollback(async (client) => {
      const fixture = await seedUnallocatedPayment(client);
      const admin = await seedUserWithRole(client, "admin");

      await actAs(client, "authenticated", admin);
      await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
        fixture.paymentId,
        JSON.stringify([{ invoice_id: fixture.invoiceId, amount: fixture.amount }]),
      ]);
      await actAsSuperuser(client);

      const rows = await auditRowsFor(client, fixture.paymentId, "allocation.apply");
      expect(rows).toHaveLength(1);
      expect(rows[0].entity_type).toBe("payment");
      // The actor is what makes the row worth keeping: "who moved this money
      // onto that invoice" is the question the allocation rows cannot answer.
      expect(rows[0].actor_id).toBe(admin);
      expect(rows[0].after.allocations).toEqual([
        { invoice_id: fixture.invoiceId, amount: fixture.amount },
      ]);
    });
  });

  test("reverse_payment records the reversal, its reason and the mirror payment", async () => {
    await withRollback(async (client) => {
      const fixture = await seedUnallocatedPayment(client);
      const admin = await seedUserWithRole(client, "admin");
      await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
        fixture.paymentId,
        JSON.stringify([{ invoice_id: fixture.invoiceId, amount: fixture.amount }]),
      ]);

      await actAs(client, "authenticated", admin);
      const reversal = await client.query<{ reversal_payment_id: string }>(
        `select * from public.reverse_payment($1::uuid, $2)`,
        [fixture.paymentId, "duplicate deposit"],
      );
      await actAsSuperuser(client);

      const rows = await auditRowsFor(client, fixture.paymentId, "payment.reverse");
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe(admin);
      expect(rows[0].after.reason).toBe("duplicate deposit");
      // Naming the mirror payment is what lets someone reading the trail find
      // the row that carries the money back.
      expect(rows[0].after.reversal_payment_id).toBe(reversal.rows[0].reversal_payment_id);
    });
  });

  /**
   * The row must not survive a failed reversal. Writing it from inside the
   * function is what guarantees that — a wrapper writing afterwards could not
   * have recorded this case wrongly, but it also could not have recorded the
   * successful one at all when called directly.
   */
  test("a refused reversal leaves no audit row behind", async () => {
    await withRollback(async (client) => {
      const fixture = await seedUnallocatedPayment(client);
      await client.query(`update public.payments set status = 'pending' where id = $1`, [
        fixture.paymentId,
      ]);

      const raised = await captureRaise(client, () =>
        client.query(`select * from public.reverse_payment($1::uuid, $2)`, [
          fixture.paymentId,
          "should not commit",
        ]),
      );

      expect(raised).toMatch(/unreversed confirmed payment/i);
      expect(await auditRowsFor(client, fixture.paymentId, "payment.reverse")).toEqual([]);
    });
  });

  // One row per operation: the wrapper's own write was removed in the same
  // commit, so a reversal through the UI must not produce two.
  test("a single allocation produces exactly one audit row", async () => {
    await withRollback(async (client) => {
      const fixture = await seedUnallocatedPayment(client);
      await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
        fixture.paymentId,
        JSON.stringify([{ invoice_id: fixture.invoiceId, amount: fixture.amount }]),
      ]);

      const rows = await auditRowsFor(client, fixture.paymentId, "allocation.apply");
      expect(rows).toHaveLength(1);
    });
  });
});
