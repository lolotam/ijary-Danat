import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import {
  actAs,
  actAsSuperuser,
  closePool,
  seedCompanyUser,
  seedContract,
  withRollback,
} from "@/db/testDb";
import { actAsCompanyService, setCompanyStatus } from "@/db/isolation/twoCompanies";

afterAll(closePool);

/** شركة معلَّقة مع مستخدم إداري واشتراك محفوظ وفاتورة جاهزة للسداد. */
async function suspendedFixture(client: PoolClient) {
  const contract = await seedContract(client, {
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    monthlyAmount: 500,
  });
  await client.query(`select public.generate_invoices($1::uuid, 2026)`, [contract.contractId]);
  const invoice = await client.query<{ id: string }>(
    `select id from public.invoices where contract_id = $1 order by period_year, period_month limit 1`,
    [contract.contractId],
  );

  const userId = await seedCompanyUser(client, contract.companyId, "admin", "suspended");
  await client.query(
    `insert into public.company_subscriptions
       (company_id, plan_name, price, period_start, renewal_date, status)
     values ($1, 'Business', 100, '2026-01-01', '2026-12-11', 'active')`,
    [contract.companyId],
  );
  await actAsSuperuser(client);
  await setCompanyStatus(client, contract.companyId, "suspended", "SQL test suspension");

  return { ...contract, userId, invoiceId: invoice.rows[0].id };
}

describe("suspension locks staff out and leaves settlement reachable (T114)", () => {
  test("a suspended company's staff read no company or subscription row", async () => {
    await withRollback(async (client) => {
      const fx = await suspendedFixture(client);
      await actAs(client, "authenticated", fx.userId);

      const context = await client.query<{ cid: string | null }>(
        `select public.current_company_id() as cid`,
      );
      expect(context.rows[0].cid).toBeNull();

      const properties = await client.query<{ total: number }>(
        `select count(*)::int as total from public.properties`,
      );
      const subscriptions = await client.query<{ total: number }>(
        `select count(*)::int as total from public.company_subscriptions`,
      );
      expect(properties.rows[0].total).toBe(0);
      expect(subscriptions.rows[0].total).toBe(0);
    });
  });

  test("a suspended company blocks settlement unless the client carries allow_suspended", async () => {
    await withRollback(async (client) => {
      const fx = await suspendedFixture(client);

      await actAsCompanyService(client, fx.companyId);
      const blocked = await client.query<{ cid: string | null }>(
        `select public.current_company_id() as cid`,
      );
      expect(blocked.rows[0].cid).toBeNull();

      await actAsCompanyService(client, fx.companyId, { allowSuspended: true });
      const settled = await client.query<{ id: string }>(
        `insert into public.partial_payments
           (company_id, tenant_id, contract_id, invoice_id, amount, paid_date)
         values ($1, $2, $3, $4, 200, '2026-11-27')
         returning id`,
        [fx.companyId, fx.tenantId, fx.contractId, fx.invoiceId],
      );
      const payments = await client.query<{ amount: string; status: string }>(
        `select amount, status from public.payments where source_partial_payment_id = $1`,
        [settled.rows[0].id],
      );

      expect(payments.rows).toHaveLength(1);
      expect(Number(payments.rows[0].amount)).toBe(200);
      expect(payments.rows[0].status).toBe("confirmed");
    });
  });

  test("reactivating the company restores its staff's access", async () => {
    await withRollback(async (client) => {
      const fx = await suspendedFixture(client);
      await actAsSuperuser(client);
      await setCompanyStatus(client, fx.companyId, "active");
      await actAs(client, "authenticated", fx.userId);

      const context = await client.query<{ cid: string | null }>(
        `select public.current_company_id() as cid`,
      );
      expect(context.rows[0].cid).toBe(fx.companyId);

      const properties = await client.query<{ total: number }>(
        `select count(*)::int as total from public.properties`,
      );
      const subscriptions = await client.query<{ total: number }>(
        `select count(*)::int as total from public.company_subscriptions`,
      );
      expect(properties.rows[0].total).toBeGreaterThan(0);
      expect(subscriptions.rows[0].total).toBe(1);
    });
  });
});
