import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { actAs, actAsSuperuser, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

type Scenario = Awaited<ReturnType<typeof scenario>>;

/**
 * عقد بفواتير مولّدة، جاهز لاستقبال دفعات جزئية وبوابة.
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
 * ينشئ دفعة جزئية مرتبطة بفاتورة.
 */
async function insertPartial(
  client: PoolClient,
  fx: Scenario,
  options: { amount: number; invoiceId?: string },
): Promise<string> {
  const invoiceId = options.invoiceId ?? fx.invoices[0].id;
  const row = await client.query<{ id: string }>(
    `insert into public.partial_payments
       (company_id, tenant_id, contract_id, invoice_id, amount, paid_date)
     values ($1, $2, $3, $4, $5, '2026-01-10') returning id`,
    [fx.companyId, fx.tenantId, fx.contractId, invoiceId, options.amount],
  );
  return row.rows[0].id;
}

/**
 * مستخدم بدور معيّن، واختياريًا مربوط بمستأجر عبر profiles.
 */
async function seedUser(
  client: PoolClient,
  role: string,
  tenantId: string | null = null,
): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@example.test`],
  );
  await client.query(
    `insert into public.profiles (id, tenant_id) values ($1, $2)
     on conflict (id) do update set tenant_id = excluded.tenant_id`,
    [userId, tenantId],
  );
  await client.query(
    `insert into public.user_roles (user_id, role) values ($1, $2::public.app_role)`,
    [userId, role],
  );
  return userId;
}

/**
 * يستدعي لقطة تفصيل السداد ويعيد jsonb.
 */
async function breakdown(client: PoolClient, invoiceId: string) {
  const row = await client.query<{ get_invoice_payment_breakdown: unknown }>(
    `select public.get_invoice_payment_breakdown($1) as get_invoice_payment_breakdown`,
    [invoiceId],
  );
  return row.rows[0].get_invoice_payment_breakdown as {
    invoice: { paid: string | number; total: string | number; state: string };
    paid_from_allocations: string | number;
    reconciled: boolean;
    groups: Array<{
      source: string;
      method: string;
      amount: string | number;
      payments: number;
    }>;
  } | null;
}

/**
 * يستدعي سياق تعديل الدفعة الجزئية.
 */
async function editContext(client: PoolClient, partialId: string) {
  const row = await client.query<{ get_partial_payment_edit_context: unknown }>(
    `select public.get_partial_payment_edit_context($1) as get_partial_payment_edit_context`,
    [partialId],
  );
  return row.rows[0].get_partial_payment_edit_context as {
    settled: boolean;
    credited_amount: string | number;
    invoice: { id: string; balance: string | number } | null;
  } | null;
}

describe("get_invoice_payment_breakdown", () => {
  test("staff sees groups; the owning tenant sees the same; another tenant gets null", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      await insertPartial(client, fx, { amount: 200 });
      const invoiceId = fx.invoices[0].id;

      const admin = await seedUser(client, "admin");
      await actAs(client, "authenticated", admin);
      const staffView = await breakdown(client, invoiceId);
      expect(staffView).not.toBeNull();
      expect(staffView!.groups).toHaveLength(1);
      expect(staffView!.groups[0].source).toBe("partial");
      expect(staffView!.groups[0].method).toBe("cash");

      await actAsSuperuser(client);
      const owner = await seedUser(client, "tenant", fx.tenantId);
      await actAs(client, "authenticated", owner);
      const ownerView = await breakdown(client, invoiceId);
      expect(ownerView).toEqual(staffView);

      await actAsSuperuser(client);
      const other = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const stranger = await seedUser(client, "tenant", other.tenantId);
      await actAs(client, "authenticated", stranger);
      expect(await breakdown(client, invoiceId)).toBeNull();
    });
  });

  test("a reversed payment contributes nothing and does not count as a method", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoiceId = fx.invoices[0].id;
      const payment = await client.query<{ id: string }>(
        `insert into public.payments
           (code, tenant_id, method, amount, payment_date, status)
         values (public.next_payment_code(), $1, 'knet', 80, current_date, 'confirmed')
         returning id`,
        [fx.tenantId],
      );
      await client.query(
        `insert into public.payment_allocations (payment_id, invoice_id, amount)
         values ($1, $2, 80)`,
        [payment.rows[0].id, invoiceId],
      );
      await client.query(`select public.recompute_invoice_from_confirmed($1)`, [invoiceId]);
      await client.query(`select public.reverse_payment($1, 'test')`, [payment.rows[0].id]);

      const admin = await seedUser(client, "admin");
      await actAs(client, "authenticated", admin);
      const view = await breakdown(client, invoiceId);
      expect(view!.groups).toEqual([]);
      expect(Number(view!.paid_from_allocations)).toBe(0);
    });
  });

  test("split allocations across two payments of the same method form one group", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      await insertPartial(client, fx, { amount: 100 });
      await insertPartial(client, fx, { amount: 150 });

      const admin = await seedUser(client, "admin");
      await actAs(client, "authenticated", admin);
      const view = await breakdown(client, fx.invoices[0].id);
      expect(view!.groups).toHaveLength(1);
      expect(view!.groups[0].source).toBe("partial");
      expect(view!.groups[0].method).toBe("cash");
      expect(Number(view!.groups[0].amount)).toBe(250);
      expect(Number(view!.groups[0].payments)).toBe(2);
    });
  });

  test("a gateway payment inserted without payment_request_id is still labelled gateway", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoiceId = fx.invoices[0].id;
      const request = await client.query<{ id: string; code: string }>(
        `insert into public.payment_requests (tenant_id, amount, requested_invoice_ids)
         values ($1, 500, array[$2]::uuid[]) returning id, code`,
        [fx.tenantId, invoiceId],
      );
      // The old webhook's insert: note carries the request code, no column.
      const payment = await client.query<{ id: string; payment_request_id: string | null }>(
        `insert into public.payments
           (code, tenant_id, method, amount, payment_date, status, note)
         values (public.next_payment_code(), $1, 'knet', 120, current_date, 'confirmed', $2)
         returning id, payment_request_id`,
        [fx.tenantId, `MyFatoorah ${request.rows[0].code} — 1/2026`],
      );
      expect(payment.rows[0].payment_request_id).toBe(request.rows[0].id);
      await client.query(
        `insert into public.payment_allocations (payment_id, invoice_id, amount) values ($1, $2, 120)`,
        [payment.rows[0].id, invoiceId],
      );
      await client.query(`select public.recompute_invoice_from_confirmed($1)`, [invoiceId]);

      const admin = await seedUser(client, "admin");
      await actAs(client, "authenticated", admin);
      const view = await breakdown(client, invoiceId);
      expect(view!.groups.map((group) => group.source)).toEqual(["gateway"]);
    });
  });

  test("reconciled is false when paid is set by hand to a different value", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      await insertPartial(client, fx, { amount: 200 });
      await client.query(`update public.invoices set paid = 50 where id = $1`, [fx.invoices[0].id]);

      const admin = await seedUser(client, "admin");
      await actAs(client, "authenticated", admin);
      const view = await breakdown(client, fx.invoices[0].id);
      expect(view!.reconciled).toBe(false);
      expect(Number(view!.paid_from_allocations)).toBe(200);
      expect(Number(view!.invoice.paid)).toBe(50);
    });
  });
});

describe("get_partial_payment_edit_context", () => {
  test("a settled row reports the allocation as credited_amount", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200 });
      const admin = await seedUser(client, "admin");
      await actAs(client, "authenticated", admin);

      const ctx = await editContext(client, partialId);
      expect(ctx).not.toBeNull();
      expect(ctx!.settled).toBe(true);
      expect(Number(ctx!.credited_amount)).toBe(200);
      expect(ctx!.invoice?.id).toBe(fx.invoices[0].id);
    });
  });

  test("an unsettled row reports credited_amount 0", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200 });
      await client.query(`update public.partial_payments set invoice_id = null where id = $1`, [
        partialId,
      ]);
      const admin = await seedUser(client, "admin");
      await actAs(client, "authenticated", admin);

      const ctx = await editContext(client, partialId);
      expect(ctx!.settled).toBe(false);
      expect(Number(ctx!.credited_amount)).toBe(0);
      expect(ctx!.invoice).toBeNull();
    });
  });

  test("another tenant sees null", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200 });
      const other = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const stranger = await seedUser(client, "tenant", other.tenantId);
      await actAs(client, "authenticated", stranger);

      expect(await editContext(client, partialId)).toBeNull();
    });
  });
});

describe("get_invoice_payment_breakdown last_paid_on (migration 227)", () => {
  test("a group reports its latest payment date beside its earliest", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoiceId = fx.invoices[0].id;
      for (const [amount, date] of [
        [100, "2026-01-05"],
        [150, "2026-01-20"],
      ] as const) {
        const payment = await client.query<{ id: string }>(
          `insert into public.payments
             (code, tenant_id, method, amount, payment_date, status)
           values (public.next_payment_code(), $1, 'cash', $2, $3::date, 'confirmed')
           returning id`,
          [fx.tenantId, amount, date],
        );
        await client.query(
          `insert into public.payment_allocations (payment_id, invoice_id, amount)
           values ($1, $2, $3)`,
          [payment.rows[0].id, invoiceId, amount],
        );
      }

      const admin = await seedUser(client, "admin");
      await actAs(client, "authenticated", admin);
      const view = (await breakdown(client, invoiceId)) as unknown as {
        groups: Array<{ first_paid_on: string; last_paid_on: string }>;
      };

      expect(view.groups).toHaveLength(1);
      expect(view.groups[0].first_paid_on).toBe("2026-01-05");
      expect(view.groups[0].last_paid_on).toBe("2026-01-20");
    });
  });
});

describe("get_invoice_payment_breakdown for the service role (migration 238)", () => {
  // The receipt and invoice PDF renderers call this through supabaseAdmin,
  // whose JWT has no `sub`. Migration 227 dropped the bypass and every receipt
  // shipped without its PDF; this is the lock against the next re-issue.
  test("the service key with no user still gets the snapshot", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      await insertPartial(client, fx, { amount: 200 });

      await actAs(client, "service_role");
      const view = await breakdown(client, fx.invoices[0].id);

      expect(view).not.toBeNull();
      expect(view!.groups).toHaveLength(1);
      expect(view!.groups[0].source).toBe("partial");
    });
  });

  test("a signed-in user who is neither staff nor the tenant still gets null", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      await insertPartial(client, fx, { amount: 200 });
      const nobody = await seedUser(client, "tenant", null);

      await actAs(client, "authenticated", nobody);

      expect(await breakdown(client, fx.invoices[0].id)).toBeNull();
    });
  });

  test("anon cannot execute it at all", async () => {
    await withRollback(async (client) => {
      const row = await client.query<{ allowed: boolean }>(
        `select has_function_privilege('anon',
           'public.get_invoice_payment_breakdown(uuid)', 'execute') as allowed`,
      );

      expect(row.rows[0].allowed).toBe(false);
    });
  });
});
