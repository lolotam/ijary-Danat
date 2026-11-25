import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import {
  actAs,
  actAsSuperuser,
  captureRaise,
  closePool,
  seedContract,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 160 — a partial payment that names an invoice settles it.
 *
 * These run against the trigger, never through the panel, because the panel is
 * not the only writer: `useCreateMoneyRecord` inserts over PostgREST and
 * anything added later would too. A test that went through a mocked client
 * would prove nothing about either.
 */

type Scenario = Awaited<ReturnType<typeof scenario>>;

/**
 * عقد بفواتير مولّدة، جاهز لاستقبال دفعات جزئية.
 */
async function scenario(client: PoolClient, monthlyAmount = 500) {
  const fx = await seedContract(client, {
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    monthlyAmount,
  });
  await client.query(`select public.generate_invoices($1::uuid, 2026)`, [fx.contractId]);
  const invoices = await client.query<{
    id: string;
    total: string;
    period_month: number;
  }>(
    `select id, total, period_month from public.invoices
      where contract_id = $1 order by period_year, period_month`,
    [fx.contractId],
  );
  return { ...fx, invoices: invoices.rows };
}

/**
 * ينشئ دفعة جزئية مرتبطة بفاتورة، ويعيد معرّفها.
 */
async function insertPartial(
  client: PoolClient,
  fx: Scenario,
  options: { amount: number; invoiceId?: string | null },
): Promise<string> {
  const linked = options.invoiceId !== undefined ? options.invoiceId : fx.invoices[0].id;
  const row = await client.query<{ id: string }>(
    `insert into public.partial_payments
       (company_id, tenant_id, contract_id, invoice_id, amount, paid_date)
     values ($1, $2, $3, $4, $5, '2026-01-10') returning id`,
    [fx.companyId, fx.tenantId, linked ? fx.contractId : null, linked, options.amount],
  );
  return row.rows[0].id;
}

/**
 * حالة الفاتورة ومبلغها المسدَّد ورصيدها.
 */
async function invoiceState(client: PoolClient, invoiceId: string) {
  const row = await client.query<{ state: string; paid: string; balance: string }>(
    `select state, paid, balance from public.invoices where id = $1`,
    [invoiceId],
  );
  return row.rows[0];
}

/**
 * الدفعات المملوكة لهذه الدفعة الجزئية، مُحدَّدة بـ `source_partial_payment_id` وحده.
 *
 * Never by reference or tenant: the whole point of the column is that a revert
 * can only ever find the payment its own ledger row created.
 */
async function ownedPayments(client: PoolClient, partialId: string) {
  const row = await client.query<{ id: string; amount: string; status: string }>(
    `select id, amount, status from public.payments where source_partial_payment_id = $1`,
    [partialId],
  );
  return row.rows;
}

/**
 * مستخدم إداري حقيقي لاختبار ما يستطيع دور العميل فعله بالدفعات.
 *
 * The provenance guard keys on `current_user`, so it can only be exercised by
 * genuinely acting as `authenticated` — running as the pool's superuser would
 * take the "not a client role" branch and pass without testing anything.
 */
async function seedAdmin(client: PoolClient): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@example.test`],
  );
  await client.query(
    `insert into public.user_roles (user_id, role) values ($1, 'admin'::public.app_role)`,
    [userId],
  );
  return userId;
}

describe("a linked partial payment settles its invoice", () => {
  test("below the balance leaves it partially paid", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const partialId = await insertPartial(client, fx, { amount: 200 });

      const payments = await ownedPayments(client, partialId);
      expect(payments).toHaveLength(1);
      expect(Number(payments[0].amount)).toBe(200);
      expect(payments[0].status).toBe("confirmed");

      const after = await invoiceState(client, invoice.id);
      expect(after.state).toBe("overdue"); // past-due fixture: overdue outranks a partial (migration 218);
      expect(Number(after.paid)).toBe(200);
      expect(Number(after.balance)).toBe(Number(invoice.total) - 200);
    });
  });

  // THE REPORTED BUG. Two partials adding up to the total must mark it paid.
  test("two partials reaching the total mark it paid and complete both rows", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const total = Number(invoice.total);

      const first = await insertPartial(client, fx, { amount: total - 150 });
      expect((await invoiceState(client, invoice.id)).state).toBe("overdue"); // past-due fixture: overdue outranks a partial (migration 218);

      const second = await insertPartial(client, fx, { amount: 150 });

      const after = await invoiceState(client, invoice.id);
      expect(after.state).toBe("paid");
      expect(Number(after.balance)).toBe(0);

      // 147's invoice-to-partial trigger still runs, and now has something to do.
      const statuses = await client.query<{ status: string }>(
        `select status from public.partial_payments where id = any($1::uuid[])`,
        [[first, second]],
      );
      expect(statuses.rows.map((r) => r.status)).toEqual(["complete", "complete"]);
    });
  });

  test("an unlinked partial settles nothing", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200, invoiceId: null });

      expect(await ownedPayments(client, partialId)).toHaveLength(0);
      expect(Number((await invoiceState(client, fx.invoices[0].id)).paid)).toBe(0);
    });
  });

  test("the settlement's receipt snapshot is refreshed after the allocation exists", async () => {
    // The receipt trigger fires on the payment INSERT, before the allocation
    // (05:463), so an unrefreshed snapshot would show an unallocated payment.
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200 });
      const paymentId = (await ownedPayments(client, partialId))[0].id;

      const receipt = await client.query<{ html_snapshot: string | null }>(
        `select html_snapshot from public.receipts where payment_id = $1`,
        [paymentId],
      );
      expect(receipt.rows).toHaveLength(1);
      // The allocation line is the whole point: the trigger's own snapshot,
      // taken before the allocation existed, renders an EMPTY <ul>. A non-empty
      // one can only come from the refresh.
      expect(receipt.rows[0].html_snapshot).toMatch(/<ul><li>[^<]*200\.000 KWD<\/li><\/ul>/);

      // Differential, so the assertion above cannot pass vacuously: a payment
      // with no allocation renders the empty list this test claims to rule out.
      const bare = await client.query<{ id: string }>(
        `insert into public.payments (code, tenant_id, method, amount, payment_date, status)
         values (public.next_payment_code(), $1, 'cash', 5, current_date, 'confirmed')
         returning id`,
        [fx.tenantId],
      );
      const bareReceipt = await client.query<{ html_snapshot: string | null }>(
        `select html_snapshot from public.receipts where payment_id = $1`,
        [bare.rows[0].id],
      );
      expect(bareReceipt.rows[0].html_snapshot).not.toMatch(/<ul><li>/);
    });
  });
});

describe("linking an existing partial payment settles it too", () => {
  // Migration 160 settled on INSERT only, and the immutability trigger refuses
  // an invoice_id change only once a payment exists — which is never for a row
  // that was never settled. So saving an unlinked partial and then editing it to
  // pick an invoice reproduced the original bug through the edit path.
  test("editing an unlinked partial to name an invoice creates its payment", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const partialId = await insertPartial(client, fx, { amount: 200, invoiceId: null });
      expect(await ownedPayments(client, partialId)).toHaveLength(0);

      await client.query(
        `update public.partial_payments set invoice_id = $2, contract_id = $3 where id = $1`,
        [partialId, invoice.id, fx.contractId],
      );

      expect(await ownedPayments(client, partialId)).toHaveLength(1);
      const after = await invoiceState(client, invoice.id);
      expect(after.state).toBe("overdue"); // past-due fixture: overdue outranks a partial (migration 218);
      expect(Number(after.paid)).toBe(200);
    });
  });

  test("linking to an over-balance invoice is refused, exactly as on insert", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, {
        amount: Number(fx.invoices[0].total) + 1,
        invoiceId: null,
      });

      const error = await captureRaise(client, () =>
        client.query(
          `update public.partial_payments set invoice_id = $2, contract_id = $3 where id = $1`,
          [partialId, fx.invoices[0].id, fx.contractId],
        ),
      );
      expect(error).toMatch(/partial_payment_exceeds_balance/);
    });
  });

  test("the ordinary status write does not re-enter the settlement", async () => {
    // sync_status updates `status`, not `invoice_id`, so the link trigger's
    // column list keeps it out. If that were widened, every settlement would
    // recurse through this path.
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const partialId = await insertPartial(client, fx, { amount: Number(invoice.total) });

      expect((await invoiceState(client, invoice.id)).state).toBe("paid");
      expect(await ownedPayments(client, partialId)).toHaveLength(1);
    });
  });
});

describe("the money it moves is guarded", () => {
  test("an amount above the balance is refused and nothing is written", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];

      const error = await captureRaise(client, () =>
        insertPartial(client, fx, { amount: Number(invoice.total) + 1 }),
      );
      expect(error).toMatch(/partial_payment_exceeds_balance/);

      expect(Number((await invoiceState(client, invoice.id)).paid)).toBe(0);
      const rows = await client.query(`select 1 from public.partial_payments`);
      expect(rows.rows).toHaveLength(0);
    });
  });

  test("the cap is the REMAINING balance, not the total", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const total = Number(fx.invoices[0].total);
      await insertPartial(client, fx, { amount: total - 100 });

      const error = await captureRaise(client, () => insertPartial(client, fx, { amount: 101 }));
      expect(error).toMatch(/partial_payment_exceeds_balance/);
    });
  });

  test("exactly the remaining balance is accepted", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const total = Number(invoice.total);
      await insertPartial(client, fx, { amount: total - 100 });
      await insertPartial(client, fx, { amount: 100 });

      expect((await invoiceState(client, invoice.id)).state).toBe("paid");
    });
  });

  test("a later invoice is refused while an earlier one is open", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const error = await captureRaise(client, () =>
        insertPartial(client, fx, { amount: 100, invoiceId: fx.invoices[1].id }),
      );
      expect(error).toMatch(/partial_payment_invoice_out_of_order/);
    });
  });

  test("a later invoice is accepted once the earlier one is settled", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      await insertPartial(client, fx, { amount: Number(fx.invoices[0].total) });
      await insertPartial(client, fx, { amount: 100, invoiceId: fx.invoices[1].id });

      expect((await invoiceState(client, fx.invoices[1].id)).state).toBe("partially_paid");
    });
  });

  test("a cancelled invoice is refused", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      await client.query(`update public.invoices set state = 'cancelled' where id = $1`, [
        fx.invoices[0].id,
      ]);
      const error = await captureRaise(client, () => insertPartial(client, fx, { amount: 10 }));
      expect(error).toMatch(/partial_payment_invoice_terminal_state/);
    });
  });
});

describe("a settled partial payment can be deleted", () => {
  test("deleting reverts the payment, the allocation and the receipt", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const partialId = await insertPartial(client, fx, { amount: 200 });
      const paymentId = (await ownedPayments(client, partialId))[0].id;

      await client.query(`delete from public.partial_payments where id = $1`, [partialId]);

      expect(await ownedPayments(client, partialId)).toHaveLength(0);
      const allocations = await client.query(
        `select 1 from public.payment_allocations where payment_id = $1`,
        [paymentId],
      );
      expect(allocations.rows).toHaveLength(0);
      const receipts = await client.query(`select 1 from public.receipts where payment_id = $1`, [
        paymentId,
      ]);
      expect(receipts.rows).toHaveLength(0);

      const after = await invoiceState(client, invoice.id);
      expect(Number(after.paid)).toBe(0);
      expect(after.state).not.toBe("paid");
    });
  });

  // REGRESSION. The other delete tests leave the invoice `partially_paid`, so its
  // partials are already 'incomplete' and sync_status's `and status <>
  // 'incomplete'` makes it a no-op — neither can reach the collision. Only a
  // FULLY paid invoice puts a 'complete' row in sync_status's path, and that row
  // is the one being deleted. Without the BEFORE/AFTER split this raises
  // "tuple to be deleted was already modified by an operation triggered by the
  // current command".
  test("deleting a partial from a fully paid invoice succeeds and reopens it", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const total = Number(invoice.total);
      const first = await insertPartial(client, fx, { amount: total - 150 });
      await insertPartial(client, fx, { amount: 150 });
      expect((await invoiceState(client, invoice.id)).state).toBe("paid");

      await client.query(`delete from public.partial_payments where id = $1`, [first]);

      const after = await invoiceState(client, invoice.id);
      expect(after.state).toBe("overdue"); // past-due fixture: overdue outranks a partial (migration 218);
      expect(Number(after.paid)).toBe(150);

      const survivor = await client.query<{ status: string }>(
        `select status from public.partial_payments where invoice_id = $1`,
        [invoice.id],
      );
      expect(survivor.rows.map((r) => r.status)).toEqual(["incomplete"]);
    });
  });

  test("deleting one leaves another partial's money alone", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const first = await insertPartial(client, fx, { amount: 100 });
      await insertPartial(client, fx, { amount: 150 });

      await client.query(`delete from public.partial_payments where id = $1`, [first]);

      expect(Number((await invoiceState(client, invoice.id)).paid)).toBe(150);
    });
  });

  test("changing an unsettled row's amount is allowed", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200, invoiceId: null });
      await client.query(`update public.partial_payments set amount = 300 where id = $1`, [
        partialId,
      ]);
      const row = await client.query<{ amount: string }>(
        `select amount from public.partial_payments where id = $1`,
        [partialId],
      );
      expect(Number(row.rows[0].amount)).toBe(300);
    });
  });
});

describe("provenance is owned by the settlement, not by the client", () => {
  test("a client role cannot point a payment at a partial payment by hand", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 100, invoiceId: null });
      const payment = await client.query<{ id: string }>(
        `insert into public.payments (code, tenant_id, method, amount, payment_date, status)
         values (public.next_payment_code(), $1, 'cash', 50, current_date, 'confirmed')
         returning id`,
        [fx.tenantId],
      );
      const admin = await seedAdmin(client);
      await actAs(client, "authenticated", admin);

      const message = await captureRaise(client, () =>
        client.query(`update public.payments set source_partial_payment_id = $2 where id = $1`, [
          payment.rows[0].id,
          partialId,
        ]),
      );

      await actAsSuperuser(client);
      expect(message).toContain("payment_provenance_locked");
    });
  });

  test("a client role cannot edit a partial-owned payment at all", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 100 });
      const paymentId = (await ownedPayments(client, partialId))[0].id;
      const admin = await seedAdmin(client);
      await actAs(client, "authenticated", admin);

      const message = await captureRaise(client, () =>
        client.query(`update public.payments set note = 'edited' where id = $1`, [paymentId]),
      );

      await actAsSuperuser(client);
      expect(message).toContain("payment_owned_by_partial_payment");
    });
  });

  // Refused for EVERYONE, not only client roles: reverse_payment is itself
  // SECURITY DEFINER, so a role test would wave it straight through, and a
  // reversal would reopen the invoice while the ledger row still asserted its
  // amount. Deleting the partial is the supported way to undo one.
  test("reversing a partial-owned payment is refused even outside a client role", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 100 });
      const paymentId = (await ownedPayments(client, partialId))[0].id;

      const message = await captureRaise(client, () =>
        client.query(`update public.payments set status = 'reversed' where id = $1`, [paymentId]),
      );
      expect(message).toContain("payment_owned_by_partial_payment");
    });
  });

  test("a client role cannot call the settlement function directly", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 100, invoiceId: null });
      const admin = await seedAdmin(client);
      await actAs(client, "authenticated", admin);

      const message = await captureRaise(client, () =>
        client.query(`select public.apply_partial_payment_settlement($1)`, [partialId]),
      );

      await actAsSuperuser(client);
      expect(message).toMatch(/partial_payment_settlement_internal_only|permission denied/i);
    });
  });
});

describe("the backfill", () => {
  test("settles a pre-existing linked partial that owns no payment", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];

      // Reproduce a pre-migration row: linked, but written while the settlement
      // trigger was disabled — exactly the state production was left in.
      await client.query(
        `alter table public.partial_payments disable trigger partial_payments_settle`,
      );
      const partialId = await insertPartial(client, fx, { amount: 200 });
      await client.query(
        `alter table public.partial_payments enable trigger partial_payments_settle`,
      );
      expect(await ownedPayments(client, partialId)).toHaveLength(0);

      await client.query(`select public.apply_partial_payment_settlement($1)`, [partialId]);

      expect(await ownedPayments(client, partialId)).toHaveLength(1);
      expect(Number((await invoiceState(client, invoice.id)).paid)).toBe(200);
    });
  });
});
