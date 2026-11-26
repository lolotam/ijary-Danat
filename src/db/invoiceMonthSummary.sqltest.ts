import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { actAs, captureRaise, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

interface MonthRow {
  month: number;
  count: number;
  total: number;
  paid: number;
  outstanding: number;
  overdue: number;
}

/**
 * القيم الرقمية من Postgres تصل نصّاً (numeric وbigint)؛ يوحّدها Number
 * فلا تعتمد المقارنة على تمثيل العمود.
 */
function num(value: unknown): number {
  return Number(value ?? 0);
}

/**
 * يستدعي ملخّص الشهور لسنة ومبنى معيّن ويعيد الصفوف مرتّبة بالأشهر.
 */
async function summary(
  client: PoolClient,
  year: number,
  propertyId: string | null,
): Promise<MonthRow[]> {
  const { rows } = await client.query(`select * from public.get_invoice_month_summary($1, $2)`, [
    year,
    propertyId,
  ]);
  return rows.map((row) => ({
    month: num(row.month),
    count: num(row.count),
    total: num(row.total),
    paid: num(row.paid),
    outstanding: num(row.outstanding),
    overdue: num(row.overdue),
  }));
}

interface SplitScenario {
  companyId: string;
  aPropertyId: string;
  bPropertyId: string;
  cPropertyId: string;
  sContractId: string;
  sTenantId: string;
}

/**
 * يزرع عقدين أحاديي الوحدة (300 و200) وعقداً مشتركاً (300+200) ثم ينقل وحدتي
 * المشترك إلى مبنيي العقدين ويولّد فواتير 2029 للثلاثة.
 *
 * Both shared units move (finding 5): the shared invoice is 500 with a 0.6 /
 * 0.4 split, so property A totals 600 and property B 400 per month.
 */
async function seedSplitScenario(client: PoolClient): Promise<SplitScenario> {
  const a = await seedContract(client, {
    startDate: "2029-01-01",
    endDate: "2029-12-31",
    units: [{ monthlyAmount: 300 }],
  });
  const b = await seedContract(client, {
    companyId: a.companyId,
    startDate: "2029-01-01",
    endDate: "2029-12-31",
    units: [{ monthlyAmount: 200 }],
  });
  const s = await seedContract(client, {
    companyId: a.companyId,
    startDate: "2029-01-01",
    endDate: "2029-12-31",
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
  for (const contractId of [a.contractId, b.contractId, s.contractId]) {
    await client.query(`select * from public.generate_invoices_for_year($1, 2029, false)`, [
      contractId,
    ]);
  }
  return {
    companyId: a.companyId,
    aPropertyId: a.propertyId,
    bPropertyId: b.propertyId,
    cPropertyId: s.propertyId,
    sContractId: s.contractId,
    sTenantId: s.tenantId,
  };
}

/**
 * يسجّل دفعة مؤكّدة بمبلغ معلوم على فاتورة ويعيد حساب مدفوعها.
 *
 * Money goes through the real path — a confirmed `payments` row plus its
 * `payment_allocations` row, then `recompute_invoice_from_confirmed` — because
 * `invoices.balance` is generated and `paid` is trigger/routine maintained.
 */
async function payInvoice(
  client: PoolClient,
  companyId: string,
  tenantId: string,
  invoiceId: string,
  amount: number,
): Promise<void> {
  const payment = await client.query<{ id: string }>(
    `insert into public.payments (company_id, tenant_id, amount, method, status, payment_date)
     values ($1, $2, $3, 'cash', 'confirmed', '2029-01-15') returning id`,
    [companyId, tenantId, amount],
  );
  await client.query(
    `insert into public.payment_allocations (company_id, payment_id, invoice_id, amount)
     values ($1, $2, $3, $4)`,
    [companyId, payment.rows[0].id, invoiceId, amount],
  );
  await client.query(`select public.recompute_invoice_from_confirmed($1)`, [invoiceId]);
}

describe("get_invoice_month_summary", () => {
  test("null property aggregates whole invoices: 3 per month, 1000 total", async () => {
    await withRollback(async (client) => {
      await seedSplitScenario(client);
      const rows = await summary(client, 2029, null);
      expect(rows).toHaveLength(12);
      expect(rows.map((row) => row.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      for (const row of rows) {
        expect(row.count).toBe(3);
        expect(row.total).toBe(1000);
        expect(row.paid).toBe(0);
        expect(row.outstanding).toBe(1000);
        expect(row.overdue).toBe(0);
      }
    });
  });

  test("each property takes its own contract plus its share of the shared invoice", async () => {
    await withRollback(async (client) => {
      const fx = await seedSplitScenario(client);
      const aRows = await summary(client, 2029, fx.aPropertyId);
      const bRows = await summary(client, 2029, fx.bPropertyId);
      expect(aRows).toHaveLength(12);
      expect(bRows).toHaveLength(12);
      for (const row of aRows) {
        // 300 own + 500 × 0.6 shared.
        expect(row.count).toBe(2);
        expect(row.total).toBe(600);
      }
      for (const row of bRows) {
        // 200 own + 500 × 0.4 shared.
        expect(row.count).toBe(2);
        expect(row.total).toBe(400);
      }
    });
  });

  test("a partial payment on the shared invoice follows the same share", async () => {
    await withRollback(async (client) => {
      const fx = await seedSplitScenario(client);
      const { rows } = await client.query<{ id: string }>(
        `select id from public.invoices
          where contract_id = $1 and period_year = 2029 and period_month = 1`,
        [fx.sContractId],
      );
      await payInvoice(client, fx.companyId, fx.sTenantId, rows[0].id, 250);
      const aJanuary = (await summary(client, 2029, fx.aPropertyId))[0];
      const bJanuary = (await summary(client, 2029, fx.bPropertyId))[0];
      // B: own 200 unpaid + shared 250 × 0.4 paid of 500 × 0.4.
      expect(bJanuary.paid).toBe(100);
      expect(bJanuary.outstanding).toBe(300);
      // A: own 300 unpaid + shared 250 × 0.6 paid of 500 × 0.6.
      expect(aJanuary.paid).toBe(150);
      expect(aJanuary.outstanding).toBe(450);
    });
  });

  test("a zero-amount rent line still counts as a touch, with zero money", async () => {
    await withRollback(async (client) => {
      const fx = await seedSplitScenario(client);
      const tag = randomUUID().slice(0, 8);
      const unit = await client.query<{ id: string }>(
        `insert into public.units (company_id, code, property_id, name)
         values ($1, $2, $3, $4) returning id`,
        [fx.companyId, `UZ-${tag}`, fx.cPropertyId, `Zero unit ${tag}`],
      );
      const { rows } = await client.query<{ id: string }>(
        `select id from public.invoices
          where contract_id = $1 and period_year = 2029 and period_month = 2`,
        [fx.sContractId],
      );
      const invoiceId = rows[0].id;
      const { rows: lineRows } = await client.query<{ max: number }>(
        `select coalesce(max(line), 0) as max from public.invoice_items where invoice_id = $1`,
        [invoiceId],
      );
      await client.query(
        `insert into public.invoice_items
           (company_id, invoice_id, line, unit_id, description_ar, description_en,
            quantity, unit_price, discount_percent, amount, is_concession)
         values ($1, $2, $3, $4, 'بند صفري', 'Zero line', 1, 0, 0, 0, false)`,
        [fx.companyId, invoiceId, Number(lineRows[0].max) + 1, unit.rows[0].id],
      );
      const cRows = await summary(client, 2029, fx.cPropertyId);
      expect(cRows.filter((row) => row.count > 0).map((row) => row.month)).toEqual([2]);
      const february = cRows[1];
      expect(february.count).toBe(1);
      expect(february.total).toBe(0);
      expect(february.paid).toBe(0);
      expect(february.outstanding).toBe(0);
    });
  });

  test("thirds of a discounted dinar round once per month: 0.333 per building, 1 overall", async () => {
    await withRollback(async (client) => {
      const tag = randomUUID().slice(0, 8);
      const t = await seedContract(client, {
        startDate: "2030-01-01",
        endDate: "2030-12-31",
        units: [{ monthlyAmount: 1 }, { monthlyAmount: 1 }, { monthlyAmount: 1 }],
      });
      const extra: string[] = [];
      for (const suffix of ["X", "Y"]) {
        const { rows } = await client.query<{ id: string }>(
          `insert into public.properties (code, company_id, name_ar, name_en)
           values ($1, $2, $3, $4) returning id`,
          [`P-${tag}-${suffix}`, t.companyId, `عقار ${tag}-${suffix}`, `Property ${tag}-${suffix}`],
        );
        extra.push(rows[0].id);
      }
      const propertyIds = [t.propertyId, ...extra];
      await client.query(`update public.units set property_id = $1 where id = $2`, [
        extra[0],
        t.unitIds[1],
      ]);
      await client.query(`update public.units set property_id = $1 where id = $2`, [
        extra[1],
        t.unitIds[2],
      ]);
      await client.query(`select * from public.generate_invoices_for_year($1, 2030, false)`, [
        t.contractId,
      ]);
      // دينار واحد يُقسَّم أثلاثاً: الخصم يخفض الترويسة إلى 1 وبنود الإيجار
      // تبقى (1,1,1)، وهي الحالة التي ينتجها مسار الامتياز فعلياً.
      //
      // Why the header write-down, not "units of 1 each" as-is: with a header
      // total of 3 the share is still exactly one third, but 3 × (1/3) rounds
      // back up to 1.000 per building — no precision gap to pin, and certainly
      // not 0.333. The spec's canonical example is 1 KWD three ways
      // (0.333 + 0.333 + 0.333 vs 1), which needs a header total of 1 while
      // the rent lines stay equal. A fixed-amount concession leaves exactly
      // this state (subtotal 3, discount 2, total 1); the direct update below
      // reproduces it the way other sqltests set `paid` by hand.
      await client.query(
        `update public.invoices set discount = 2, total = 1
          where contract_id = $1 and period_year = 2030`,
        [t.contractId],
      );
      const januaryTotals: number[] = [];
      for (const propertyId of propertyIds) {
        const perProperty = await summary(client, 2030, propertyId);
        expect(perProperty).toHaveLength(12);
        for (const row of perProperty) {
          expect(row.count).toBe(1);
          expect(row.total).toBe(0.333);
          expect(row.paid).toBe(0);
          expect(row.outstanding).toBe(0.333);
        }
        januaryTotals.push(perProperty[0].total);
      }
      // Unrounded shares, rounded once per month: no remainder reconciliation.
      expect(januaryTotals.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0.999, 3);
      const whole = await summary(client, 2030, null);
      for (const row of whole) {
        expect(row.count).toBe(1);
        expect(row.total).toBe(1);
        expect(row.outstanding).toBe(1);
      }
    });
  });

  test("a property with no invoices returns 12 zero rows", async () => {
    await withRollback(async (client) => {
      const lonely = await seedContract(client, {
        startDate: "2029-01-01",
        endDate: "2029-12-31",
      });
      const rows = await summary(client, 2029, lonely.propertyId);
      expect(rows).toHaveLength(12);
      for (const row of rows) {
        expect(row).toEqual({
          month: row.month,
          count: 0,
          total: 0,
          paid: 0,
          outstanding: 0,
          overdue: 0,
        });
      }
    });
  });

  test("anon cannot execute but authenticated can", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ allowed: boolean }>(
        `select has_function_privilege('anon', 'public.get_invoice_month_summary(integer, uuid)', 'execute') as allowed`,
      );
      expect(rows[0].allowed).toBe(false);
      const { rows: authRows } = await client.query<{ allowed: boolean }>(
        `select has_function_privilege('authenticated', 'public.get_invoice_month_summary(integer, uuid)', 'execute') as allowed`,
      );
      expect(authRows[0].allowed).toBe(true);
    });
  });

  test("an authenticated user without invoices.read is refused", async () => {
    await withRollback(async (client) => {
      const company = await client.query<{ id: string }>(
        `insert into public.companies (name_ar, name_en) values ('شركة ملخص', 'Summary Co') returning id`,
      );
      const { rows } = await client.query<{ id: string }>(
        `insert into auth.users (id, instance_id, aud, role, email)
         values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
                 'authenticated', 'authenticated', 'nobody-summary@example.test')
         returning id`,
      );
      await client.query(
        `insert into public.profiles (id, company_id, display_name, is_active)
         values ($1, $2, 'No Role', true)
         on conflict (id) do update set company_id = excluded.company_id, is_active = true`,
        [rows[0].id, company.rows[0].id],
      );
      // No role assignment, so has_permission() returns false for every code.
      await actAs(client, "authenticated", rows[0].id);
      const message = await captureRaise(client, () =>
        client.query(`select * from public.get_invoice_month_summary(2029, null)`),
      );
      expect(message).toMatch(/Permission denied/);
    });
  });
});
