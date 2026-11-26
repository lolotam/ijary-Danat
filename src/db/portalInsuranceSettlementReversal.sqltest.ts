import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";
import { actAs, actAsSuperuser, closePool, withRollback } from "@/db/testDb";
import { arrangeHeldDeposit, insuranceTotal } from "@/db/portalInsuranceFixtures";

afterAll(closePool);

/** ينشئ فاتورة حقيقية لتسوية التأمين عبر محرّك الإغلاق نفسه. */
async function settleFromInsurance(
  client: PoolClient,
  input: {
    fixture: Awaited<ReturnType<typeof arrangeHeldDeposit>>;
    amount: number;
    month: number;
    outcome: "freeze" | "keep_terminated";
  },
): Promise<string> {
  const { fixture, amount, month, outcome } = input;
  const invoice = await client.query<{ id: string }>(
    `insert into public.invoices
       (company_id, contract_id, tenant_id, unit_id, period_year, period_month,
        issue_date, due_date, subtotal, discount, total, paid, state, idempotency_key)
     values ($1, $2, $3, $4, 2026, $5, '2026-01-01', '2026-01-05', $6, 0, $6, 0, 'due', $7)
     returning id`,
    [
      fixture.companyId,
      fixture.contractId,
      fixture.tenantId,
      fixture.unitId,
      month,
      amount,
      randomUUID(),
    ],
  );
  await actAs(client, "authenticated", fixture.actorId);
  const closeout = await client.query<{ result: { settlement_payment_id: string } }>(
    `select public.close_out_contract($1, '2026-06-15', $2, 'terminated', false,
      '[]'::jsonb, $3::jsonb, 0, 'retained remainder', $4, null) as result`,
    [
      fixture.contractId,
      outcome,
      JSON.stringify([{ invoice_id: invoice.rows[0].id, action: "settle_from_deposit", amount }]),
      randomUUID(),
    ],
  );
  return closeout.rows[0].result.settlement_payment_id;
}

describe("reversing real close-out settlement payments restores held insurance", () => {
  test("a renamed payment and contract retain the original settlement identity", async () => {
    await withRollback(async (client) => {
      const fixture = await arrangeHeldDeposit(client, 1000);
      const paymentId = await settleFromInsurance(client, {
        fixture,
        amount: 250,
        month: 1,
        outcome: "keep_terminated",
      });
      expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(750);
      await client.query("update public.payments set reference = 'edited by staff' where id = $1", [
        paymentId,
      ]);
      await client.query("update public.contracts set code = $2 where id = $1", [
        fixture.contractId,
        "renamed-" + randomUUID(),
      ]);
      await client.query("select * from public.reverse_payment($1, 'settlement returned')", [
        paymentId,
      ]);
      expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(1000);
    });
  });

  test("reversing one of two close-outs restores only that settlement", async () => {
    await withRollback(async (client) => {
      const fixture = await arrangeHeldDeposit(client, 1000);
      const first = await settleFromInsurance(client, {
        fixture,
        amount: 250,
        month: 1,
        outcome: "freeze",
      });
      const second = await settleFromInsurance(client, {
        fixture,
        amount: 150,
        month: 2,
        outcome: "keep_terminated",
      });
      expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(600);
      await client.query("select * from public.reverse_payment($1, 'first returned')", [first]);
      expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(850);
      await client.query("select * from public.reverse_payment($1, 'second returned')", [second]);
      expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(1000);
    });
  });
  test("the migration links a unique legacy settlement before it can be reversed", async () => {
    await withRollback(async (client) => {
      const fixture = await arrangeHeldDeposit(client, 1000);
      const paymentId = await settleFromInsurance(client, {
        fixture,
        amount: 250,
        month: 1,
        outcome: "keep_terminated",
      });
      await client.query(
        "update public.contract_closeouts set result = result - 'settlement_payment_id' where contract_id = $1",
        [fixture.contractId],
      );
      await actAsSuperuser(client);
      // Keep the migration inside withRollback so replay cannot commit test fixtures.
      const migration = readFileSync(
        resolve(process.cwd(), "db/migrations/216_portal_reads_its_own_insurance.sql"),
        "utf8",
      )
        .replace(/^begin;$/m, "")
        .replace(/^commit;$/m, "");
      await client.query(migration);
      const linked = await client.query(
        "select result ->> 'settlement_payment_id' as id from public.contract_closeouts where contract_id = $1",
        [fixture.contractId],
      );
      expect(linked.rows[0].id).toBe(paymentId);
      await actAs(client, "authenticated", fixture.actorId);
      await client.query("select * from public.reverse_payment($1, 'legacy settlement returned')", [
        paymentId,
      ]);
      expect(await insuranceTotal(client, fixture.tenantId, fixture.contractId)).toBe(1000);
    });
  });
});
