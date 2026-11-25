import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import {
  actAs,
  actAsSuperuser,
  captureRaiseError,
  closePool,
  seedContract,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 241 — weekly overdue-by-contract report.
 *
 * One row per contract holding overdue invoices (state 'overdue' with a
 * positive balance, archived contracts excluded), ordered by total desc, plus
 * the WEEKLY-OVERDUE-REPORT seed that copies its recipients from
 * 7-DAYS-REPORT and always starts inactive.
 */
const MIGRATION_241_SQL = readFileSync(
  resolve(process.cwd(), "db/migrations/241_overdue_contracts_report.sql"),
  "utf8",
);

/** جملة الزرع في الهجرة: تُنفَّذ وحدها داخل التراجع لاختبار النسخ. */
const SEED_INSERT_SQL = MIGRATION_241_SQL.slice(
  MIGRATION_241_SQL.indexOf("insert into public.report_schedules"),
);

/** ينشئ مستخدماً بدور معين حتى تُحسم `has_permission` لصالحه. */
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

interface InvoiceHome {
  contractId: string;
  tenantId: string;
  companyId: string;
  unitId: string;
}

/**
 * تُدخل فاتورة بمبلغ وحالة معلومين؛ الرصيد محسوب تلقائياً (total − paid).
 *
 * `balance` is GENERATED ALWAYS, so tests set total/paid and read the balance
 * back — writing it directly would fail.
 */
async function insertFixtureInvoice(
  client: PoolClient,
  home: InvoiceHome,
  options: { year: number; month: number; total: number; paid?: number; state: string },
): Promise<void> {
  const tag = randomUUID().slice(0, 8);
  await client.query(
    `insert into public.invoices
       (contract_id, tenant_id, company_id, unit_id, period_year, period_month,
        issue_date, due_date, subtotal, total, paid, state, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, current_date, current_date, $7, $7, $8,
             $9::public.invoice_states, $10)`,
    [
      home.contractId,
      home.tenantId,
      home.companyId,
      home.unitId,
      options.year,
      options.month,
      options.total,
      options.paid ?? 0,
      options.state,
      `od:${tag}`,
    ],
  );
}

/**
 * تُنشئ عقداً إضافياً على المستأجر نفسه مع وحدة خاصة به.
 *
 * seedContract builds one tenant per contract; the report groups per contract
 * under one party name, so the second and archived contracts must share the
 * first tenant explicitly.
 */
async function seedExtraContract(
  client: PoolClient,
  tenantId: string,
  propertyId: string,
  archived: boolean,
): Promise<{ contractId: string; unitId: string; code: string }> {
  const tag = randomUUID().slice(0, 8);
  const code = `C-od-${tag}`;
  const { rows: units } = await client.query<{ id: string }>(
    `insert into public.units (code, property_id, name) values ($1, $2, $3) returning id`,
    [`U-od-${tag}`, propertyId, `Unit od ${tag}`],
  );
  const { rows: contracts } = await client.query<{ id: string }>(
    `insert into public.contracts (code, tenant_id, start_date, end_date, state)
     values ($1, $2, '2026-01-01', '2026-12-31', 'active')
     returning id`,
    [code, tenantId],
  );
  await client.query(
    `insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
     values ($1, $2, 500, 1)`,
    [contracts[0].id, units[0].id],
  );
  if (archived) {
    await client.query(`update public.contracts set archived_at = now() where id = $1`, [
      contracts[0].id,
    ]);
  }
  return { contractId: contracts[0].id, unitId: units[0].id, code };
}

/**
 * تُنشئ جدول تقرير متأخرات خاصاً بالاختبار حتى لا يعتمد على الصف المزروع.
 */
async function seedOverdueSchedule(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.report_schedules
       (code, name_ar, name_en, frequency, recipients, locale, is_active, report_kind)
     values ($1, $2, $3, 'weekly', '[]'::jsonb, 'ar'::public.locale_code, true, 'overdue_contracts')
     returning id`,
    [`TEST-OVERDUE-${tag}`, `تقرير اختبار ${tag}`, `Test report ${tag}`],
  );
  return rows[0].id;
}

interface OverdueSetup {
  scheduleId: string;
  contractACode: string;
  contractBCode: string;
  archivedCode: string;
}

/**
 * تجهّز مستأجراً بعقدين متأخرين وعقد مؤرشف مستبعد.
 *
 * Contract A carries 2026-01 (100) + 2026-02 (50.5) + 2026-10 (25) overdue
 * alongside a `due` and a `paid` invoice that must not move its row; contract
 * B carries one overdue invoice; the archived contract's overdue invoice must
 * not appear at all.
 */
async function seedOverdueSetup(client: PoolClient): Promise<OverdueSetup> {
  const fx = await seedContract(client, { startDate: "2026-01-01", endDate: "2026-12-31" });
  await client.query(
    `update public.tenants set commercial_name_ar = 'شركة الاختبار' where id = $1`,
    [fx.tenantId],
  );
  const extraB = await seedExtraContract(client, fx.tenantId, fx.propertyId, false);
  const archived = await seedExtraContract(client, fx.tenantId, fx.propertyId, true);
  const homeA: InvoiceHome = {
    contractId: fx.contractId,
    tenantId: fx.tenantId,
    companyId: fx.companyId,
    unitId: fx.unitId,
  };
  await insertFixtureInvoice(client, homeA, { year: 2026, month: 1, total: 100, state: "overdue" });
  await insertFixtureInvoice(client, homeA, {
    year: 2026,
    month: 2,
    total: 50.5,
    state: "overdue",
  });
  await insertFixtureInvoice(client, homeA, { year: 2026, month: 10, total: 25, state: "overdue" });
  await insertFixtureInvoice(client, homeA, { year: 2026, month: 3, total: 999, state: "due" });
  await insertFixtureInvoice(client, homeA, {
    year: 2026,
    month: 4,
    total: 888,
    paid: 888,
    state: "paid",
  });
  await insertFixtureInvoice(
    client,
    {
      contractId: extraB.contractId,
      tenantId: fx.tenantId,
      companyId: fx.companyId,
      unitId: extraB.unitId,
    },
    { year: 2026, month: 5, total: 10, state: "overdue" },
  );
  await insertFixtureInvoice(
    client,
    {
      contractId: archived.contractId,
      tenantId: fx.tenantId,
      companyId: fx.companyId,
      unitId: archived.unitId,
    },
    { year: 2026, month: 6, total: 777, state: "overdue" },
  );
  const { rows: contracts } = await client.query<{ code: string }>(
    `select code from public.contracts where id = $1`,
    [fx.contractId],
  );
  return {
    scheduleId: await seedOverdueSchedule(client),
    contractACode: contracts[0].code,
    contractBCode: extraB.code,
    archivedCode: archived.code,
  };
}

interface BuiltReport {
  html: string;
  spanDays: number;
  endDiffDays: number;
}

/**
 * يبني التقرير لتاريخ معلوم ويعيد الـ HTML مع امتداد الفترة.
 *
 * The date arithmetic is asserted in SQL so the test stays green regardless
 * of the container's timezone; the period follows the schedule frequency
 * (see PERIOD_BY_FREQUENCY), it is not always [end − 6, end].
 */
async function buildReport(client: PoolClient, scheduleId: string): Promise<BuiltReport> {
  const { rows } = await client.query<{ html: string; span_days: number; end_diff_days: number }>(
    `select html,
            (period_end - period_start) as span_days,
            (period_end - $2::date) as end_diff_days
       from public.build_overdue_contracts_report_html($1, $2::date)`,
    [scheduleId, "2026-10-15"],
  );
  return { html: rows[0].html, spanDays: rows[0].span_days, endDiffDays: rows[0].end_diff_days };
}

/**
 * تمتد الفترة بتكرار الجدول (يومي/أسبوعي/شهري/سنوي) مثل باني الملخص في 143.
 *
 * p_as_of ثابت (2026-10-15) حتى تُحسم القيم المتوقعة: نفس اليوم لليومي،
 * end−6 للأسبوعي، أول الشهر للشهري، وأول السنة للسنوي.
 */
const PERIOD_BY_FREQUENCY = [
  { frequency: "daily", expectedStart: "2026-10-15", expectedEnd: "2026-10-15" },
  { frequency: "weekly", expectedStart: "2026-10-09", expectedEnd: "2026-10-15" },
  { frequency: "monthly", expectedStart: "2026-10-01", expectedEnd: "2026-10-15" },
  { frequency: "yearly", expectedStart: "2026-01-01", expectedEnd: "2026-10-15" },
] as const;

/** يعيد صف `<tr>` الذي يحمل رقم عقد معين من الـ HTML. */
function tableRowFor(html: string, contractCode: string): string {
  const row = html.split("<tr>").find((chunk) => chunk.includes(contractCode));
  if (!row) throw new Error(`no table row carries contract ${contractCode}`);
  return row;
}

describe("overdue-by-contract report body", () => {
  test("contract A shows month count, من/إلى labels and formatted total", async () => {
    await withRollback(async (client) => {
      const setup = await seedOverdueSetup(client);
      const report = await buildReport(client, setup.scheduleId);

      expect(report.endDiffDays).toBe(0);
      expect(report.html).toContain("شركة الاختبار");
      const rowA = tableRowFor(report.html, setup.contractACode);
      // Three distinct overdue months; the due (999) and paid (888) invoices
      // on the same contract must not move this row.
      expect(rowA).toContain(">3<");
      expect(rowA).toContain("يناير 2026");
      expect(rowA).toContain("أكتوبر 2026");
      expect(rowA).toContain("175.500 KWD");
      expect(rowA).not.toContain("999.000");
      expect(rowA).not.toContain("888.000");
    });
  });

  /**
   * تمتد الفترة بتكرار الجدول؛ التكرار يُحدَّث داخل التراجع حتى لا يتسرب.
   *
   * The overdue rows stay a snapshot "as of v_end" — only the period label
   * moves with the frequency, so the mislabelling Codex flagged on PR #266
   * (seven-day period on daily/monthly/yearly schedules) cannot regress.
   */
  test.each(PERIOD_BY_FREQUENCY)(
    "period matches schedule frequency $frequency",
    async ({ frequency, expectedStart, expectedEnd }) => {
      await withRollback(async (client) => {
        const setup = await seedOverdueSetup(client);
        await client.query(`update public.report_schedules set frequency = $1 where id = $2`, [
          frequency,
          setup.scheduleId,
        ]);
        const { rows } = await client.query<{
          period_start: string;
          period_end: string;
        }>(
          `select period_start::text as period_start, period_end::text as period_end
             from public.build_overdue_contracts_report_html($1, '2026-10-15'::date)`,
          [setup.scheduleId],
        );
        expect(rows[0].period_start).toBe(expectedStart);
        expect(rows[0].period_end).toBe(expectedEnd);
      });
    },
  );

  test("each contract gets its own row, ordered by total desc", async () => {
    await withRollback(async (client) => {
      const setup = await seedOverdueSetup(client);
      const report = await buildReport(client, setup.scheduleId);

      const rowB = tableRowFor(report.html, setup.contractBCode);
      expect(rowB).toContain(">1<");
      expect(rowB).toContain("10.000 KWD");
      // Relative order only: seeded demo overdue rows may sit anywhere else,
      // but A (175.500) must sort ahead of B (10.000).
      expect(report.html.indexOf(setup.contractACode)).toBeGreaterThanOrEqual(0);
      expect(report.html.indexOf(setup.contractACode)).toBeLessThan(
        report.html.indexOf(setup.contractBCode),
      );
    });
  });

  test("an archived contract's overdue invoice never appears", async () => {
    await withRollback(async (client) => {
      const setup = await seedOverdueSetup(client);
      const report = await buildReport(client, setup.scheduleId);

      expect(report.html).not.toContain(setup.archivedCode);
      expect(report.html).not.toContain("777.000");
    });
  });

  test("the footer total and count match the rows the report printed", async () => {
    await withRollback(async (client) => {
      const setup = await seedOverdueSetup(client);
      const report = await buildReport(client, setup.scheduleId);

      // Checked against the printed rows rather than a re-run of the builder's
      // own filter: a query mirroring the implementation would agree with it
      // even when the filter is wrong.
      const amount = (text: string) => Number(text.replace(/,/g, ""));
      const tbody = report.html.split("<tbody>")[1]!.split("</tbody>")[0]!;
      const rowTotals = [...tbody.matchAll(/([\d,]+\.\d{3}) KWD<\/td><\/tr>/g)].map((m) =>
        amount(m[1]!),
      );
      const footer = report.html.match(/([\d,]+\.\d{3}) KWD<\/td>\s*<\/tr>\s*<\/tfoot>/);
      const footerCount = report.html.match(/الإجمالي \((\d+) عقد\)/);

      expect(rowTotals.length).toBeGreaterThanOrEqual(2);
      expect(footer).not.toBeNull();
      expect(amount(footer![1]!)).toBeCloseTo(
        rowTotals.reduce((sum, value) => sum + value, 0),
        3,
      );
      expect(Number(footerCount![1])).toBe(rowTotals.length);
    });
  });

  test("no overdue invoices renders the empty state", async () => {
    await withRollback(async (client) => {
      const setup = await seedOverdueSetup(client);
      await client.query(
        `update public.invoices
            set state = 'paid'::public.invoice_states, paid = total
          where state::text in ('due', 'overdue', 'partially_paid')`,
      );
      const report = await buildReport(client, setup.scheduleId);

      expect(report.html).toContain("لا توجد عقود متأخرة");
      expect(report.html).not.toContain("<table");
    });
  });
});

describe("overdue report permissions", () => {
  test("an authenticated user without reports.read gets 42501", async () => {
    await withRollback(async (client) => {
      const setup = await seedOverdueSetup(client);
      // Collector holds contracts.read and invoices.read but not reports.read.
      const collector = await seedUserWithRole(client, "collector");
      await actAs(client, "authenticated", collector);

      const error = (await captureRaiseError(client, () =>
        client.query(`select * from public.build_overdue_contracts_report_html($1, $2::date)`, [
          setup.scheduleId,
          "2026-10-15",
        ]),
      )) as { code?: string } | null;
      expect(error?.code).toBe("42501");
      await actAsSuperuser(client);
    });
  });

  test("a user with reports.read builds the report", async () => {
    // Proves the 42501 above is about the permission, not the fixture: the
    // same call succeeds for an admin holding reports.read.
    await withRollback(async (client) => {
      const setup = await seedOverdueSetup(client);
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      const { rows } = await client.query<{ html: string }>(
        `select html from public.build_overdue_contracts_report_html($1, $2::date)`,
        [setup.scheduleId, "2026-10-15"],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].html).toContain("شركة الاختبار");
      await actAsSuperuser(client);
    });
  });
});

describe("weekly overdue seed row", () => {
  test("the seeded row is an inactive weekly overdue_contracts schedule", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{
        frequency: string;
        report_kind: string;
        is_active: boolean;
        recipients: unknown;
      }>(
        `select frequency, report_kind, is_active, recipients
           from public.report_schedules
          where code = 'WEEKLY-OVERDUE-REPORT'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].frequency).toBe("weekly");
      expect(rows[0].report_kind).toBe("overdue_contracts");
      expect(rows[0].is_active).toBe(false);
    });
  });

  test("the seed copies recipients, locale and next run from 7-DAYS-REPORT only", async () => {
    await withRollback(async (client) => {
      await client.query(
        `delete from public.report_schedules where code = 'WEEKLY-OVERDUE-REPORT'`,
      );
      await client.query(
        `insert into public.report_schedules
           (code, name_ar, name_en, frequency, recipients, locale, is_active, next_run_at, report_kind)
         values ('7-DAYS-REPORT', 'تقرير أسبوعي', 'Weekly', 'weekly',
                 '["owner@example.test"]'::jsonb, 'en'::public.locale_code, true,
                 '2026-10-01T00:00:00Z', 'summary')`,
      );
      // A competing weekly schedule must not leak its values into the copy.
      await client.query(
        `insert into public.report_schedules
           (code, name_ar, name_en, frequency, recipients, locale, is_active, next_run_at, report_kind)
         values ('COMPETING-WEEKLY', 'منافس', 'Competing', 'weekly',
                 '["other@example.test"]'::jsonb, 'ar'::public.locale_code, true,
                 '2026-11-01T00:00:00Z', 'summary')`,
      );

      await client.query(SEED_INSERT_SQL);

      const { rows } = await client.query<{
        recipients: string[];
        locale: string;
        next_run_at: string | null;
        is_active: boolean;
        frequency: string;
        report_kind: string;
      }>(
        `select recipients, locale::text as locale, next_run_at::text,
                is_active, frequency, report_kind
           from public.report_schedules
          where code = 'WEEKLY-OVERDUE-REPORT'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].recipients).toEqual(["owner@example.test"]);
      expect(rows[0].locale).toBe("en");
      expect(rows[0].next_run_at).toContain("2026-10-01");
      // Always inactive until the new runner deploys, or the old builder
      // would email a summary mislabeled as the overdue report.
      expect(rows[0].is_active).toBe(false);
      expect(rows[0].frequency).toBe("weekly");
      expect(rows[0].report_kind).toBe("overdue_contracts");
    });
  });

  test("the seed without a source row falls back to empty recipients", async () => {
    await withRollback(async (client) => {
      await client.query(
        `delete from public.report_schedules where code = 'WEEKLY-OVERDUE-REPORT'`,
      );
      const { rows: sources } = await client.query<{ n: string }>(
        `select count(*)::text as n from public.report_schedules where code = '7-DAYS-REPORT'`,
      );
      expect(sources[0].n).toBe("0");

      await client.query(SEED_INSERT_SQL);

      const { rows } = await client.query<{
        recipients: unknown;
        locale: string;
        next_run_at: string | null;
        is_active: boolean;
      }>(
        `select recipients, locale::text as locale, next_run_at::text, is_active
           from public.report_schedules
          where code = 'WEEKLY-OVERDUE-REPORT'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].recipients).toEqual([]);
      expect(rows[0].locale).toBe("ar");
      expect(rows[0].next_run_at).toBeNull();
      expect(rows[0].is_active).toBe(false);
    });
  });
});
