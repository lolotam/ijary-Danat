import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { runAsCompanyService } from "@/db/isolation/twoCompanies";
import { actAsSuperuser, captureRaise, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * اختبارات دوال لوحة المنصة: الإجماليات وحالة كل شركة (T184).
 *
 * The database is not empty at rest — the mock-data migrations seed demo rows —
 * so the totals are asserted as the difference between a reading taken before
 * the fixtures are created and the reading taken after them.
 */

/** سطر الإجماليات بالأعداد (pg يعيد الأعداد الكبيرة نصوصاً). */
interface TotalsRow {
  companies_total: number;
  companies_active: number;
  companies_suspended: number;
  units_total: number;
  staff_users_total: number;
  renters_total: number;
  collected_this_month: number;
}

/** سطر حالة الشركة كما يعيده `pg`. */
interface HealthRow {
  company_id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  status: string;
  whatsapp_ok: boolean | null;
  gateway_ok: boolean | null;
  jobs_failed_24h: string;
  notifications_failed_24h: string;
  collected_this_month: string;
  units_used: string;
  units_max: number | null;
  staff_used: string;
  staff_max: number | null;
  whatsapp_used: number;
  whatsapp_max: number | null;
  storage_bytes: string;
  storage_max: string | null;
  subscription_status: string | null;
  subscription_renewal_date: string | null;
}

/** وسم يميّز صفوف هذا الاختبار عن غيرها. */
const TAG = randomUUID().replace(/-/g, "").slice(0, 10);

/** أرقام الشركات في هذا الاختبار: السليمة والمعطوبة والبلا إعدادات. */
const SLUG_HEALTHY = `healthy-${TAG}`;
const SLUG_DEGRADED = `degraded-${TAG}`;
const SLUG_BARE = `bare-${TAG}`;

/** رقم واتساب الشركة السليمة، وهو الرقم المقترن بجلسة Evolution. */
const HEALTHY_WHATSAPP = "+96550000001";
/** رقم شركة أخرى: له اتصال في الإعدادات لكنه ليس الرقم المقترن. */
const DEGRADED_WHATSAPP = "+96550000002";

/**
 * ينشئ مستخدماً في `auth.users` بلا صف في `profiles`.
 *
 * A super admin is a GoTrue user with no company profile (research R16), so
 * the metadata says so and the trigger leaves the profile alone. Whether the
 * user is a platform admin is decided by the `platform_admins` row, not by
 * this flag.
 */
async function seedAuthUser(client: PoolClient): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2,
             '{"is_platform_admin":"true"}'::jsonb)`,
    [userId, `platform-${userId.slice(0, 8)}@example.test`],
  );
  return userId;
}

/**
 * ينشئ صف مشرف منصة للمستخدم.
 */
async function grantPlatformAdmin(client: PoolClient, userId: string): Promise<void> {
  await client.query(
    `insert into public.platform_admins (user_id, full_name, is_active)
     values ($1, $2, true)`,
    [userId, `Platform Admin ${userId.slice(0, 8)}`],
  );
}

/**
 * ينتحل دور مستخدم مصادق عليه مع ادعاء العامل الثاني.
 *
 * The second factor is half of what `is_platform_admin()` checks, so the claim
 * blob has to carry it — `actAs` in testDb.ts cannot.
 */
async function actAsUserWithAal(
  client: PoolClient,
  userId: string,
  aal: string | null,
): Promise<void> {
  const claims = JSON.stringify({
    sub: userId,
    role: "authenticated",
    ...(aal ? { aal } : {}),
  });
  await client.query("select set_config('request.jwt.claims', $1, true)", [claims]);
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
  await client.query("select set_config('request.jwt.claim.role', $1, true)", ["authenticated"]);
  await client.query("select set_config('role', $1, true)", ["authenticated"]);
}

/** ينشئ شركة باسمها ورقم واتسابها. */
async function seedCompany(
  client: PoolClient,
  input: { slug: string; nameAr: string; nameEn: string; whatsapp?: string | null },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en, slug, whatsapp)
     values ($1, $2, $3, $4)
     returning id`,
    [input.nameAr, input.nameEn, input.slug, input.whatsapp ?? null],
  );
  return rows[0].id;
}

/**
 * ينشئ حساب موظف واحداً في الشركة، بدوره الإداري.
 *
 * The `on_auth_user_created` trigger already wrote a profile row for the new
 * GoTrue user, so the insert updates that row instead of colliding with it.
 */
async function seedStaffProfile(client: PoolClient, companyId: string): Promise<void> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@auth.ijary.invalid`],
  );
  await client.query(
    `insert into public.profiles (id, company_id, username, display_name, is_active)
     values ($1, $2, $3, $4, true)
     on conflict (id) do update
       set company_id = excluded.company_id,
           username = excluded.username,
           display_name = excluded.display_name,
           is_active = true`,
    [userId, companyId, `staff-${userId.slice(0, 8)}`, "موظف الاختبار"],
  );
  await client.query(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [
    userId,
  ]);
}

/** ينشئ سجل مستأجر واحداً في الشركة. */
async function seedTenant(client: PoolClient, companyId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.tenants (code, company_id, name, lifecycle)
     values ($1, $2, $3, 'active')
     returning id`,
    [`T-${TAG}-${companyId.slice(0, 8)}`, companyId, "مستأجر الاختبار"],
  );
  return rows[0].id;
}

/** ينشئ عقاراً ووحدة واحدة لهما، في الشركة نفسها. */
async function seedUnit(client: PoolClient, companyId: string, suffix: string): Promise<void> {
  const property = await client.query<{ id: string }>(
    `insert into public.properties (code, company_id, name_ar, name_en)
     values ($1, $2, $3, $4)
     returning id`,
    [`P-${TAG}-${suffix}`, companyId, `عقار ${suffix}`, `Property ${suffix}`],
  );
  await client.query(
    `insert into public.units (company_id, code, property_id, name) values ($1, $2, $3, $4)`,
    [companyId, `U-${TAG}-${suffix}`, property.rows[0].id, `Unit ${suffix}`],
  );
}

/** يسجّل دفعة واحدة؛ `status` و`payment_date` يقرّران إن كانت تُحتسب. */
async function seedPayment(
  client: PoolClient,
  input: {
    companyId: string;
    tenantId: string;
    amount: number;
    status: "confirmed" | "reversed";
    paymentDate: string;
  },
): Promise<void> {
  // The payment triggers read the company from the `company_service` session,
  // as the server does; one fixture company is suspended, so its history is
  // seeded with the settlement path's `allow_suspended` claim.
  await runAsCompanyService(
    client,
    input.companyId,
    () =>
      client.query(
        `insert into public.payments (company_id, code, tenant_id, amount, method, status, payment_date)
         values ($1, $6, $2, $3, 'cash', $4, $5::date)`,
        [
          input.companyId,
          input.tenantId,
          input.amount,
          input.status,
          input.paymentDate,
          `PAY-${randomUUID().slice(0, 12)}`,
        ],
      ),
    { allowSuspended: true },
  );
}

/** يسجّل اتصال بوابة دفع: شركة ببوابة عاملة أو ببوابة فشل اختبارها. */
async function seedGateway(
  client: PoolClient,
  input: {
    companyId: string;
    provider: "myfatoorah" | "tap" | "upayments";
    isActive: boolean;
    lastTestOk: boolean;
  },
): Promise<void> {
  await client.query(
    `insert into public.gateway_connections
       (company_id, provider, mode, is_active, last_test_ok, last_test_at)
     values ($1, $2, 'test', $3, $4, now() - interval '1 day')`,
    [input.companyId, input.provider, input.isActive, input.lastTestOk],
  );
}

/** يسجّل مهمة خلفية فاشلة انتهت قبل `hours` ساعات. */
async function seedFailedJob(client: PoolClient, companyId: string, hours: number): Promise<void> {
  await client.query(
    `insert into public.job_requests
       (company_id, kind, status, attempts, last_error, created_at, finished_at)
     values ($1, 'invoice.send', 'failed', 3, 'the provider refused the message',
             now() - ($2 || ' hours')::interval, now() - ($2 || ' hours')::interval)`,
    [companyId, String(hours)],
  );
}

/** يسجّل إشعاراً فاشلاً قُبل `hours` ساعات. */
async function seedFailedNotification(
  client: PoolClient,
  companyId: string,
  hours: number,
): Promise<void> {
  await client.query(
    `insert into public.notifications (company_id, type, channel, state, created_at)
     values ($1, 'receipt', 'email', 'failed', now() - ($2 || ' hours')::interval)`,
    [companyId, String(hours)],
  );
}

/** يقرأ إجماليات المنصة بالأعداد. */
async function readTotals(client: PoolClient): Promise<TotalsRow> {
  const { rows } = await client.query<TotalsRow>(
    `select (companies_total)::int as companies_total,
            (companies_active)::int as companies_active,
            (companies_suspended)::int as companies_suspended,
            (units_total)::int as units_total,
            (staff_users_total)::int as staff_users_total,
            (renters_total)::int as renters_total,
            (collected_this_month)::float8 as collected_this_month
       from public.platform_overview_totals()`,
  );
  return rows[0];
}

/** يقرأ حالة كل شركة. */
async function readHealth(client: PoolClient): Promise<HealthRow[]> {
  const { rows } = await client.query<HealthRow>(
    `select *, subscription_renewal_date::text as subscription_renewal_date
       from public.platform_company_health()
      order by slug`,
  );
  return rows;
}

/** يبني fixtures لوحة المنصة: ثلاث شركات، سليمة ومعطوبة وبلا إعدادات. */
async function seedOverviewFixtures(client: PoolClient): Promise<void> {
  const healthyId = await seedCompany(client, {
    slug: SLUG_HEALTHY,
    nameAr: "شركة سليمة",
    nameEn: "Healthy Co",
    whatsapp: HEALTHY_WHATSAPP,
  });
  const degradedId = await seedCompany(client, {
    slug: SLUG_DEGRADED,
    nameAr: "شركة معطوبة",
    nameEn: "Degraded Co",
    whatsapp: DEGRADED_WHATSAPP,
  });
  await seedCompany(client, {
    slug: SLUG_BARE,
    nameAr: "شركة بلا إعدادات",
    nameEn: "Bare Co",
  });

  // The degraded company was stopped after its connections broke, so the list
  // carries a suspended company too.
  await client.query(
    `update public.companies
        set status = 'suspended', suspended_at = now(), suspended_reason = 'Suspended in SQL test'
      where id = $1`,
    [degradedId],
  );

  await seedStaffProfile(client, healthyId);
  await seedStaffProfile(client, degradedId);
  const healthyTenant = await seedTenant(client, healthyId);
  const degradedTenant = await seedTenant(client, degradedId);

  await seedUnit(client, healthyId, "h1");
  await seedUnit(client, healthyId, "h2");
  await seedUnit(client, degradedId, "d1");

  // The collected money: one confirmed payment this month, one payment from
  // last month, and one reversed payment — only the first counts.
  const thisMonth = await client.query<{ day: string }>(
    "select to_char((now() at time zone 'Asia/Kuwait')::date, 'YYYY-MM-DD') as day",
  );
  await seedPayment(client, {
    companyId: healthyId,
    tenantId: healthyTenant,
    amount: 100,
    status: "confirmed",
    paymentDate: thisMonth.rows[0].day,
  });
  await seedPayment(client, {
    companyId: healthyId,
    tenantId: healthyTenant,
    amount: 50,
    status: "confirmed",
    paymentDate: "2020-01-15",
  });
  await seedPayment(client, {
    companyId: degradedId,
    tenantId: degradedTenant,
    amount: 70,
    status: "reversed",
    paymentDate: thisMonth.rows[0].day,
  });

  await seedGateway(client, {
    companyId: healthyId,
    provider: "myfatoorah",
    isActive: true,
    lastTestOk: true,
  });
  await seedGateway(client, {
    companyId: degradedId,
    provider: "tap",
    isActive: false,
    lastTestOk: false,
  });

  // Two failures inside the last day, and one older than the window.
  await seedFailedJob(client, degradedId, 2);
  await seedFailedJob(client, degradedId, 5);
  await seedFailedJob(client, degradedId, 30);
  await seedFailedNotification(client, degradedId, 3);
  await seedFailedNotification(client, degradedId, 7);
  await seedFailedNotification(client, degradedId, 8);
  await seedFailedNotification(client, degradedId, 40);

  // Until US9 there is one Evolution session row (id 1); it belongs to the
  // healthy company, is open and is paired with that company's number. The
  // degraded company has a number but no session, so it cannot send.
  await client.query(
    `insert into public.evolution_connections
       (id, company_id, instance_name, webhook_secret, last_connection_state, connected_number)
     values (1, $2, 'danat', 'test-secret', 'open', $1)
     on conflict (id) do update
       set company_id = excluded.company_id,
           last_connection_state = excluded.last_connection_state,
           connected_number = excluded.connected_number`,
    [HEALTHY_WHATSAPP, healthyId],
  );

  // FR-074: limits, monthly WhatsApp usage, storage usage, and subscriptions.
  await client.query(
    `insert into public.company_limits
       (company_id, max_units, max_staff_users, max_whatsapp_per_month, max_storage_bytes)
     values ($1, 10, 5, 100, 104857600),
            ($2, 1, 1, 10, 1024)`,
    [healthyId, degradedId],
  );
  await client.query(
    `insert into public.company_usage_monthly (company_id, month, whatsapp_sent)
     values ($1, date_trunc('month', now() at time zone 'Asia/Kuwait')::date, 42),
            ($2, date_trunc('month', now() at time zone 'Asia/Kuwait')::date, 9)`,
    [healthyId, degradedId],
  );
  await client.query(
    `insert into public.company_storage_usage (company_id, bytes)
     values ($1, 2048), ($2, 900)`,
    [healthyId, degradedId],
  );
  await client.query(
    `insert into public.company_subscriptions
       (company_id, plan_name, price, period_start, renewal_date, status)
     values ($1, 'Starter', 50.000, '2026-01-01', '2026-02-01', 'trial'),
            ($1, 'Pro', 120.000, '2026-02-01', '2027-01-15', 'active'),
            ($2, 'Starter', 50.000, '2025-12-01', '2026-01-01', 'overdue')`,
    [healthyId, degradedId],
  );
}

describe("the platform overview functions (T184)", () => {
  test("the totals count every company, unit, staff account, renter and this month's money", async () => {
    await withRollback(async (client) => {
      const adminId = await seedAuthUser(client);
      await grantPlatformAdmin(client, adminId);

      await actAsUserWithAal(client, adminId, "aal2");
      const before = await readTotals(client);

      await actAsSuperuser(client);
      await seedOverviewFixtures(client);

      await actAsUserWithAal(client, adminId, "aal2");
      const after = await readTotals(client);

      expect(after.companies_total - before.companies_total).toBe(3);
      expect(after.companies_active - before.companies_active).toBe(2);
      expect(after.companies_suspended - before.companies_suspended).toBe(1);
      expect(after.units_total - before.units_total).toBe(3);
      expect(after.staff_users_total - before.staff_users_total).toBe(2);
      expect(after.renters_total - before.renters_total).toBe(2);
      // Only the confirmed payment of this month; last month's and the
      // reversed one are not collected money.
      expect(after.collected_this_month - before.collected_this_month).toBe(100);
    });
  });

  const HEALTH_CASES = [
    {
      label: "a healthy company",
      slug: SLUG_HEALTHY,
      status: "active",
      whatsappOk: true,
      gatewayOk: true,
      jobsFailed: 0,
      notificationsFailed: 0,
      collectedThisMonth: 100,
      unitsUsed: 2,
      unitsMax: 10,
      staffUsed: 1,
      staffMax: 5,
      whatsappUsed: 42,
      whatsappMax: 100,
      storageBytes: 2048,
      storageMax: 104857600,
      subscriptionStatus: "active",
      subscriptionRenewalDate: "2027-01-15",
    },
    {
      label: "a company whose WhatsApp number is not the paired one and whose gateway test failed",
      slug: SLUG_DEGRADED,
      status: "suspended",
      whatsappOk: false,
      gatewayOk: false,
      jobsFailed: 2,
      notificationsFailed: 3,
      collectedThisMonth: 0,
      unitsUsed: 1,
      unitsMax: 1,
      staffUsed: 1,
      staffMax: 1,
      whatsappUsed: 9,
      whatsappMax: 10,
      storageBytes: 900,
      storageMax: 1024,
      subscriptionStatus: "overdue",
      subscriptionRenewalDate: "2026-01-01",
    },
    {
      label: "a company with no WhatsApp connection and no gateway",
      slug: SLUG_BARE,
      status: "active",
      whatsappOk: null,
      gatewayOk: null,
      jobsFailed: 0,
      notificationsFailed: 0,
      collectedThisMonth: 0,
      unitsUsed: 0,
      unitsMax: null,
      staffUsed: 0,
      staffMax: null,
      whatsappUsed: 0,
      whatsappMax: null,
      storageBytes: 0,
      storageMax: null,
      subscriptionStatus: null,
      subscriptionRenewalDate: null,
    },
  ] as const;

  test.each(HEALTH_CASES)(
    "$label is flagged with its own state",
    async ({
      slug,
      status,
      whatsappOk,
      gatewayOk,
      jobsFailed,
      notificationsFailed,
      collectedThisMonth,
      unitsUsed,
      unitsMax,
      staffUsed,
      staffMax,
      whatsappUsed,
      whatsappMax,
      storageBytes,
      storageMax,
      subscriptionStatus,
      subscriptionRenewalDate,
    }) => {
      await withRollback(async (client) => {
        const adminId = await seedAuthUser(client);
        await grantPlatformAdmin(client, adminId);

        await actAsSuperuser(client);
        await seedOverviewFixtures(client);

        await actAsUserWithAal(client, adminId, "aal2");
        const rows = await readHealth(client);
        const row = rows.find((candidate) => candidate.slug === slug);

        expect(row).toBeDefined();
        expect(row!.status).toBe(status);
        expect(row!.whatsapp_ok).toBe(whatsappOk);
        expect(row!.gateway_ok).toBe(gatewayOk);
        expect(Number(row!.jobs_failed_24h)).toBe(jobsFailed);
        expect(Number(row!.notifications_failed_24h)).toBe(notificationsFailed);
        expect(Number(row!.collected_this_month)).toBe(collectedThisMonth);
        expect(Number(row!.units_used)).toBe(unitsUsed);
        expect(row!.units_max).toBe(unitsMax);
        expect(Number(row!.staff_used)).toBe(staffUsed);
        expect(row!.staff_max).toBe(staffMax);
        expect(row!.whatsapp_used).toBe(whatsappUsed);
        expect(row!.whatsapp_max).toBe(whatsappMax);
        expect(Number(row!.storage_bytes)).toBe(storageBytes);
        expect(row!.storage_max === null ? null : Number(row!.storage_max)).toBe(storageMax);
        expect(row!.subscription_status).toBe(subscriptionStatus);
        expect(row!.subscription_renewal_date).toBe(subscriptionRenewalDate);
      });
    },
  );

  test("a caller who is not a platform admin is refused by both functions", async () => {
    await withRollback(async (client) => {
      const adminId = await seedAuthUser(client);
      await grantPlatformAdmin(client, adminId);

      const userId = await seedAuthUser(client);
      await actAsUserWithAal(client, userId, "aal2");

      const totalsMessage = await captureRaise(client, () =>
        client.query("select * from public.platform_overview_totals()"),
      );
      expect(totalsMessage).toContain("PLATFORM_ADMIN_REQUIRED");

      const healthMessage = await captureRaise(client, () =>
        client.query("select * from public.platform_company_health()"),
      );
      expect(healthMessage).toContain("PLATFORM_ADMIN_REQUIRED");

      // The admin row of the other caller does not leak into this session.
      expect(adminId).not.toBe(userId);
    });
  });

  test("a platform admin without the second factor is refused", async () => {
    await withRollback(async (client) => {
      const adminId = await seedAuthUser(client);
      await grantPlatformAdmin(client, adminId);

      await actAsUserWithAal(client, adminId, "aal1");

      const message = await captureRaise(client, () =>
        client.query("select * from public.platform_overview_totals()"),
      );
      expect(message).toContain("PLATFORM_ADMIN_REQUIRED");
    });
  });

  test("only a signed-in platform admin may execute the overview functions", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const { rows } = await client.query<{ grantee: string; allowed: boolean }>(
        `select r.grantee, has_function_privilege(r.grantee, f.fn::regprocedure, 'EXECUTE') as allowed
           from unnest(array[
                  'public.platform_overview_totals()',
                  'public.platform_company_health()'
                ]) as f(fn)
           cross join unnest(array['anon', 'authenticated', 'company_service', 'service_role']) as r(grantee)
          order by 1, 2`,
      );

      const allowed = rows.filter((row) => row.allowed).map((row) => row.grantee);
      expect([...new Set(allowed)]).toEqual(["authenticated"]);
    });
  });
});
