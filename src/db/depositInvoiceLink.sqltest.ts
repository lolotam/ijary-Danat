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
 * Migrations 152-154 — a confirmed bank deposit settles the invoice it names.
 *
 * These run against the trigger, never through the form, because the form is
 * not the only writer: the deposits screen writes `deposits` over PostgREST
 * from two places and `bulk_import_phase6` writes it as service_role. A test
 * that went through a mocked client would prove nothing about any of them.
 */

type Scenario = Awaited<ReturnType<typeof scenario>>;

/**
 * عقد بفواتير مولّدة وإيداع بنكي غير مرتبط بعد.
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
 * ينشئ إيداعًا بنكيًا بالحالة والمبلغ المطلوبين.
 */
async function insertDeposit(
  client: PoolClient,
  fx: Scenario,
  options: { amount: number; status: string; invoiceId?: string | null; type?: string },
): Promise<string> {
  const linked = options.invoiceId !== undefined ? options.invoiceId : fx.invoices[0].id;
  const row = await client.query<{ id: string }>(
    `insert into public.deposits
       (code, company_id, deposit_date, bank_name, amount, currency, deposit_type,
        status, contract_id, invoice_id)
     values (public.next_deposit_code(), $1, '2026-01-05', 'Gulf Bank', $2, 'KWD', $3,
             $4, $5, $6)
     returning id`,
    [
      fx.companyId,
      options.amount,
      options.type ?? "cash",
      options.status,
      linked ? fx.contractId : null,
      linked,
    ],
  );
  return row.rows[0].id;
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
 * الدفعات المملوكة لهذا الإيداع، مُحدَّدة بـ `source_deposit_id` وحده.
 *
 * Never by reference or tenant: the whole point of the column is that a
 * cancellation can only ever find the payment its own deposit created.
 */
async function depositPayments(client: PoolClient, depositId: string) {
  const row = await client.query<{ id: string; amount: string; method: string; status: string }>(
    `select id, amount, method, status from public.payments where source_deposit_id = $1`,
    [depositId],
  );
  return row.rows;
}

describe("a confirmed deposit settles its invoice", () => {
  test("covering the balance marks the invoice paid, with one owned payment", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const depositId = await insertDeposit(client, fx, {
        amount: Number(invoice.total),
        status: "confirmed",
      });

      const payments = await depositPayments(client, depositId);
      expect(payments).toHaveLength(1);
      expect(Number(payments[0].amount)).toBe(Number(invoice.total));

      const after = await invoiceState(client, invoice.id);
      expect(after.state).toBe("paid");
      expect(Number(after.balance)).toBe(0);
    });
  });

  // The whole point of capping at the balance. Settling the full balance the
  // way set_invoice_paid does would invent money the bank never received.
  test("a deposit short of the balance leaves it partially paid and invents nothing", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const depositId = await insertDeposit(client, fx, { amount: 120, status: "confirmed" });

      const payments = await depositPayments(client, depositId);
      expect(Number(payments[0].amount)).toBe(120);

      const after = await invoiceState(client, invoice.id);
      expect(after.state).toBe("overdue"); // past-due fixture: overdue outranks a partial (migration 218);
      expect(Number(after.paid)).toBe(120);
    });
  });

  test("the payment carries the deposit's own instrument", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const depositId = await insertDeposit(client, fx, {
        amount: 100,
        status: "confirmed",
        type: "cheque",
      });

      expect((await depositPayments(client, depositId))[0].method).toBe("cheque");
    });
  });

  test("a pending deposit settles nothing", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const depositId = await insertDeposit(client, fx, { amount: 500, status: "pending" });

      expect(await depositPayments(client, depositId)).toHaveLength(0);
      expect(Number((await invoiceState(client, fx.invoices[0].id)).paid)).toBe(0);
    });
  });
});

describe("reverting a deposit undoes only what it did", () => {
  test("cancelling removes its payment and reopens the invoice", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const depositId = await insertDeposit(client, fx, {
        amount: Number(invoice.total),
        status: "confirmed",
      });
      expect((await invoiceState(client, invoice.id)).state).toBe("paid");

      await client.query(`update public.deposits set status = 'cancelled' where id = $1`, [
        depositId,
      ]);

      expect(await depositPayments(client, depositId)).toHaveLength(0);
      const after = await invoiceState(client, invoice.id);
      // due vs overdue depends on today against the fixture's January due date,
      // so assert the money — the actual guarantee — and only that the invoice
      // is outstanding again.
      expect(Number(after.paid)).toBe(0);
      expect(["due", "overdue"]).toContain(after.state);
    });
  });

  /**
   * The guarantee the owner chose on 2026-08-21 over the literal reading of
   * "cancelled means unpaid". A deposit cancellation must never delete money
   * the deposit did not create.
   */
  test("cancelling leaves an invoice paid by someone else alone", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];

      const payment = await client.query<{ id: string }>(
        `insert into public.payments (code, tenant_id, method, amount, payment_date, status)
         values (public.next_payment_code(), $1, 'knet', $2, current_date, 'confirmed')
         returning id`,
        [fx.tenantId, Number(invoice.total)],
      );
      await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
        payment.rows[0].id,
        JSON.stringify([{ invoice_id: invoice.id, amount: Number(invoice.total) }]),
      ]);
      expect((await invoiceState(client, invoice.id)).state).toBe("paid");

      const depositId = await insertDeposit(client, fx, { amount: 500, status: "confirmed" });
      await client.query(`update public.deposits set status = 'cancelled' where id = $1`, [
        depositId,
      ]);

      expect((await invoiceState(client, invoice.id)).state).toBe("paid");
      const survivor = await client.query(`select 1 from public.payments where id = $1`, [
        payment.rows[0].id,
      ]);
      expect(survivor.rowCount).toBe(1);
    });
  });

  test("deleting a confirmed deposit reverts it and the delete succeeds", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const depositId = await insertDeposit(client, fx, {
        amount: Number(invoice.total),
        status: "confirmed",
      });

      await client.query(`delete from public.deposits where id = $1`, [depositId]);

      expect(await depositPayments(client, depositId)).toHaveLength(0);
      const after = await invoiceState(client, invoice.id);
      expect(Number(after.paid)).toBe(0);
      expect(["due", "overdue"]).toContain(after.state);
    });
  });

  test("pending to cancelled changes nothing", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const depositId = await insertDeposit(client, fx, { amount: 500, status: "pending" });

      await client.query(`update public.deposits set status = 'cancelled' where id = $1`, [
        depositId,
      ]);

      expect(await depositPayments(client, depositId)).toHaveLength(0);
      expect(Number((await invoiceState(client, fx.invoices[0].id)).paid)).toBe(0);
    });
  });
});

describe("edits re-sync rather than double-settle", () => {
  // `update … of status` fires whenever the column is in the SET list, changed
  // or not, and the deposit form re-sends the whole row on every save. Without
  // the WHEN clause this produced a second payment per save.
  test("re-saving an unchanged confirmed deposit creates no second payment", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const depositId = await insertDeposit(client, fx, { amount: 200, status: "confirmed" });

      await client.query(
        `update public.deposits set status = 'confirmed', amount = 200 where id = $1`,
        [depositId],
      );

      expect(await depositPayments(client, depositId)).toHaveLength(1);
    });
  });

  // Revert-first. The invoice's balance already reflects this deposit's own
  // allocation, so capping the new amount against it before removing the old
  // one would read zero and the edit would silently do nothing.
  test("raising the amount re-syncs the payment and the invoice", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const depositId = await insertDeposit(client, fx, { amount: 100, status: "confirmed" });
      expect((await invoiceState(client, invoice.id)).state).toBe("overdue"); // past-due fixture: overdue outranks a partial (migration 218);

      await client.query(`update public.deposits set amount = $2 where id = $1`, [
        depositId,
        Number(invoice.total),
      ]);

      const payments = await depositPayments(client, depositId);
      expect(payments).toHaveLength(1);
      expect(Number(payments[0].amount)).toBe(Number(invoice.total));
      expect((await invoiceState(client, invoice.id)).state).toBe("paid");
    });
  });

  test("changing the instrument re-syncs the payment's method", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const depositId = await insertDeposit(client, fx, { amount: 100, status: "confirmed" });

      await client.query(`update public.deposits set deposit_type = 'cheque' where id = $1`, [
        depositId,
      ]);

      expect((await depositPayments(client, depositId))[0].method).toBe("cheque");
    });
  });

  /**
   * Moving a confirmed deposit to a LATER invoice is refused, and that refusal
   * is the chronological rule working rather than a defect: the move first
   * vacates the earlier invoice, which would leave it outstanding while a later
   * one is settled.
   *
   * The valuable part is what survives the refusal. The trigger reverts before
   * it settles, so a failed move must not leave the deposit stripped of the
   * payment it already owned — the raise has to take the revert down with it.
   */
  test("a refused move leaves the original settlement completely intact", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const [first, second] = fx.invoices;
      const depositId = await insertDeposit(client, fx, {
        amount: Number(first.total),
        status: "confirmed",
      });

      const message = await captureRaise(client, () =>
        client.query(`update public.deposits set invoice_id = $2 where id = $1`, [
          depositId,
          second.id,
        ]),
      );

      expect(message).toContain("deposit_invoice_out_of_order");
      const payments = await depositPayments(client, depositId);
      expect(payments).toHaveLength(1);
      expect((await invoiceState(client, first.id)).state).toBe("paid");
      expect((await invoiceState(client, second.id)).state).not.toBe("paid");
    });
  });

  test("re-pointing a pending deposit settles the new invoice once it is confirmed", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const [first, second] = fx.invoices;
      const depositId = await insertDeposit(client, fx, {
        amount: Number(first.total),
        status: "pending",
        invoiceId: second.id,
      });
      expect(await depositPayments(client, depositId)).toHaveLength(0);

      await client.query(`update public.deposits set invoice_id = $2 where id = $1`, [
        depositId,
        first.id,
      ]);
      await client.query(`update public.deposits set status = 'confirmed' where id = $1`, [
        depositId,
      ]);

      const owned = await client.query<{ invoice_id: string }>(
        `select pa.invoice_id from public.payment_allocations pa
           join public.payments p on p.id = pa.payment_id
          where p.source_deposit_id = $1`,
        [depositId],
      );
      expect(owned.rows).toHaveLength(1);
      expect(owned.rows[0].invoice_id).toBe(first.id);
    });
  });
});

describe("the link and the money it moves are guarded", () => {
  test("an invoice from another contract is refused", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const other = await scenario(client);

      const message = await captureRaise(client, () =>
        client.query(
          `insert into public.deposits
             (code, company_id, deposit_date, bank_name, amount, currency, deposit_type,
              status, contract_id, invoice_id)
           values (public.next_deposit_code(), $1, '2026-01-05', 'Gulf Bank', 100, 'KWD',
                   'cash', 'pending', $2, $3)`,
          [fx.companyId, fx.contractId, other.invoices[0].id],
        ),
      );

      expect(message).toContain("deposit_invoice_contract_mismatch");
    });
  });

  // The BEFORE trigger runs ahead of the CHECK constraint, so a null contract_id
  // beside a real invoice_id surfaces as a mismatch rather than as the paired
  // check. Both are refusals; this pins the one the user actually sees.
  test("an invoice_id without a contract_id is refused as a mismatch", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);

      const message = await captureRaise(client, () =>
        client.query(
          `insert into public.deposits
             (code, company_id, deposit_date, bank_name, amount, currency, deposit_type,
              status, invoice_id)
           values (public.next_deposit_code(), $1, '2026-01-05', 'Gulf Bank', 100, 'KWD',
                   'cash', 'pending', $2)`,
          [fx.companyId, fx.invoices[0].id],
        ),
      );

      expect(message).toContain("deposit_invoice_contract_mismatch");
    });
  });

  test("a contract_id without an invoice_id is refused by the paired check", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);

      const message = await captureRaise(client, () =>
        client.query(
          `insert into public.deposits
             (code, company_id, deposit_date, bank_name, amount, currency, deposit_type,
              status, contract_id)
           values (public.next_deposit_code(), $1, '2026-01-05', 'Gulf Bank', 100, 'KWD',
                   'cash', 'pending', $2)`,
          [fx.companyId, fx.contractId],
        ),
      );

      expect(message).toContain("deposits_contract_invoice_paired");
    });
  });

  test("a non-KWD deposit is refused by the database, not only the form", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);

      const message = await captureRaise(client, () =>
        client.query(
          `insert into public.deposits
             (code, company_id, deposit_date, bank_name, amount, currency, deposit_type, status)
           values (public.next_deposit_code(), $1, '2026-01-05', 'Gulf Bank', 100, 'USD',
                   'cash', 'pending')`,
          [fx.companyId],
        ),
      );

      expect(message).toContain("deposits_currency_kwd");
    });
  });

  test("settling a cancelled invoice is refused", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      await client.query(`update public.invoices set state = 'cancelled' where id = $1`, [
        fx.invoices[0].id,
      ]);

      const message = await captureRaise(client, () =>
        insertDeposit(client, fx, { amount: 100, status: "confirmed" }),
      );

      expect(message).toContain("deposit_invoice_terminal_state");
    });
  });

  test("an earlier unpaid invoice blocks the confirm", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);

      const message = await captureRaise(client, () =>
        client.query(
          `insert into public.deposits
             (code, company_id, deposit_date, bank_name, amount, currency, deposit_type,
              status, contract_id, invoice_id)
           values (public.next_deposit_code(), $1, '2026-02-05', 'Gulf Bank', 500, 'KWD',
                   'cash', 'confirmed', $2, $3)`,
          [fx.companyId, fx.contractId, fx.invoices[1].id],
        ),
      );

      expect(message).toContain("deposit_invoice_out_of_order");
    });
  });

  test("deleting an invoice unlinks a pending deposit instead of failing", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      // `generate_invoices` stops at the current month by design, so a full year
      // is not twelve rows — take the last one it actually created.
      const invoice = fx.invoices[fx.invoices.length - 1];
      const depositId = await insertDeposit(client, fx, {
        amount: 100,
        status: "pending",
        invoiceId: invoice.id,
      });

      await client.query(`delete from public.invoices where id = $1`, [invoice.id]);

      const after = await client.query<{ contract_id: string | null; invoice_id: string | null }>(
        `select contract_id, invoice_id from public.deposits where id = $1`,
        [depositId],
      );
      expect(after.rows[0].invoice_id).toBeNull();
      expect(after.rows[0].contract_id).toBeNull();
    });
  });
});

describe("the invoice recompute is reversal-aware", () => {
  /**
   * `reverse_payment` writes a POSITIVE mirror allocation (05:663), so
   * `sum(payment_allocations.amount)` — the expression migration 129 still uses
   * — counts reversed money as paid. This fails against that expression, which
   * is the point of writing it.
   */
  test("a reversed payment is not counted as paid when a deposit recomputes", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];

      const payment = await client.query<{ id: string }>(
        `insert into public.payments (code, tenant_id, method, amount, payment_date, status)
         values (public.next_payment_code(), $1, 'cash', $2, current_date, 'confirmed')
         returning id`,
        [fx.tenantId, Number(invoice.total)],
      );
      await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
        payment.rows[0].id,
        JSON.stringify([{ invoice_id: invoice.id, amount: Number(invoice.total) }]),
      ]);
      await client.query(`select public.reverse_payment($1::uuid, $2)`, [
        payment.rows[0].id,
        "test reversal",
      ]);

      // Now let a deposit drive a recompute of the same invoice.
      const depositId = await insertDeposit(client, fx, { amount: 100, status: "confirmed" });

      const after = await invoiceState(client, invoice.id);
      expect(Number(after.paid)).toBe(100);
      expect(after.state).toBe("overdue"); // past-due fixture: overdue outranks a partial (migration 218);
      expect(await depositPayments(client, depositId)).toHaveLength(1);
    });
  });

  test("reversing a deposit-owned payment is refused", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const depositId = await insertDeposit(client, fx, { amount: 100, status: "confirmed" });
      const paymentId = (await depositPayments(client, depositId))[0].id;

      const message = await captureRaise(client, () =>
        client.query(`select public.reverse_payment($1::uuid, $2)`, [paymentId, "nope"]),
      );

      expect(message).toContain("payment_owned_by_deposit");
    });
  });
});

describe("every settlement leaves an audit trail", () => {
  test("settling and reverting each write an audit row", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const depositId = await insertDeposit(client, fx, { amount: 100, status: "confirmed" });
      await client.query(`update public.deposits set status = 'cancelled' where id = $1`, [
        depositId,
      ]);

      const rows = await client.query<{ action: string }>(
        `select action from public.audit_logs
          where entity_type = 'deposit' and entity_id = $1 order by created_at`,
        [depositId],
      );
      expect(rows.rows.map((row) => row.action)).toEqual([
        "deposit.invoice.settle",
        "deposit.invoice.revert",
      ]);
    });
  });
});

describe("provenance cannot be forged from a client connection", () => {
  test("an admin cannot point a payment at a deposit by hand", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const depositId = await insertDeposit(client, fx, {
        amount: 100,
        status: "pending",
      });
      const payment = await client.query<{ id: string }>(
        `insert into public.payments (code, tenant_id, method, amount, payment_date, status)
         values (public.next_payment_code(), $1, 'cash', 50, current_date, 'confirmed')
         returning id`,
        [fx.tenantId],
      );
      const admin = await seedAdmin(client);
      await actAs(client, "authenticated", admin);

      const message = await captureRaise(client, () =>
        client.query(`update public.payments set source_deposit_id = $2 where id = $1`, [
          payment.rows[0].id,
          depositId,
        ]),
      );

      await actAsSuperuser(client);
      expect(message).toContain("payment_provenance_locked");
    });
  });

  // Whole-row immutability rather than a list of derived fields: the staff
  // update policy also reaches tenant_id, unit_id, company_id, account_type and
  // currency, and re-pointing any of those would strand a payment attributed to
  // one tenant on another tenant's invoice.
  test("an admin cannot edit a deposit-owned payment at all", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const depositId = await insertDeposit(client, fx, { amount: 100, status: "confirmed" });
      const paymentId = (await depositPayments(client, depositId))[0].id;
      const admin = await seedAdmin(client);
      await actAs(client, "authenticated", admin);

      const message = await captureRaise(client, () =>
        client.query(`update public.payments set note = 'edited' where id = $1`, [paymentId]),
      );

      await actAsSuperuser(client);
      expect(message).toContain("payment_owned_by_deposit");
    });
  });
});
