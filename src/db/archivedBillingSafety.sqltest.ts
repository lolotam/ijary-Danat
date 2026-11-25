import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { captureRaise, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * T-billing-safety — archived contracts must not be billable.
 *
 * Proves migration 82 end-to-end against a real Postgres. The two assertions
 * that would pass against a generator-only guard and fail here are:
 *   * reapply raises AND pre-existing invoices still exist (delete-before-guard);
 *   * regenerate raises AND no invoice total/state changed (Pass 1 mutates first).
 */

const REPAIR_SQL = `
  update public.contracts c
     set state = 'terminated'
   where c.archived_at is not null
     and c.state in ('draft', 'active', 'frozen', 'suspended')
`;

async function archiveContract(client: PoolClient, contractId: string) {
  await client.query(`update public.contracts set archived_at = now() where id = $1`, [contractId]);
}

async function invoiceSnapshot(client: PoolClient, contractId: string) {
  const { rows } = await client.query<{
    id: string;
    total: string;
    state: string;
    paid: string;
  }>(
    `select id, total::text, state::text, paid::text
       from public.invoices where contract_id = $1
      order by period_year, period_month, id`,
    [contractId],
  );
  return rows;
}

async function expectRaisesArchived(client: PoolClient, sql: string, contractId: string) {
  expect(await captureRaise(client, () => client.query(sql, [contractId]))).toMatch(
    /archived and cannot be billed/i,
  );
}

describe("archived contracts are not billable", () => {
  test("portfolio generate_invoices skips archived contracts", async () => {
    await withRollback(async (client) => {
      const live = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const archived = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await archiveContract(client, archived.contractId);

      const { rows } = await client.query<{ contract_id: string }>(
        `select contract_id from public.generate_invoices(null, 2026)`,
      );
      const createdFor = new Set(rows.map((r) => r.contract_id));

      expect(createdFor.has(live.contractId)).toBe(true);
      expect(createdFor.has(archived.contractId)).toBe(false);

      const archivedCount = await client.query(
        `select count(*)::int as n from public.invoices where contract_id = $1`,
        [archived.contractId],
      );
      expect(archivedCount.rows[0].n).toBe(0);
    });
  });

  test("generate_invoices_for_year(archived, year, true) raises", async () => {
    // Headline hole: p_include_past=true AND p_contract_id set fully bypasses
    // the state='active' predicate. Without the early guard this would bill.
    await withRollback(async (client) => {
      const { contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await archiveContract(client, contractId);
      await expectRaisesArchived(
        client,
        `select * from public.generate_invoices_for_year($1, 2026, true)`,
        contractId,
      );
    });
  });

  test("backfill_contract_invoices(archived) raises", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await archiveContract(client, contractId);
      await expectRaisesArchived(
        client,
        `select * from public.backfill_contract_invoices($1)`,
        contractId,
      );
    });
  });

  test("reapply raises and leaves pre-existing invoices intact", async () => {
    // The delete-before-guard bug: a raise-only assertion would pass against a
    // guard placed after `delete from public.invoices`.
    await withRollback(async (client) => {
      const { contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-06-30",
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);
      const before = await invoiceSnapshot(client, contractId);
      expect(before.length).toBeGreaterThan(0);

      await archiveContract(client, contractId);
      await expectRaisesArchived(
        client,
        `select * from public.reapply_contract_invoices($1)`,
        contractId,
      );

      const after = await invoiceSnapshot(client, contractId);
      expect(after).toHaveLength(before.length);
      expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    });
  });

  test("regenerate raises and mutates no invoice total or state", async () => {
    // Pass 1 updates totals/state in place without entering the generator.
    await withRollback(async (client) => {
      const { contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-06-30",
        monthlyAmount: 500,
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);
      const before = await invoiceSnapshot(client, contractId);
      expect(before.length).toBeGreaterThan(0);

      // If Pass 1 ran after archive, this amount change would rewrite totals.
      await client.query(
        `update public.contract_units set monthly_amount = 999 where contract_id = $1`,
        [contractId],
      );
      await archiveContract(client, contractId);

      await expectRaisesArchived(
        client,
        `select * from public.regenerate_contract_invoices($1)`,
        contractId,
      );

      const after = await invoiceSnapshot(client, contractId);
      expect(after).toEqual(before);
    });
  });

  test("evaluate_overdue skips archived contracts and flips live ones", async () => {
    await withRollback(async (client) => {
      const live = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        graceDays: 0,
      });
      const archived = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        graceDays: 0,
      });

      // Insert past-due invoices directly so we control state without relying
      // on generate+evaluate ordering.
      for (const fx of [live, archived]) {
        await client.query(
          `insert into public.invoices (
             code, company_id, contract_id, tenant_id, unit_id,
             period_year, period_month, issue_date, due_date,
             subtotal, discount, total, paid, state, is_visible_to_tenant,
             idempotency_key
           )
           values (
             'INV-test-' || substr($1::text, 1, 8),
             $2::uuid, $1::uuid, $3::uuid, $4::uuid,
             2026, 1, '2026-01-01', '2026-01-01',
             500, 0, 500, 0, 'due', true,
             $1::text || ':2026:1'
           )`,
          [fx.contractId, fx.companyId, fx.tenantId, fx.unitId],
        );
      }
      await archiveContract(client, archived.contractId);

      await client.query(`select * from public.evaluate_overdue('2026-08-01')`);

      const liveState = await client.query<{ state: string }>(
        `select state::text as state from public.invoices where contract_id = $1`,
        [live.contractId],
      );
      const archivedState = await client.query<{ state: string }>(
        `select state::text as state from public.invoices where contract_id = $1`,
        [archived.contractId],
      );
      expect(liveState.rows[0].state).toBe("overdue");
      expect(archivedState.rows[0].state).toBe("due");
    });
  });

  test("identify_contract_expiry_reminders omits archived contracts", async () => {
    await withRollback(async (client) => {
      // as_of = 2026-08-01; end_date 30 days later → 30d milestone.
      const live = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-08-31",
      });
      const archived = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-08-31",
      });
      await archiveContract(client, archived.contractId);

      const { rows } = await client.query<{ contract_id: string }>(
        `select contract_id from public.identify_contract_expiry_reminders('2026-08-01')
          where contract_id = any($1::uuid[])`,
        [[live.contractId, archived.contractId]],
      );
      const ids = new Set(rows.map((r) => r.contract_id));
      expect(ids.has(live.contractId)).toBe(true);
      expect(ids.has(archived.contractId)).toBe(false);
    });
  });

  test("repair statement is idempotent on a second run", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await archiveContract(client, contractId);

      const first = await client.query(REPAIR_SQL);
      expect(first.rowCount).toBeGreaterThan(0);

      const second = await client.query(REPAIR_SQL);
      expect(second.rowCount).toBe(0);
    });
  });

  test("repair leaves the unit vacant via the contract trigger only", async () => {
    await withRollback(async (client) => {
      const { contractId, unitId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      // Active insert already occupies the unit; archive alone may also free it
      // (trigger fires on archived_at). Repair terminates state — either path
      // must end vacant without this migration writing units.
      await archiveContract(client, contractId);
      await client.query(REPAIR_SQL);

      const unit = await client.query<{ status: string }>(
        `select status::text as status from public.units where id = $1`,
        [unitId],
      );
      expect(unit.rows[0].status).toBe("vacant");

      const state = await client.query<{ state: string }>(
        `select state::text as state from public.contracts where id = $1`,
        [contractId],
      );
      expect(state.rows[0].state).toBe("terminated");
    });
  });

  test("repair alters no invoice, payment, allocation or receipt", async () => {
    await withRollback(async (client) => {
      const { contractId, tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-06-30",
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);

      const { rows: invRows } = await client.query<{ id: string }>(
        `select id from public.invoices where contract_id = $1 limit 1`,
        [contractId],
      );
      const invoiceId = invRows[0].id;

      const { rows: payRows } = await client.query<{ id: string }>(
        `insert into public.payments (tenant_id, amount, method, status, payment_date)
         values ($1, 100, 'cash', 'confirmed', '2026-03-01') returning id`,
        [tenantId],
      );
      const paymentId = payRows[0].id;

      await client.query(
        `insert into public.payment_allocations (payment_id, invoice_id, amount)
         values ($1, $2, 100)`,
        [paymentId, invoiceId],
      );
      // sync_payment_receipt already creates a receipts row on confirmed payment
      // insert — do not insert a second one (receipts_payment_id_key).

      const snapshot = async () => {
        const invoices = await client.query(
          `select id, total::text, state::text, paid::text from public.invoices
            where contract_id = $1 order by id`,
          [contractId],
        );
        const payments = await client.query(
          `select id, amount::text, status::text from public.payments
            where tenant_id = $1 order by id`,
          [tenantId],
        );
        const allocations = await client.query(
          `select payment_id, invoice_id, amount::text from public.payment_allocations
            where payment_id = $1 order by invoice_id`,
          [paymentId],
        );
        const receipts = await client.query(
          `select id, payment_id, amount::text from public.receipts
            where tenant_id = $1 order by id`,
          [tenantId],
        );
        return {
          invoices: invoices.rows,
          payments: payments.rows,
          allocations: allocations.rows,
          receipts: receipts.rows,
        };
      };

      const before = await snapshot();
      await archiveContract(client, contractId);
      await client.query(REPAIR_SQL);
      const after = await snapshot();

      expect(after).toEqual(before);
    });
  });
});
