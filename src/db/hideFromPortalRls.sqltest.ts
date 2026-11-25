import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";

import { actAs, actAsSuperuser, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

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

/** يُدخل فاتورة مستحقة مرئية للمستأجر على عقد بعينه. */
async function insertVisibleInvoice(
  client: PoolClient,
  input: { contractId: string; companyId: string; tenantId: string; unitId: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.invoices (
       code, company_id, contract_id, tenant_id, unit_id,
       period_year, period_month, issue_date, due_date,
       subtotal, discount, total, paid, state, is_visible_to_tenant, idempotency_key
     )
     values (
       'INV-rls-' || substr(gen_random_uuid()::text, 1, 8),
       $2::uuid, $1::uuid, $3::uuid, $4::uuid,
       2026, 1, '2026-01-01'::date, '2026-01-01'::date,
       500, 0, 500, 0, 'due', true,
       $1::text || ':rls:' || substr(gen_random_uuid()::text, 1, 8)
     )
     returning id`,
    [input.contractId, input.companyId, input.tenantId, input.unitId],
  );
  return rows[0].id;
}

/**
 * Migration 212. Migration 210 filtered `hide_from_portal` in the portal's
 * React Query hooks and enforced it inside `evaluate_portal_payable_invoices`,
 * so a tenant could not *pay* a hidden contract — but nothing stopped them
 * *reading* one straight from PostgREST with their own session. "Completely
 * hidden" has to mean hidden at the row, so the rule lives in RLS.
 */
describe("hide_from_portal is enforced in tenant RLS (migration 212)", () => {
  /** يجهّز مستأجرًا بعقدين: أحدهما مخفي عن البوابة، والآخر ظاهر. */
  async function arrange(client: PoolClient) {
    const base = await seedContract(client, {
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    const hiddenInvoice = await insertVisibleInvoice(client, {
      contractId: base.contractId,
      companyId: base.companyId,
      tenantId: base.tenantId,
      unitId: base.unitId,
    });
    await client.query(`update public.contracts set hide_from_portal = true where id = $1`, [
      base.contractId,
    ]);

    const tenantUser = await seedUserWithRole(client, "tenant");
    await client.query(`update public.profiles set tenant_id = $1 where id = $2`, [
      base.tenantId,
      tenantUser,
    ]);
    return { ...base, hiddenInvoice, tenantUser };
  }

  test("the tenant cannot read a hidden contract through a direct select", async () => {
    await withRollback(async (client) => {
      const fixture = await arrange(client);

      await actAs(client, "authenticated", fixture.tenantUser);
      const { rows } = await client.query<{ id: string }>(
        `select id from public.contracts where id = $1`,
        [fixture.contractId],
      );
      await actAsSuperuser(client);

      expect(rows).toEqual([]);
    });
  });

  test("the tenant cannot read a hidden contract's invoices either", async () => {
    await withRollback(async (client) => {
      const fixture = await arrange(client);

      await actAs(client, "authenticated", fixture.tenantUser);
      const { rows } = await client.query<{ id: string }>(
        `select id from public.invoices where id = $1`,
        [fixture.hiddenInvoice],
      );
      await actAsSuperuser(client);

      expect(rows).toEqual([]);
    });
  });

  // The whole point is that the OTHER contract stays readable — a tenant who
  // rents a shop and a rooftop must still see the shop.
  test("the tenant still reads their visible contract and its invoices", async () => {
    await withRollback(async (client) => {
      const fixture = await arrange(client);
      await client.query(`update public.contracts set hide_from_portal = false where id = $1`, [
        fixture.contractId,
      ]);

      await actAs(client, "authenticated", fixture.tenantUser);
      const contracts = await client.query(`select id from public.contracts where id = $1`, [
        fixture.contractId,
      ]);
      const invoices = await client.query(`select id from public.invoices where id = $1`, [
        fixture.hiddenInvoice,
      ]);
      await actAsSuperuser(client);

      expect(contracts.rows).toHaveLength(1);
      expect(invoices.rows).toHaveLength(1);
    });
  });

  // Admin screens must be unaffected: the flag hides a contract from its
  // tenant, never from the office managing it.
  test("staff read the hidden contract and its invoices exactly as before", async () => {
    await withRollback(async (client) => {
      const fixture = await arrange(client);
      const admin = await seedUserWithRole(client, "admin");

      await actAs(client, "authenticated", admin);
      const contracts = await client.query(`select id from public.contracts where id = $1`, [
        fixture.contractId,
      ]);
      const invoices = await client.query(`select id from public.invoices where id = $1`, [
        fixture.hiddenInvoice,
      ]);
      await actAsSuperuser(client);

      expect(contracts.rows).toHaveLength(1);
      expect(invoices.rows).toHaveLength(1);
    });
  });
});
