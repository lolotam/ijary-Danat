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
 * القيم الرقمية من Postgres تصل نصّاً (numeric وbigint)؛ يوحّدها Number
 * فلا تعتمد المقارنة على تمثيل العمود.
 */
function num(value: unknown): number {
  return Number(value ?? 0);
}

interface InvoiceFixture {
  contractId: string;
  companyId: string;
  tenantId: string;
  unitId: string;
}

/**
 * يُدخل فاتورة بحالة ومبلغ وتاريخ استحقاق معلومين، ويعيد معرّفها.
 *
 * Each fixture uses its own contract, so the shared period (2026/1) never
 * collides on unique (contract_id, period_year, period_month) — and each
 * invoice lands on a different tenant, which the RLS test needs.
 */
async function insertInvoice(
  client: PoolClient,
  fx: InvoiceFixture,
  options: { dueDateSql: string; total: number; state: string; tag: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.invoices (
       code, company_id, contract_id, tenant_id, unit_id,
       period_year, period_month, issue_date, due_date,
       subtotal, discount, total, paid, state, is_visible_to_tenant, idempotency_key
     )
     values (
       'INV-dash-' || substr(gen_random_uuid()::text, 1, 8),
       $2::uuid, $1::uuid, $3::uuid, $4::uuid,
       2026, 1, current_date, ${options.dueDateSql},
       $5, 0, $5, 0, $6::public.invoice_states, true,
       $1::text || ':dash:${options.tag}:' || substr(gen_random_uuid()::text, 1, 8)
     )
     returning id`,
    [fx.contractId, fx.companyId, fx.tenantId, fx.unitId, options.total, options.state],
  );
  return rows[0].id;
}

/**
 * يسجّل دفعة مؤكّدة مع تخصيصها ثم يعيد حساب الفاتورة، ويعيد معرّف الدفعة.
 *
 * The recompute is load-bearing here (unlike the precedence suite, where the
 * recompute itself is the subject): the RPC reads `invoices.paid`, so the
 * allocation alone would leave the fixture's money invisible to it.
 */
async function payConfirmed(
  client: PoolClient,
  tenantId: string,
  invoiceId: string,
  amount: number,
): Promise<string> {
  const payment = await client.query<{ id: string }>(
    `insert into public.payments (tenant_id, amount, method, status, payment_date)
     values ($1, $2, 'cash', 'confirmed', current_date) returning id`,
    [tenantId, amount],
  );
  await client.query(
    `insert into public.payment_allocations (payment_id, invoice_id, amount)
     values ($1, $2, $3)`,
    [payment.rows[0].id, invoiceId, amount],
  );
  await client.query(`select public.recompute_invoice_from_confirmed($1)`, [invoiceId]);
  return payment.rows[0].id;
}

/**
 * يُدخل دفعة بحالة وتاريخ معلومين دون تخصيص، ويعيد معرّفها.
 *
 * `payments_this_month` sums payments directly (no allocation join), so these
 * rows pin its status/date filters without touching any invoice.
 */
async function insertPayment(
  client: PoolClient,
  tenantId: string,
  options: { amount: number; status: string; dateSql: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.payments (tenant_id, amount, method, status, payment_date)
     values ($1, $2, 'cash', $3, ${options.dateSql}) returning id`,
    [tenantId, options.amount, options.status],
  );
  return rows[0].id;
}

/**
 * ينشئ مستخدمًا بدور محدد في auth.users و user_roles.
 *
 * Mirrors hideFromPortalRls: the `on_auth_user_created` trigger creates the
 * profile row, so linking it to a tenant is a plain update.
 */
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

interface DashboardFixture {
  linkedTenantId: string;
  /** الفواتير الست المزروعة — تُقيَّد بها فحوص الاستبعاد فلا تتأثر ببيانات Demo. */
  invoiceIds: string[];
  /** الجزء المحصَّل على الفاتورة المتأخرة — مستبعد من paid. */
  overduePartial: number;
  thisMonthPaymentId: string;
  lastMonthPaymentId: string;
  pendingPaymentId: string;
  reversedPaymentId: string;
  thisMonthAmount: number;
  salaryIds: string[];
  employeeIds: string[];
}

/**
 * يزرع كل حالات الفواتير والدفعات والمستأجرين والوحدات والموظفين والرواتب
 * التي تحتاجها اختبارات المجاميع.
 *
 * Invoices: due, partially_paid (linked tenant), overdue with a partial
 * payment, paid, cancelled, waived. Payments: confirmed this/previous UTC
 * month plus pending and reversed rows dated today. Salaries: a delivered,
 * an undelivered and a previous-month row. Employees, tenants and units cover
 * both sides of every count.
 */
async function arrange(client: PoolClient): Promise<DashboardFixture> {
  const due = await seedContract(client, { startDate: "2025-01-01", endDate: "2026-12-31" });
  const part = await seedContract(client, { startDate: "2025-01-01", endDate: "2026-12-31" });
  const over = await seedContract(client, {
    startDate: "2025-01-01",
    endDate: "2026-12-31",
    graceDays: 7,
  });
  const paid = await seedContract(client, { startDate: "2025-01-01", endDate: "2026-12-31" });
  const cancelled = await seedContract(client, {
    startDate: "2025-01-01",
    endDate: "2026-12-31",
  });
  const waived = await seedContract(client, { startDate: "2025-01-01", endDate: "2026-12-31" });

  const invoiceIds = [
    await insertInvoice(client, due, {
      dueDateSql: "current_date + 60",
      total: 500,
      state: "due",
      tag: "due",
    }),
  ];
  const partInvoice = await insertInvoice(client, part, {
    dueDateSql: "current_date + 60",
    total: 500,
    state: "due",
    tag: "part",
  });
  invoiceIds.push(partInvoice);
  await payConfirmed(client, part.tenantId, partInvoice, 200);
  const overInvoice = await insertInvoice(client, over, {
    dueDateSql: "current_date - 10",
    total: 500,
    state: "due",
    tag: "over",
  });
  invoiceIds.push(overInvoice);
  await payConfirmed(client, over.tenantId, overInvoice, 200);
  const paidInvoice = await insertInvoice(client, paid, {
    dueDateSql: "current_date - 40",
    total: 400,
    state: "due",
    tag: "paid",
  });
  invoiceIds.push(paidInvoice);
  await payConfirmed(client, paid.tenantId, paidInvoice, 400);
  invoiceIds.push(
    await insertInvoice(client, cancelled, {
      dueDateSql: "current_date + 60",
      total: 300,
      state: "cancelled",
      tag: "cancel",
    }),
    await insertInvoice(client, waived, {
      dueDateSql: "current_date + 60",
      total: 300,
      state: "waived",
      tag: "waive",
    }),
  );

  // UTC month boundaries, exactly as the RPC computes them.
  const monthStart = `(date_trunc('month', now() at time zone 'utc'))::date`;
  const thisMonthPaymentId = await insertPayment(client, due.tenantId, {
    amount: 150,
    status: "confirmed",
    dateSql: monthStart,
  });
  const lastMonthPaymentId = await insertPayment(client, due.tenantId, {
    amount: 175,
    status: "confirmed",
    dateSql: `${monthStart} - 1`,
  });
  const pendingPaymentId = await insertPayment(client, due.tenantId, {
    amount: 125,
    status: "pending",
    dateSql: "current_date",
  });
  const reversedPaymentId = await insertPayment(client, due.tenantId, {
    amount: 135,
    status: "reversed",
    dateSql: "current_date",
  });

  // Units: the contracted ones read occupied, plus one vacant unit; the direct
  // comparison absorbs whatever else the seed holds.
  await client.query(`update public.units set status = 'occupied' where id = any($1::uuid[])`, [
    [due.unitId, part.unitId],
  ]);
  // A contracted unit's status is trigger-maintained, so the vacant one is a
  // separate contract-less unit on the same property.
  await client.query(
    `insert into public.units (code, property_id, name, status)
     select $1, property_id, $2, 'vacant' from public.units where id = $3`,
    [`U-VAC-${randomUUID().slice(0, 8)}`, "وحدة شاغرة", over.unitId],
  );

  // A contract-less tenant: the insert trigger computes lifecycle inactive.
  const tag = randomUUID().slice(0, 8);
  await client.query(`insert into public.tenants (code, name) values ($1, $2)`, [
    `T-DASH-${tag}`,
    `مستأجر غير نشط ${tag}`,
  ]);

  const employeeIds: string[] = [];
  for (const [suffix, name, salary, active] of [
    ["A", `موظف نشط ${tag} أ`, 1000, true],
    ["B", `موظف نشط ${tag} ب`, 2000, true],
    ["C", `موظف متوقف ${tag}`, 3000, false],
  ] as const) {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.employees (code, name, salary, is_active)
       values ($1, $2, $3, $4) returning id`,
      [`EMP-DASH-${tag}-${suffix}`, name, salary, active],
    );
    employeeIds.push(rows[0].id);
  }
  /** يُدخل صف راتب لشهر محسوب في SQL (يلتف على حد السنة) ويعيد معرّفه. */
  const salaryOf = async (
    employeeId: string,
    yearSql: string,
    monthSql: string,
    amount: number,
    delivered: boolean,
  ) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.salaries (employee_id, year, month, amount, delivered)
       values ($1, (${yearSql})::integer, (${monthSql})::integer, $2, $3) returning id`,
      [employeeId, amount, delivered],
    );
    return rows[0].id;
  };
  const thisYear = `extract(year from now() at time zone 'utc')`;
  const thisMonth = `extract(month from now() at time zone 'utc')`;
  const prevMonthStart = `date_trunc('month', now() at time zone 'utc') - interval '1 month'`;
  const salaryIds = [
    await salaryOf(employeeIds[0], thisYear, thisMonth, 1000, true),
    await salaryOf(employeeIds[1], thisYear, thisMonth, 2000, false),
    await salaryOf(
      employeeIds[0],
      `extract(year from (${prevMonthStart}))`,
      `extract(month from (${prevMonthStart}))`,
      1000,
      true,
    ),
  ];

  return {
    linkedTenantId: part.tenantId,
    invoiceIds,
    overduePartial: 200,
    thisMonthPaymentId,
    lastMonthPaymentId,
    pendingPaymentId,
    reversedPaymentId,
    thisMonthAmount: 150,
    salaryIds,
    employeeIds,
  };
}

const AGG_KEYS = [
  "outstanding",
  "future_outstanding",
  "future_count",
  "paid",
  "overdue_amount",
  "overdue_count",
  "payments_this_month",
  "tenants",
  "active_tenants",
  "units",
  "occupied_units",
  "properties",
  "employees",
  "salaries_paid",
] as const;

/**
 * يستدعي مجاميع اللوحة ويطبّعها أرقامًا قابلة للمقارنة.
 */
async function rpcAggregates(client: PoolClient): Promise<Record<string, number>> {
  const { rows } = await client.query<{ agg: Record<string, unknown> }>(
    `select public.get_dashboard_aggregates() as agg`,
  );
  const out: Record<string, number> = {};
  for (const key of AGG_KEYS) out[key] = num(rows[0].agg?.[key]);
  return out;
}

/**
 * يحسب المجاميع نفسها باستعلام مباشر فوق الصفوف نفسها — المرجع الذي تُقارن
 * به نتيجة الدالة مفتاحًا بمفتاح.
 *
 * It mirrors the function body closely, so equality with it mainly proves the
 * two paths see the same rows under the same identity (RLS parity). The
 * literal figures asserted in the tests are what pin the formulas themselves.
 */
async function directAggregates(client: PoolClient): Promise<Record<string, number>> {
  const { rows } = await client.query<Record<string, unknown>>(
    `select
       coalesce(sum(i.balance) filter (
         where i.state in ('overdue', 'due', 'partially_paid')
           and i.due_date <= (now() at time zone 'Asia/Kuwait')::date
       ), 0) as outstanding,
       coalesce(sum(i.balance) filter (
         where i.state in ('overdue', 'due', 'partially_paid')
           and i.due_date > (now() at time zone 'Asia/Kuwait')::date
       ), 0) as future_outstanding,
       count(*) filter (
         where i.state in ('overdue', 'due', 'partially_paid')
           and i.due_date > (now() at time zone 'Asia/Kuwait')::date
       ) as future_count,
       coalesce(sum(i.total - i.balance) filter (
         where i.state in ('due', 'partially_paid')
       ), 0)
       + coalesce(sum(i.total) filter (where i.state = 'paid'), 0) as paid,
       coalesce(sum(i.balance) filter (where i.state = 'overdue'), 0) as overdue_amount,
       count(*) filter (where i.state = 'overdue') as overdue_count,
       (select coalesce(sum(p.amount), 0)
          from public.payments p
         where p.status = 'confirmed'
           and p.payment_date >= date_trunc('month', now() at time zone 'utc')::date
       ) as payments_this_month,
       (select count(*) from public.tenants t) as tenants,
       (select count(*) from public.tenants t where t.lifecycle = 'active') as active_tenants,
       (select count(*) from public.units u) as units,
       (select count(*) from public.units u where u.status = 'occupied') as occupied_units,
       (select count(*) from public.properties pr) as properties,
       (select count(*) from public.employees e where e.is_active) as employees,
       (select coalesce(sum(s.amount), 0)
          from public.salaries s
         where s.year = extract(year from now() at time zone 'utc')::integer
           and s.month = extract(month from now() at time zone 'utc')::integer
           and s.delivered
       ) as salaries_paid
     from public.invoices i`,
  );
  const out: Record<string, number> = {};
  for (const key of AGG_KEYS) out[key] = num(rows[0][key]);
  return out;
}

/**
 * Migration 219 — `get_dashboard_aggregates()` replaces the nine browser
 * queries `fetchDashboardKpis` used to run (audit H10: past ~1,000 rows
 * PostgREST caps an unranged read, so browser sums silently stopped being
 * the portfolio's money). `security invoker`, so RLS still applies.
 */
describe("get_dashboard_aggregates (migrations 219, 228)", () => {
  test("matches the direct SQL for every key, with overdue money excluded from paid", async () => {
    await withRollback(async (client) => {
      const fx = await arrange(client);
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const rpc = await rpcAggregates(client);
      const direct = await directAggregates(client);
      expect(rpc).toEqual(direct);

      // The exclusion is load-bearing (debate 14): collecting the overdue
      // invoice's 200 into `paid` must move this number, so assert the gap is
      // exactly the overdue partial — a vacuous formula match cannot produce
      // it. Scoped to the seeded invoices: demo data may hold its own
      // overdue collections, which both sides of the equality above absorb.
      const { rows } = await client.query<{ gap: string }>(
        `select (
           coalesce(sum(i.total - i.balance) filter (
             where i.state in ('due', 'partially_paid', 'overdue')
           ), 0)
           - coalesce(sum(i.total - i.balance) filter (
             where i.state in ('due', 'partially_paid')
           ), 0)
         ) as gap
         from public.invoices i where i.id = any($1::uuid[])`,
        [fx.invoiceIds],
      );
      expect(num(rows[0].gap)).toBe(fx.overduePartial);

      await actAsSuperuser(client);
    });
  });

  test("outstanding counts only invoices due to date; not-yet-due balance is reported apart (migration 228)", async () => {
    // Production 2026-09-24: contracts pre-generate invoices to 2044, so the
    // card summed 10.8M KWD of invoices nobody owed yet. Measured as the
    // change the fixtures cause, so the RPC itself — not a mirror query — is
    // what is pinned, whatever else the demo seed holds.
    await withRollback(async (client) => {
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);
      const before = await rpcAggregates(client);
      await actAsSuperuser(client);

      await arrange(client);
      await actAs(client, "authenticated", admin);
      const after = await rpcAggregates(client);

      // Due to date: only the overdue invoice (500 less its 200 partial).
      expect(after.outstanding - before.outstanding).toBe(300);
      // Not yet due: the due invoice (500) and the part-paid one (500 - 200).
      expect(after.future_outstanding - before.future_outstanding).toBe(800);
      expect(after.future_count - before.future_count).toBe(2);
      expect(after.overdue_count - before.overdue_count).toBe(1);

      await actAsSuperuser(client);
    });
  });

  test("payments_this_month keeps the UTC boundary and the confirmed-only rule", async () => {
    await withRollback(async (client) => {
      const fx = await arrange(client);
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      // Only the confirmed row dated inside the current UTC month counts:
      // last month's confirmed row and today's pending/reversed rows do not.
      const { rows } = await client.query<{ total: string; matches: string }>(
        `select
           coalesce(sum(amount) filter (
             where status = 'confirmed'
               and payment_date >= date_trunc('month', now() at time zone 'utc')::date
           ), 0) as total,
           count(*) filter (
             where status = 'confirmed'
               and payment_date >= date_trunc('month', now() at time zone 'utc')::date
           ) as matches
         from public.payments where id = any($1::uuid[])`,
        [[fx.thisMonthPaymentId, fx.lastMonthPaymentId, fx.pendingPaymentId, fx.reversedPaymentId]],
      );
      expect(num(rows[0].total)).toBe(fx.thisMonthAmount);
      expect(num(rows[0].matches)).toBe(1);

      const rpc = await rpcAggregates(client);
      const direct = await directAggregates(client);
      expect(rpc.payments_this_month).toBe(direct.payments_this_month);

      await actAsSuperuser(client);
    });
  });

  test("salaries count only delivered rows of the current month, employees only active ones", async () => {
    await withRollback(async (client) => {
      const fx = await arrange(client);
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      // The undelivered current-month row and the delivered previous-month
      // row are both out: only the delivered current-month 1000 counts.
      const { rows } = await client.query<{ total: string }>(
        `select coalesce(sum(s.amount) filter (
           where s.year = extract(year from now() at time zone 'utc')::integer
             and s.month = extract(month from now() at time zone 'utc')::integer
             and s.delivered
         ), 0) as total
         from public.salaries s where s.id = any($1::uuid[])`,
        [fx.salaryIds],
      );
      expect(num(rows[0].total)).toBe(1000);

      // The inactive employee is out of the headcount.
      const staff = await client.query<{ active: string }>(
        `select count(*) filter (where is_active) as active
         from public.employees where id = any($1::uuid[])`,
        [fx.employeeIds],
      );
      expect(num(staff.rows[0].active)).toBe(2);

      const rpc = await rpcAggregates(client);
      const direct = await directAggregates(client);
      expect(rpc.salaries_paid).toBe(direct.salaries_paid);
      expect(rpc.employees).toBe(direct.employees);

      await actAsSuperuser(client);
    });
  });

  // A non-admin staff role: whatever RLS lets it read, the RPC must report
  // exactly what the nine direct reads it replaced would have shown it.
  test("a collector gets the same figures the direct reads give it", async () => {
    await withRollback(async (client) => {
      await arrange(client);
      const admin = await seedUserWithRole(client, "admin");
      const collector = await seedUserWithRole(client, "collector");
      await actAs(client, "authenticated", admin);
      const adminRpc = await rpcAggregates(client);

      await actAs(client, "authenticated", collector);
      const collectorRpc = await rpcAggregates(client);
      const collectorDirect = await directAggregates(client);

      expect(collectorRpc).toEqual(collectorDirect);
      expect(collectorRpc.outstanding).toBe(adminRpc.outstanding);
      expect(collectorRpc.paid).toBe(adminRpc.paid);

      await actAsSuperuser(client);
    });
  });

  test("a tenant-scoped user gets RLS-scoped figures, not the portfolio's", async () => {
    await withRollback(async (client) => {
      const fx = await arrange(client);
      const admin = await seedUserWithRole(client, "admin");
      const tenantUser = await seedUserWithRole(client, "tenant");
      await client.query(`update public.profiles set tenant_id = $1 where id = $2`, [
        fx.linkedTenantId,
        tenantUser,
      ]);
      await actAs(client, "authenticated", admin);
      const adminRpc = await rpcAggregates(client);

      await actAs(client, "authenticated", tenantUser);

      // Same RLS through both paths: the RPC under the tenant's identity must
      // agree key-by-key with the direct queries under that same identity.
      const tenantRpc = await rpcAggregates(client);
      const tenantDirect = await directAggregates(client);
      expect(tenantRpc).toEqual(tenantDirect);

      // And the scoping is real, not a vacuous self-match: the tenant sees
      // its own partially-paid invoice (200 collected, 300 still owed) but
      // none of the other tenants' money.
      expect(tenantRpc.paid).toBe(200);
      // Its due date is 60 days out, so since migration 228 that 300 is
      // not-yet-due balance, not outstanding.
      expect(tenantRpc.outstanding).toBe(0);
      expect(tenantRpc.future_outstanding).toBe(300);
      expect(tenantRpc.paid).toBeLessThan(adminRpc.paid);
      // Portal RLS lets a tenant read its own unit and building, never the
      // rest; employees stay staff-only; the tenant row itself is the one
      // tenants-table row this identity may read.
      expect(tenantRpc.units).toBeLessThan(adminRpc.units);
      expect(tenantRpc.properties).toBeLessThan(adminRpc.properties);
      expect(tenantRpc.employees).toBe(0);
      expect(tenantRpc.tenants).toBe(1);

      await actAsSuperuser(client);
    });
  });

  test("anon cannot execute but authenticated can", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ allowed: boolean }>(
        `select has_function_privilege('anon', 'public.get_dashboard_aggregates()', 'execute') as allowed`,
      );
      expect(rows[0].allowed).toBe(false);
      const { rows: authRows } = await client.query<{ allowed: boolean }>(
        `select has_function_privilege('authenticated', 'public.get_dashboard_aggregates()', 'execute') as allowed`,
      );
      expect(authRows[0].allowed).toBe(true);

      await actAs(client, "anon");
      const message = await captureRaise(client, () =>
        client.query(`select public.get_dashboard_aggregates()`),
      );
      await actAsSuperuser(client);
      expect(message).toMatch(/permission denied/i);
    });
  });
});
