import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * حدّ السماح الافتراضي يوم واحد (قرار المالك 2026-10-20).
 *
 * The overdue rule itself did not change: `(due_date + grace_days) < as_of`
 * still decides, so an invoice due on day D stays `due` on D+1 and only
 * becomes `overdue` on D+2. What moved is the default of
 * `contracts.grace_days` — from 0 to 1, for new contracts AND for existing
 * ones (migration 249).
 *
 * Three things are pinned here, because a day boundary hides them:
 *   * a contract inserted WITHOUT a grace_days value takes the column default;
 *   * a one-day grace keeps the invoice due for one more day than zero would;
 *   * a contract that was explicitly given zero keeps its own zero.
 */

interface InvoiceFixture {
  contractId: string;
  companyId: string;
  tenantId: string;
  unitId: string;
}

/**
 * تُدخل فاتورة مستحقة في تاريخ محدّد، بحالة `due` كما تُنشأ في الفوترة.
 *
 * Direct insert rather than generate_invoices: the question is what
 * `evaluate_overdue` does with `due_date + grace_days`, and a hand-built row
 * states the inputs outright instead of depending on generation ordering.
 */
async function insertInvoiceDueOn(
  client: PoolClient,
  fx: InvoiceFixture,
  dueDate: string,
  periodMonth: number,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.invoices (
       code, company_id, contract_id, tenant_id, unit_id,
       period_year, period_month, issue_date, due_date,
       subtotal, discount, total, paid, state, is_visible_to_tenant,
       idempotency_key
     )
     values (
       'INV-grace-' || substr(gen_random_uuid()::text, 1, 8),
       $2::uuid, $1::uuid, $3::uuid, $4::uuid,
       2026, $5, $6::date, $6::date,
       500, 0, 500, 0, 'due', true,
       $1::text || ':grace:' || substr(gen_random_uuid()::text, 1, 8)
     )
     returning id`,
    [fx.contractId, fx.companyId, fx.tenantId, fx.unitId, periodMonth, dueDate],
  );
  return rows[0].id;
}

/**
 * حالة الفاتورة كما تسجّلها قاعدة البيانات.
 */
async function invoiceState(client: PoolClient, invoiceId: string): Promise<string> {
  const { rows } = await client.query<{ state: string }>(
    `select state::text as state from public.invoices where id = $1`,
    [invoiceId],
  );
  return rows[0].state;
}

/**
 * تُدخل فاتورة متأخرة بالفعل، مستحقة من `daysAgo` أيام، كما تتركها مهلة الصفر.
 *
 * Dates are relative to `current_date` because the sweep under test compares
 * against `current_date`, not a passed-in date.
 */
async function insertOverdueInvoice(
  client: PoolClient,
  fx: InvoiceFixture,
  daysAgo: number,
  paid: number,
  periodMonth: number,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.invoices (
       code, company_id, contract_id, tenant_id, unit_id,
       period_year, period_month, issue_date, due_date,
       subtotal, discount, total, paid, state, is_visible_to_tenant,
       idempotency_key
     )
     values (
       'INV-sweep-' || substr(gen_random_uuid()::text, 1, 8),
       $2::uuid, $1::uuid, $3::uuid, $4::uuid,
       2026, $5, current_date - $6::int, current_date - $6::int,
       500, 0, 500, $7, 'overdue', true,
       $1::text || ':sweep:' || substr(gen_random_uuid()::text, 1, 8)
     )
     returning id`,
    [fx.contractId, fx.companyId, fx.tenantId, fx.unitId, periodMonth, daysAgo, paid],
  );
  return rows[0].id;
}

/**
 * يرجع الـ DO block الخاص بإعادة ضبط مهلة السماح من migration 249 كما هو.
 *
 * A fresh test database has no zero-grace contract when 249 runs, so its sweep
 * returns early and the demotion and audit statements are never planned.
 * Running the block itself here, on seeded rows, is what proves them.
 */
function migrationSweepBlock(): string {
  const file = fileURLToPath(
    new URL("../../db/migrations/249_default_grace_one_day.sql", import.meta.url),
  );
  const sql = readFileSync(file, "utf8");
  const start = sql.indexOf("do $grace$");
  const end = sql.indexOf("$grace$;", start + "do $grace$".length);
  if (start < 0 || end < 0) throw new Error("migration 249 no longer has its $grace$ block");
  return sql.slice(start, end + "$grace$;".length);
}

/**
 * يشغّل `evaluate_overdue` بتاريخ محدّد كما تفعل المهمة الليلية.
 */
async function evaluateOverdueAsOf(client: PoolClient, asOf: string): Promise<void> {
  await client.query(`select * from public.evaluate_overdue($1::date)`, [asOf]);
}

describe("the one-day grace boundary (migration 249)", () => {
  test("a contract inserted without a grace_days value takes the one-day default", async () => {
    await withRollback(async (client) => {
      const { tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      // No grace_days in the column list on purpose: the column default is
      // what is under test here.
      const { rows } = await client.query<{ grace_days: number }>(
        `insert into public.contracts (tenant_id, start_date, end_date, due_day, deposit, state)
         values ($1, '2026-01-01'::date, '2026-12-31'::date, 1, 0, 'active'::public.contract_states)
         returning grace_days`,
        [tenantId],
      );

      expect(rows[0].grace_days).toBe(1);
    });
  });

  test("a one-day grace keeps the invoice due on D+1 and flips it on D+2", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        graceDays: 1,
      });
      const invoiceId = await insertInvoiceDueOn(client, fx, "2026-08-01", 8);

      await evaluateOverdueAsOf(client, "2026-08-01");
      expect(await invoiceState(client, invoiceId)).toBe("due");

      // due_date + grace_days is 2026-08-02, and the rule is strict `<`.
      await evaluateOverdueAsOf(client, "2026-08-02");
      expect(await invoiceState(client, invoiceId)).toBe("due");

      await evaluateOverdueAsOf(client, "2026-08-03");
      expect(await invoiceState(client, invoiceId)).toBe("overdue");
    });
  });

  test("the migration's sweep demotes only invoices still inside the new grace day", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        graceDays: 0,
      });
      const dueYesterdayUnpaid = await insertOverdueInvoice(client, fx, 1, 0, 3);
      const dueYesterdayPartial = await insertOverdueInvoice(client, fx, 1, 100, 4);
      const dueThreeDaysAgo = await insertOverdueInvoice(client, fx, 3, 0, 5);
      // A contract the sweep does not move: its invoice matches the date rule
      // but must stay as it is, because only moved contracts are reclassified.
      const untouched = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        graceDays: 1,
      });
      const otherContractInvoice = await insertOverdueInvoice(client, untouched, 1, 0, 3);

      await client.query(migrationSweepBlock());

      expect(await invoiceState(client, dueYesterdayUnpaid)).toBe("due");
      expect(await invoiceState(client, dueYesterdayPartial)).toBe("partially_paid");
      expect(await invoiceState(client, dueThreeDaysAgo)).toBe("overdue");
      expect(await invoiceState(client, otherContractInvoice)).toBe("overdue");

      const { rows } = await client.query<{
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      }>(
        `select before, after from public.audit_logs
          where action = 'contracts.grace_days_default'
          order by created_at desc limit 1`,
      );
      expect(rows[0].before.contract_ids).toContain(fx.contractId);
      expect(rows[0].after.invoices_back_to_due).toEqual(
        expect.arrayContaining([dueYesterdayUnpaid, dueYesterdayPartial]),
      );
      expect(rows[0].after.invoices_back_to_due).not.toContain(dueThreeDaysAgo);
      expect(rows[0].after.invoices_back_to_due).not.toContain(otherContractInvoice);
      expect(rows[0].before.contract_ids).not.toContain(untouched.contractId);
    });
  });

  test("a contract explicitly given zero keeps its own zero", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        graceDays: 0,
      });
      const invoiceId = await insertInvoiceDueOn(client, fx, "2026-08-01", 8);

      // With zero grace, the day after the due date is already overdue.
      await evaluateOverdueAsOf(client, "2026-08-02");

      expect(await invoiceState(client, invoiceId)).toBe("overdue");
    });
  });
});
