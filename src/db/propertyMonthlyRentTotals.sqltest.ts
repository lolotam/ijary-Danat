import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  actAs,
  actAsSuperuser,
  captureRaise,
  captureRaiseError,
  closePool,
  seedContract,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 204 — `get_property_monthly_rent_totals`.
 *
 * /admin/properties needs "what this building should collect this month", and
 * `contract_units.monthly_amount` is only the BASE rent: a contract past its
 * increase anniversary bills more (196), and the only correct pricer,
 * `contract_unit_period_amounts`, is service_role-only. The RPC wraps that
 * pricer per building behind the generator's own eligibility (active,
 * unarchived, term covers the month, not a free month). Rent only — recurring
 * extra charges are excluded by decision.
 *
 * Every fixture is anchored to the database's current month the way
 * contractScheduleSync.sqltest.ts does, because eligibility is a boundary
 * between "this month" and the months around it.
 */

/**
 * أول الشهر الحالي بتقويم قاعدة البيانات نفسها، لا بتقويم Node.
 */
let FIRST_OF_THIS_MONTH = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

beforeAll(async () => {
  await withRollback(async (client) => {
    const { rows } = await client.query<{ month_start: string }>(
      `select to_char(date_trunc('month', current_date), 'YYYY-MM-DD') as month_start`,
    );
    const [year, month] = rows[0].month_start.split("-").map(Number);
    FIRST_OF_THIS_MONTH = new Date(year, month - 1, 1);
  });
});

/** `yyyy-mm-dd` بالتوقيت المحلي؛ `toISOString` يزيح اليوم عبر UTC. */
function iso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** أول يوم في الشهر الذي يبعد `offset` عن الشهر الحالي. */
function monthStart(offset: number): Date {
  return new Date(FIRST_OF_THIS_MONTH.getFullYear(), FIRST_OF_THIS_MONTH.getMonth() + offset, 1);
}

/** آخر يوم في الشهر الذي يبعد `offset` عن الشهر الحالي. */
function monthEnd(offset: number): Date {
  return new Date(
    FIRST_OF_THIS_MONTH.getFullYear(),
    FIRST_OF_THIS_MONTH.getMonth() + offset + 1,
    0,
  );
}

/**
 * صف واحد من نتيجة الـRPC.
 */
interface TotalRow {
  property_id: string;
  monthly_total: string;
}

/**
 * ينادَي الـRPC ويرجع خريطة مبنى ← إجمالي.
 */
async function totals(
  client: PoolClient,
  period: string | null | undefined,
): Promise<Map<string, number>> {
  const { rows } =
    period === undefined
      ? await client.query<TotalRow>(`select * from public.get_property_monthly_rent_totals()`)
      : await client.query<TotalRow>(
          `select * from public.get_property_monthly_rent_totals($1::date)`,
          [period],
        );
  return new Map(rows.map((row) => [row.property_id, Number(row.monthly_total)]));
}

/**
 * مستخدم يحمل دوراً (admin يملك كل الصلاحيات ومنها properties.read).
 *
 * The plan names moduleSummaries.sqltest.ts for this helper, but no such helper
 * exists there — it only creates a permission-less user. The real pattern lives
 * in anonExecute.sqltest.ts (`seedUserWithRole`) and is copied from there.
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

interface RentScenario {
  aPropertyId: string;
  bPropertyId: string;
  sPropertyId: string;
}

/**
 * يزرع المشهد الكامل: عقدان أحاديا الوحدة (300 و200)، وعقد مشترك (300+200)
 * تُنقل وحدتاه إلى مبنيي العقدين، ثم حالات الحذف من الإجمالي.
 *
 * Units of the exclusion fixtures are moved into A's/B's buildings so their
 * original (now empty) properties stay out of the result for the right reason.
 */
async function seedRentScenario(client: PoolClient): Promise<RentScenario> {
  const termStart = iso(monthStart(-12));
  const termEnd = iso(monthEnd(12));

  const a = await seedContract(client, {
    startDate: termStart,
    endDate: termEnd,
    units: [{ monthlyAmount: 300 }],
  });
  const b = await seedContract(client, {
    startDate: termStart,
    endDate: termEnd,
    units: [{ monthlyAmount: 200 }],
  });
  const s = await seedContract(client, {
    startDate: termStart,
    endDate: termEnd,
    units: [{ monthlyAmount: 300 }, { monthlyAmount: 200 }],
  });
  await client.query(`update public.units set property_id = $1 where id = $2`, [
    a.propertyId,
    s.unitIds[0],
  ]);
  await client.query(`update public.units set property_id = $1 where id = $2`, [
    b.propertyId,
    s.unitIds[1],
  ]);

  // R: past its increase anniversary at the current month (start 24 months ago,
  // +2 years → effective first of this month), so this month bills 150.
  // DEVIATION from the plan (which says increase_after_years = 1): with the
  // pricer comparing on date_trunc('month'), after_years = 1 makes the
  // (current month − 12) probe land exactly ON the effective month and bill the
  // increased rent, contradicting the "base rent before the anniversary"
  // assertion. after_years = 2 keeps both assertions true.
  const r = await seedContract(client, {
    startDate: iso(monthStart(-24)),
    endDate: iso(monthEnd(36)),
    units: [{ monthlyAmount: 100 }],
  });
  await client.query(`update public.units set property_id = $1 where id = $2`, [
    a.propertyId,
    r.unitId,
  ]);
  await client.query(
    `update public.contracts set increase_after_years = 2, increase_type = 'percent', increase_value = 50 where id = $1`,
    [r.contractId],
  );

  // F: starts 13 months ahead — a future contract bills nothing this month.
  const f = await seedContract(client, {
    startDate: iso(monthStart(13)),
    endDate: iso(monthEnd(36)),
    units: [{ monthlyAmount: 400 }],
  });
  await client.query(`update public.units set property_id = $1 where id = $2`, [
    a.propertyId,
    f.unitId,
  ]);

  // E: still `active` but its end_date was last month — expired, excluded.
  const e = await seedContract(client, {
    startDate: iso(monthStart(-24)),
    endDate: iso(monthEnd(-1)),
    state: "active",
    units: [{ monthlyAmount: 500 }],
  });
  await client.query(`update public.units set property_id = $1 where id = $2`, [
    a.propertyId,
    e.unitId,
  ]);

  // X: archived — excluded even though the term covers this month.
  const x = await seedContract(client, {
    startDate: termStart,
    endDate: termEnd,
    units: [{ monthlyAmount: 600 }],
  });
  await client.query(`update public.units set property_id = $1 where id = $2`, [
    a.propertyId,
    x.unitId,
  ]);
  await client.query(`update public.contracts set archived_at = now() where id = $1`, [
    x.contractId,
  ]);

  // T: terminated — excluded even though the term covers this month.
  const t = await seedContract(client, {
    startDate: termStart,
    endDate: termEnd,
    state: "terminated",
    units: [{ monthlyAmount: 900 }],
  });
  await client.query(`update public.units set property_id = $1 where id = $2`, [
    a.propertyId,
    t.unitId,
  ]);

  // C: this month is a free month (12 free months from the first of this
  // month) — excluded from B this month, the way the invoice generator skips
  // it via period_in_free_months.
  const c = await seedContract(client, {
    startDate: termStart,
    endDate: termEnd,
    units: [{ monthlyAmount: 250 }],
  });
  await client.query(`update public.units set property_id = $1 where id = $2`, [
    b.propertyId,
    c.unitId,
  ]);
  await client.query(
    `insert into public.concessions
       (contract_id, type, status, start_date, end_date, free_months)
     values ($1, 'free_months', 'active', $2::date, $3::date, 12)`,
    [c.contractId, iso(monthStart(0)), iso(monthEnd(11))],
  );

  return { aPropertyId: a.propertyId, bPropertyId: b.propertyId, sPropertyId: s.propertyId };
}

describe("get_property_monthly_rent_totals", () => {
  test("sums collectible rent per building: A 300+300+150, B 200+200", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const fx = await seedRentScenario(client);
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const result = await totals(client, undefined);

      // A: own 300 + shared unit 300 + R at the increased 150.
      expect(result.get(fx.aPropertyId)).toBe(750);
      // B: own 200 + shared unit 200; C excluded as a free month.
      expect(result.get(fx.bPropertyId)).toBe(400);
      // S's original building is empty after the move — absent, not zero.
      expect(result.has(fx.sPropertyId)).toBe(false);
    });
  });

  test("a period before the anniversary bills the base rent", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const fx = await seedRentScenario(client);
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const result = await totals(client, iso(monthStart(-12)));

      // A: 300 + 300 + R at base 100 + E's 500 (still in term twelve months
      // ago; it expires only at the end of last month). X/T stay excluded.
      expect(result.get(fx.aPropertyId)).toBe(1200);
    });
  });

  test("a NULL period behaves as the current month", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      await seedRentScenario(client);
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const { rows: fromNull } = await client.query<TotalRow>(
        `select * from public.get_property_monthly_rent_totals(null::date) order by property_id`,
      );
      const { rows: fromDefault } = await client.query<TotalRow>(
        `select * from public.get_property_monthly_rent_totals() order by property_id`,
      );
      // A SQL default covers only an OMITTED argument — without the coalesce
      // inside, an explicit NULL would match nothing.
      expect(fromNull).toEqual(fromDefault);
      expect(fromNull.length).toBeGreaterThan(0);
    });
  });

  test("anon cannot execute it", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const { rows } = await client.query<{ allowed: boolean }>(
        `select has_function_privilege('anon', 'public.get_property_monthly_rent_totals(date)', 'execute') as allowed`,
      );
      expect(rows[0].allowed).toBe(false);
      const { rows: authRows } = await client.query<{ allowed: boolean }>(
        `select has_function_privilege('authenticated', 'public.get_property_monthly_rent_totals(date)', 'execute') as allowed`,
      );
      expect(authRows[0].allowed).toBe(true);

      await actAs(client, "anon");
      const error = await captureRaiseError(client, () =>
        client.query(`select * from public.get_property_monthly_rent_totals()`),
      );
      expect(error).not.toBeNull();
      expect((error as { code?: string }).code).toBe("42501");
    });
  });

  test("an authenticated user without properties.read is refused", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      await seedRentScenario(client);
      const { rows } = await client.query<{ id: string }>(
        `insert into auth.users (id, instance_id, aud, role, email)
         values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
                 'authenticated', 'authenticated', 'nobody-rent-totals@example.test')
         returning id`,
      );
      // No role assignment, so has_permission() returns false for every code.
      await actAs(client, "authenticated", rows[0].id);
      const message = await captureRaise(client, () =>
        client.query(`select * from public.get_property_monthly_rent_totals()`),
      );
      expect(message).toMatch(/Permission denied/);
    });
  });
});
