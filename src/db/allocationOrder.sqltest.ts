import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import {
  actAs,
  actAsSuperuser,
  captureRaise,
  closePool,
  seedCompanyUser,
  seedContract,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/**
 * "سداد الأقدم أولاً" داخل apply_payment_allocation نفسها (migration 217).
 *
 * Codex review on PR #220. The rule lived only in the `applyAllocation` server
 * fn, but the RPC is granted to `authenticated`, so a caller with
 * `payments.create` could go straight through PostgREST and settle March while
 * January stayed open. The RPC now refuses that for `authenticated` callers and
 * deliberately does NOT for `service_role` — the MyFatoorah webhook and the
 * reconcile cron run as service_role, and refusing there would strand gateway
 * money the tenant has already paid.
 *
 * Every call below goes to the RPC directly, because the bypass is the scenario.
 */

/** ينشئ مستخدمًا بدور محدد ضمن الشركة في auth.users و user_roles. */
async function seedUserWithRole(
  client: PoolClient,
  companyId: string,
  role: string,
): Promise<string> {
  return seedCompanyUser(client, companyId, role, "alloc");
}

type MonthInvoice = { id: string; total: number };

/** يولّد فواتير العقد ويرجعها مرتبة من الأقدم إلى الأحدث. */
async function invoicesOldestFirst(
  client: PoolClient,
  contractId: string,
): Promise<MonthInvoice[]> {
  await client.query(`select public.generate_invoices($1::uuid, 2026)`, [contractId]);
  const { rows } = await client.query<{ id: string; total: string }>(
    `select id, total from public.invoices where contract_id = $1
      order by period_year, period_month, code`,
    [contractId],
  );
  return rows.map((row) => ({ id: row.id, total: Number(row.total) }));
}

/** دفعة مؤكّدة غير مخصّصة للمستأجر بالمبلغ المعطى ضمن الشركة. */
async function seedPayment(
  client: PoolClient,
  companyId: string,
  tenantId: string,
  amount: number,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.payments (company_id, code, tenant_id, method, amount, payment_date, status)
     values ($1, public.next_payment_code(), $2, 'cash', $3, current_date, 'confirmed')
     returning id`,
    [companyId, tenantId, amount],
  );
  return rows[0].id;
}

/** يستدعي دالة التخصيص مباشرةً بالتوزيع المعطى. */
function allocate(
  client: PoolClient,
  paymentId: string,
  allocations: Array<{ invoice_id: string; amount: number }>,
) {
  return client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
    paymentId,
    JSON.stringify(allocations),
  ]);
}

/** عقد بشهرين مفتوحين على الأقل، ودفعة تكفي لهما، ومستخدم يملك payments.create. */
async function seedTwoOpenMonths(client: PoolClient) {
  const fixture = await seedContract(client, {
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    monthlyAmount: 300,
  });
  const invoices = await invoicesOldestFirst(client, fixture.contractId);
  expect(invoices.length).toBeGreaterThanOrEqual(2);
  const [january, february] = invoices;
  const paymentId = await seedPayment(
    client,
    fixture.companyId,
    fixture.tenantId,
    january.total + february.total,
  );
  const admin = await seedUserWithRole(client, fixture.companyId, "admin");
  return { ...fixture, january, february, paymentId, admin };
}

describe("apply_payment_allocation enforces oldest-first for direct callers (migration 217)", () => {
  test("an authenticated caller paying February while January is open is refused", async () => {
    await withRollback(async (client) => {
      const f = await seedTwoOpenMonths(client);

      await actAs(client, "authenticated", f.admin);
      const raised = await captureRaise(client, () =>
        allocate(client, f.paymentId, [{ invoice_id: f.february.id, amount: f.february.total }]),
      );
      await actAsSuperuser(client);

      expect(raised).toMatch(/Settle the oldest open invoice first/);
      // Refused means nothing moved: no allocation row, February still unpaid.
      const { rows } = await client.query(
        `select 1 from public.payment_allocations where payment_id = $1`,
        [f.paymentId],
      );
      expect(rows).toHaveLength(0);
    });
  });

  test("an authenticated caller paying January and February together succeeds", async () => {
    await withRollback(async (client) => {
      const f = await seedTwoOpenMonths(client);

      // January is cleared by this same call, so it no longer blocks February.
      await actAs(client, "authenticated", f.admin);
      const raised = await captureRaise(client, () =>
        allocate(client, f.paymentId, [
          { invoice_id: f.february.id, amount: f.february.total },
          { invoice_id: f.january.id, amount: f.january.total },
        ]),
      );
      await actAsSuperuser(client);

      expect(raised).toBeNull();
      const { rows } = await client.query<{ state: string }>(
        `select state from public.invoices where id = any($1::uuid[])`,
        [[f.january.id, f.february.id]],
      );
      expect(rows.map((row) => row.state)).toEqual(["paid", "paid"]);
    });
  });

  test("a partial payment of January does not clear it, so February is still refused", async () => {
    await withRollback(async (client) => {
      const f = await seedTwoOpenMonths(client);

      await actAs(client, "authenticated", f.admin);
      const raised = await captureRaise(client, () =>
        allocate(client, f.paymentId, [
          { invoice_id: f.january.id, amount: f.january.total - 1 },
          { invoice_id: f.february.id, amount: f.february.total },
        ]),
      );
      await actAsSuperuser(client);

      expect(raised).toMatch(/Settle the oldest open invoice first/);
    });
  });

  test("service_role may settle out of order, so the gateway never strands money", async () => {
    await withRollback(async (client) => {
      const f = await seedTwoOpenMonths(client);

      await actAs(client, "service_role");
      const raised = await captureRaise(client, () =>
        allocate(client, f.paymentId, [{ invoice_id: f.february.id, amount: f.february.total }]),
      );
      await actAsSuperuser(client);

      expect(raised).toBeNull();
      const { rows } = await client.query<{ state: string }>(
        `select state from public.invoices where id = $1`,
        [f.february.id],
      );
      expect(rows[0].state).toBe("paid");
    });
  });

  test("each contract is judged against its own arrears, not the other's", async () => {
    await withRollback(async (client) => {
      const a = await seedTwoOpenMonths(client);
      // A second contract for the SAME tenant, so one payment can span both.
      const b = await seedContract(client, {
        companyId: a.companyId,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 200,
      });
      await client.query(`update public.contracts set tenant_id = $1 where id = $2`, [
        a.tenantId,
        b.contractId,
      ]);
      const [bJanuary] = await invoicesOldestFirst(client, b.contractId);
      const paymentId = await seedPayment(
        client,
        a.companyId,
        a.tenantId,
        a.january.total + bJanuary.total,
      );

      // Contract A's January and contract B's January: each is the oldest open
      // invoice on its own contract. A's open February must not block B.
      await actAs(client, "authenticated", a.admin);
      const raised = await captureRaise(client, () =>
        allocate(client, paymentId, [
          { invoice_id: a.january.id, amount: a.january.total },
          { invoice_id: bJanuary.id, amount: bJanuary.total },
        ]),
      );
      await actAsSuperuser(client);

      expect(raised).toBeNull();
    });
  });
});
