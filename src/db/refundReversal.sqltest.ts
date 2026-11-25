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
 * Migration 85 / 86 — refund reverse/void + invoice write-off/dispute.
 *
 * These run real SQL against a real Postgres built from db/migrations. They
 * are the regression suite for the production incident (posted refund hard-
 * deleted) and for the double-count footgun in the aggregate RPCs.
 */

const RANGE = ["2026-01-01", "2026-12-31"] as const;

async function budget(client: PoolClient) {
  const { rows } = await client.query<{ summary: Record<string, unknown> }>(
    `select public.get_budget_summary($1::date, $2::date, null, null) as summary`,
    [RANGE[0], RANGE[1]],
  );
  return rows[0].summary;
}

async function paymentsSummary(client: PoolClient, tenantId?: string) {
  const { rows } = await client.query<{ summary: Record<string, unknown> }>(
    `select public.get_payments_summary(null, null, null, $1::uuid) as summary`,
    [tenantId ?? null],
  );
  return rows[0].summary;
}

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

async function seedPostedRefund(
  client: PoolClient,
  opts: { tenantId: string; contractId?: string; amount?: number; refundDate?: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.refunds (tenant_id, contract_id, amount, refund_date, post_action, status)
     values ($1, $2, $3, $4::date, 'store', 'posted')
     returning id`,
    [opts.tenantId, opts.contractId ?? null, opts.amount ?? 250, opts.refundDate ?? "2026-04-01"],
  );
  return rows[0].id;
}

describe("reverse_refund", () => {
  test("creates a POSITIVE mirror; original flips to reversed with amount unchanged", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const originalId = await seedPostedRefund(client, {
        tenantId,
        contractId,
        amount: 300,
      });
      const before = await client.query<{ amount: string; status: string }>(
        `select amount::text, status from public.refunds where id = $1`,
        [originalId],
      );
      expect(Number(before.rows[0].amount)).toBe(300);
      expect(before.rows[0].status).toBe("posted");

      const { rows } = await client.query<{ reversal_refund_id: string }>(
        `select * from public.reverse_refund($1, 'tenant returned keys early')`,
        [originalId],
      );
      const mirrorId = rows[0].reversal_refund_id;
      expect(mirrorId).toBeTruthy();
      expect(mirrorId).not.toBe(originalId);

      const original = await client.query<{
        amount: string;
        status: string;
        reversal_of_id: string | null;
      }>(`select amount::text, status, reversal_of_id from public.refunds where id = $1`, [
        originalId,
      ]);
      expect(Number(original.rows[0].amount)).toBe(300);
      expect(original.rows[0].status).toBe("reversed");
      expect(original.rows[0].reversal_of_id).toBeNull();

      const mirror = await client.query<{
        amount: string;
        status: string;
        reversal_of_id: string | null;
      }>(`select amount::text, status, reversal_of_id from public.refunds where id = $1`, [
        mirrorId,
      ]);
      // Positive amount — reversal is status + link, not sign.
      expect(Number(mirror.rows[0].amount)).toBe(300);
      expect(mirror.rows[0].status).toBe("reversed");
      expect(mirror.rows[0].reversal_of_id).toBe(originalId);
    });
  });

  test("double reversal raises", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const originalId = await seedPostedRefund(client, { tenantId, contractId });
      await client.query(`select * from public.reverse_refund($1, 'first reverse')`, [originalId]);
      expect(
        await captureRaise(client, () =>
          client.query(`select * from public.reverse_refund($1, 'second reverse')`, [originalId]),
        ),
      ).toMatch(/already been reversed|Only an unreversed posted/i);
    });
  });

  test("reversing a draft or already-reversed refund raises", async () => {
    await withRollback(async (client) => {
      const { tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const draft = await client.query<{ id: string }>(
        `insert into public.refunds (tenant_id, amount, post_action, status)
         values ($1, 50, 'store', 'draft') returning id`,
        [tenantId],
      );
      expect(
        await captureRaise(client, () =>
          client.query(`select * from public.reverse_refund($1, 'nope')`, [draft.rows[0].id]),
        ),
      ).toMatch(/Only an unreversed posted refund can be reversed/i);

      const posted = await seedPostedRefund(client, { tenantId, amount: 75 });
      const { rows } = await client.query<{ reversal_refund_id: string }>(
        `select * from public.reverse_refund($1, 'once')`,
        [posted],
      );
      expect(
        await captureRaise(client, () =>
          client.query(`select * from public.reverse_refund($1, 'mirror')`, [
            rows[0].reversal_refund_id,
          ]),
        ),
      ).toMatch(/Only an unreversed posted refund can be reversed/i);
    });
  });

  test("blank reason raises", async () => {
    await withRollback(async (client) => {
      const { tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const id = await seedPostedRefund(client, { tenantId });
      expect(
        await captureRaise(client, () =>
          client.query(`select * from public.reverse_refund($1, '   ')`, [id]),
        ),
      ).toMatch(/reversal reason is required/i);
    });
  });
});

describe("aggregate RPCs do not double-count reversals", () => {
  test("get_budget_summary nets to ZERO across an original + its reversal", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(
        `insert into public.payments (tenant_id, amount, method, status, payment_date)
         values ($1, 1000, 'cash', 'confirmed', '2026-03-01')`,
        [tenantId],
      );
      const before = await budget(client);
      const netBefore = Number(before.net);

      const refundId = await seedPostedRefund(client, {
        tenantId,
        contractId,
        amount: 250,
      });
      const withRefund = await budget(client);
      expect(Number(withRefund.refunds)).toBe(250);
      expect(Number(withRefund.net)).toBe(netBefore - 250);

      await client.query(`select * from public.reverse_refund($1, 'undo')`, [refundId]);
      const after = await budget(client);
      // Original flipped off; mirror carries reversal_of_id and is excluded.
      // Without the status filter this would report 500 refunds and net -500.
      expect(Number(after.refunds)).toBe(0);
      expect(Number(after.net)).toBe(netBefore);
    });
  });

  test("get_payments_summary net likewise excludes the reversal pair", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(
        `insert into public.payments (tenant_id, amount, method, status, payment_date)
         values ($1, 1000, 'cash', 'confirmed', '2026-03-01')`,
        [tenantId],
      );
      const before = await paymentsSummary(client, tenantId);
      const netBefore = Number(before.net);

      const refundId = await seedPostedRefund(client, {
        tenantId,
        contractId,
        amount: 250,
      });
      const withRefund = await paymentsSummary(client, tenantId);
      expect(Number((withRefund.refunds as { total: number }).total)).toBe(250);
      expect(Number(withRefund.net)).toBe(netBefore - 250);

      await client.query(`select * from public.reverse_refund($1, 'undo')`, [refundId]);
      const after = await paymentsSummary(client, tenantId);
      expect(Number((after.refunds as { total: number }).total)).toBe(0);
      expect(Number(after.net)).toBe(netBefore);
    });
  });
});

describe("void_refund", () => {
  test("flips to voided without a mirror and does not un-archive", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`update public.contracts set archived_at = now() where id = $1`, [
        contractId,
      ]);
      await client.query(`update public.tenants set archived_at = now() where id = $1`, [tenantId]);

      const refundId = await seedPostedRefund(client, { tenantId, contractId, amount: 100 });
      const countBefore = await client.query<{ n: string }>(
        `select count(*)::text as n from public.refunds where tenant_id = $1`,
        [tenantId],
      );

      await client.query(`select public.void_refund($1, 'entered in error')`, [refundId]);

      const refund = await client.query<{
        status: string;
        void_reason: string | null;
        voided_at: string | null;
      }>(`select status, void_reason, voided_at from public.refunds where id = $1`, [refundId]);
      expect(refund.rows[0].status).toBe("voided");
      expect(refund.rows[0].void_reason).toBe("entered in error");
      expect(refund.rows[0].voided_at).not.toBeNull();

      const countAfter = await client.query<{ n: string }>(
        `select count(*)::text as n from public.refunds where tenant_id = $1`,
        [tenantId],
      );
      // No mirror row.
      expect(countAfter.rows[0].n).toBe(countBefore.rows[0].n);

      const archived = await client.query<{
        c_arch: string | null;
        t_arch: string | null;
      }>(
        `select c.archived_at::text as c_arch, t.archived_at::text as t_arch
           from public.contracts c join public.tenants t on t.id = c.tenant_id
          where c.id = $1`,
        [contractId],
      );
      // Void must NOT restore or un-archive — that is a separate operation.
      expect(archived.rows[0].c_arch).not.toBeNull();
      expect(archived.rows[0].t_arch).not.toBeNull();
    });
  });
});

describe("refunds delete policy", () => {
  test("posted refund delete affects zero rows; draft delete succeeds", async () => {
    await withRollback(async (client) => {
      const { tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const postedId = await seedPostedRefund(client, { tenantId, amount: 80 });
      const draft = await client.query<{ id: string }>(
        `insert into public.refunds (tenant_id, amount, post_action, status)
         values ($1, 40, 'store', 'draft') returning id`,
        [tenantId],
      );
      const draftId = draft.rows[0].id;

      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const deletedPosted = await client.query(
        `delete from public.refunds where id = $1 returning id`,
        [postedId],
      );
      expect(deletedPosted.rows).toHaveLength(0);

      const deletedDraft = await client.query(
        `delete from public.refunds where id = $1 returning id`,
        [draftId],
      );
      expect(deletedDraft.rows).toHaveLength(1);

      await actAsSuperuser(client);
      const stillPosted = await client.query(`select id from public.refunds where id = $1`, [
        postedId,
      ]);
      expect(stillPosted.rows).toHaveLength(1);
      const goneDraft = await client.query(`select id from public.refunds where id = $1`, [
        draftId,
      ]);
      expect(goneDraft.rows).toHaveLength(0);
    });
  });
});

describe("refund code backfill", () => {
  test("every refund has a distinct REF- code; re-running backfill assigns none", async () => {
    await withRollback(async (client) => {
      const { tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await seedPostedRefund(client, { tenantId, amount: 10 });
      await seedPostedRefund(client, { tenantId, amount: 20 });

      const all = await client.query<{ id: string; code: string }>(
        `select id, code from public.refunds order by created_at, id`,
      );
      expect(all.rows.length).toBeGreaterThanOrEqual(2);
      const codes = all.rows.map((r) => r.code);
      for (const code of codes) {
        expect(code).toMatch(/^REF-\d{7}$/);
      }
      expect(new Set(codes).size).toBe(codes.length);

      // Re-run the same backfill UPDATE as migration 85 — it only touches null codes.
      const snapshot = new Map(all.rows.map((r) => [r.id, r.code]));
      await client.query(`
        update public.refunds r
           set code = s.new_code
          from (
            select id,
                   'REF-' || lpad(row_number() over (order by created_at, id)::text, 7, '0') as new_code
              from public.refunds
             where code is null
          ) s
         where r.id = s.id
      `);
      const after = await client.query<{ id: string; code: string }>(
        `select id, code from public.refunds`,
      );
      for (const row of after.rows) {
        expect(row.code).toBe(snapshot.get(row.id));
      }
    });
  });
});

describe("write_off_invoice and dispute", () => {
  test("write_off sets waived and leaves paid unchanged", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 500,
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);
      const inv = await client.query<{
        id: string;
        paid: string;
        balance: string;
        state: string;
        total: string;
      }>(
        `select id, paid::text, balance::text, state::text, total::text
           from public.invoices where contract_id = $1 and balance > 0
           order by period_month limit 1`,
        [contractId],
      );
      expect(inv.rows.length).toBe(1);
      const invoiceId = inv.rows[0].id;
      const paidBefore = Number(inv.rows[0].paid);
      const balanceBefore = Number(inv.rows[0].balance);

      // Partial payment so paid > 0 — the normal write-off case.
      const pay = await client.query<{ id: string }>(
        `insert into public.payments (tenant_id, amount, method, status, payment_date)
         values ($1, 100, 'cash', 'confirmed', '2026-03-01') returning id`,
        [tenantId],
      );
      await client.query(`select * from public.apply_payment_allocation($1, $2::jsonb)`, [
        pay.rows[0].id,
        JSON.stringify([{ invoice_id: invoiceId, amount: 100 }]),
      ]);

      const mid = await client.query<{ paid: string; balance: string; state: string }>(
        `select paid::text, balance::text, state::text from public.invoices where id = $1`,
        [invoiceId],
      );
      expect(Number(mid.rows[0].paid)).toBe(paidBefore + 100);
      const paidAfterPartial = Number(mid.rows[0].paid);
      const balanceAfterPartial = Number(mid.rows[0].balance);
      expect(balanceAfterPartial).toBe(balanceBefore - 100);

      await client.query(`select public.write_off_invoice($1, 'uncollectible')`, [invoiceId]);

      const after = await client.query<{
        paid: string;
        balance: string;
        state: string;
      }>(`select paid::text, balance::text, state::text from public.invoices where id = $1`, [
        invoiceId,
      ]);
      expect(after.rows[0].state).toBe("waived");
      // paid UNCHANGED — balance still shows the written-off amount.
      expect(Number(after.rows[0].paid)).toBe(paidAfterPartial);
      expect(Number(after.rows[0].balance)).toBe(balanceAfterPartial);
      expect(Number(after.rows[0].balance)).toBeGreaterThan(0);
    });
  });

  test("a waived invoice rejects a later allocation", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);
      const inv = await client.query<{ id: string }>(
        `select id from public.invoices where contract_id = $1 and balance > 0
         order by period_month limit 1`,
        [contractId],
      );
      const invoiceId = inv.rows[0].id;
      await client.query(`select public.write_off_invoice($1, 'bad debt')`, [invoiceId]);

      const pay = await client.query<{ id: string }>(
        `insert into public.payments (tenant_id, amount, method, status, payment_date)
         values ($1, 50, 'cash', 'confirmed', '2026-03-01') returning id`,
        [tenantId],
      );
      expect(
        await captureRaise(client, () =>
          client.query(`select * from public.apply_payment_allocation($1, $2::jsonb)`, [
            pay.rows[0].id,
            JSON.stringify([{ invoice_id: invoiceId, amount: 50 }]),
          ]),
        ),
      ).toMatch(/Cancelled or waived invoices cannot receive allocations/i);
    });
  });

  test("set_invoice_dispute leaves state and balance unchanged; allocation still accepted", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);
      const inv = await client.query<{
        id: string;
        paid: string;
        balance: string;
        state: string;
      }>(
        `select id, paid::text, balance::text, state::text
           from public.invoices where contract_id = $1 and balance > 0
           order by period_month limit 1`,
        [contractId],
      );
      const invoiceId = inv.rows[0].id;
      const stateBefore = inv.rows[0].state;
      const balanceBefore = Number(inv.rows[0].balance);
      const paidBefore = Number(inv.rows[0].paid);

      await client.query(`select public.set_invoice_dispute($1, 'tenant disputes water charge')`, [
        invoiceId,
      ]);

      const afterDispute = await client.query<{
        paid: string;
        balance: string;
        state: string;
        disputed_at: string | null;
      }>(
        `select paid::text, balance::text, state::text, disputed_at::text
           from public.invoices where id = $1`,
        [invoiceId],
      );
      expect(afterDispute.rows[0].state).toBe(stateBefore);
      expect(Number(afterDispute.rows[0].balance)).toBe(balanceBefore);
      expect(Number(afterDispute.rows[0].paid)).toBe(paidBefore);
      expect(afterDispute.rows[0].disputed_at).not.toBeNull();

      const pay = await client.query<{ id: string }>(
        `insert into public.payments (tenant_id, amount, method, status, payment_date)
         values ($1, 50, 'cash', 'confirmed', '2026-03-01') returning id`,
        [tenantId],
      );
      const alloc = await client.query(
        `select * from public.apply_payment_allocation($1, $2::jsonb)`,
        [pay.rows[0].id, JSON.stringify([{ invoice_id: invoiceId, amount: 50 }])],
      );
      expect(alloc.rows.length).toBe(1);

      const afterAlloc = await client.query<{ paid: string; disputed_at: string | null }>(
        `select paid::text, disputed_at::text from public.invoices where id = $1`,
        [invoiceId],
      );
      expect(Number(afterAlloc.rows[0].paid)).toBe(paidBefore + 50);
      expect(afterAlloc.rows[0].disputed_at).not.toBeNull();
    });
  });
});
