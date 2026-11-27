import { describe, expect, test, vi } from "vitest";

// The scheduler reaches Postgres through the service-role client. The unit
// tests drive it through its port, so the real client must never be built.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {},
}));

import { JOB_CATALOG, type JobKind } from "@/jobs/catalog";
import { WORKFLOW_CATALOG } from "@/lib/workflowCatalog";
import {
  companyMoment,
  fanOut,
  SCHEDULES,
  type FanOutRow,
  type ScheduleDefinition,
  type SchedulerDatabase,
} from "@/worker/scheduler";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const SUSPENDED_COMPANY = "33333333-3333-4333-8333-333333333333";
const REPORT_SCHEDULE = "44444444-4444-4444-8444-444444444444";
const GMAIL_CONNECTION = "55555555-5555-4555-8555-555555555555";

/** لحظة إطلاق الجدول: 01:10 بتوقيت الكويت من يوم 28 نوفمبر 2026. */
const FIRED_AT = new Date("2026-11-27T22:10:00Z");

/** الجدول الزمني المطلوب، من جدول المجدولات نفسه. */
function scheduleFor(kind: JobKind): ScheduleDefinition {
  const schedule = SCHEDULES.find((entry) => entry.kind === kind);
  if (!schedule) throw new Error(`no schedule for ${kind}`);
  return schedule;
}

/**
 * منفذ قاعدة بيانات وهمي: يحفظ الصفوف الموزّعة ويطبّق قيد منع التكرار
 * `(company_id, kind, dedupe_key)` كما يفعل الفهرس في القاعدة.
 */
function fakeDatabase(overrides: Partial<SchedulerDatabase> = {}): {
  db: SchedulerDatabase;
  rows: FanOutRow[];
} {
  const rows: FanOutRow[] = [];
  const db: SchedulerDatabase = {
    listCompanies: vi.fn().mockResolvedValue([
      { id: COMPANY_A, status: "active" },
      { id: COMPANY_B, status: "active" },
    ]),
    pausedCompanyIds: vi.fn().mockResolvedValue([]),
    dueReportSchedules: vi.fn().mockResolvedValue([]),
    gmailConnections: vi.fn().mockResolvedValue([]),
    insertJobRequest: vi.fn(async (row: FanOutRow) => {
      const filed = rows.some(
        (existing) =>
          existing.companyId === row.companyId &&
          existing.kind === row.kind &&
          existing.dedupeKey === row.dedupeKey,
      );
      if (!filed) rows.push(row);
    }),
    ...overrides,
  };
  return { db, rows };
}

describe("the scheduler's company moment", () => {
  test.each([
    {
      at: "2026-11-27T22:10:00Z",
      moment: { date: "2026-11-28", month: "2026-11", window: "2026-11-28T01:10" },
    },
    {
      at: "2026-11-27T20:59:00Z",
      moment: { date: "2026-11-27", month: "2026-11", window: "2026-11-27T23:50" },
    },
    {
      at: "2026-11-30T21:05:00Z",
      moment: { date: "2026-12-01", month: "2026-12", window: "2026-12-01T00:00" },
    },
  ])("the slot of $at is the company time", ({ at, moment }) => {
    expect(companyMoment(new Date(at))).toEqual(moment);
  });
});

describe("the scheduler's fan-out", () => {
  test("one fire files one row per active company", async () => {
    const { db, rows } = fakeDatabase();

    const filed = await fanOut(scheduleFor("overdue.evaluate"), db, FIRED_AT);

    expect(filed).toBe(2);
    expect(rows).toEqual([
      {
        companyId: COMPANY_A,
        kind: "overdue.evaluate",
        payload: { date: "2026-11-28" },
        dedupeKey: `overdue.evaluate__${COMPANY_A}__2026-11-28`,
      },
      {
        companyId: COMPANY_B,
        kind: "overdue.evaluate",
        payload: { date: "2026-11-28" },
        dedupeKey: `overdue.evaluate__${COMPANY_B}__2026-11-28`,
      },
    ]);
  });

  test("a suspended company gets no row", async () => {
    const { db, rows } = fakeDatabase({
      listCompanies: vi.fn().mockResolvedValue([
        { id: COMPANY_A, status: "active" },
        { id: SUSPENDED_COMPANY, status: "suspended" },
      ]),
    });

    await fanOut(scheduleFor("overdue.evaluate"), db, FIRED_AT);

    expect(rows.map((row) => row.companyId)).toEqual([COMPANY_A]);
  });

  test("a company that paused the workflow gets no row", async () => {
    const pausedCompanyIds = vi.fn().mockResolvedValue([COMPANY_B]);
    const { db, rows } = fakeDatabase({ pausedCompanyIds });

    await fanOut(scheduleFor("overdue.evaluate"), db, FIRED_AT);

    expect(pausedCompanyIds).toHaveBeenCalledWith("overdue");
    expect(rows.map((row) => row.companyId)).toEqual([COMPANY_A]);
  });

  test("a second fire for the same slot files no new row", async () => {
    const { db, rows } = fakeDatabase();

    await fanOut(scheduleFor("overdue.evaluate"), db, FIRED_AT);
    await fanOut(scheduleFor("overdue.evaluate"), db, FIRED_AT);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.dedupeKey)).toEqual([
      `overdue.evaluate__${COMPANY_A}__2026-11-28`,
      `overdue.evaluate__${COMPANY_B}__2026-11-28`,
    ]);
  });

  test("the report schedule files one row per due schedule", async () => {
    const { db, rows } = fakeDatabase({
      dueReportSchedules: vi
        .fn()
        .mockResolvedValue([{ companyId: COMPANY_A, scheduleId: REPORT_SCHEDULE }]),
    });

    await fanOut(scheduleFor("report.run"), db, FIRED_AT);

    expect(rows).toEqual([
      {
        companyId: COMPANY_A,
        kind: "report.run",
        payload: { scheduleId: REPORT_SCHEDULE, date: "2026-11-28" },
        dedupeKey: `report.run:${REPORT_SCHEDULE}:2026-11-28`,
      },
    ]);
  });

  test("the gmail schedule files one row per connected mailbox", async () => {
    const { db, rows } = fakeDatabase({
      gmailConnections: vi
        .fn()
        .mockResolvedValue([{ companyId: COMPANY_A, connectionId: GMAIL_CONNECTION }]),
    });

    await fanOut(scheduleFor("gmail.sync"), db, FIRED_AT);

    expect(rows).toEqual([
      {
        companyId: COMPANY_A,
        kind: "gmail.sync",
        payload: { connectionId: GMAIL_CONNECTION },
        dedupeKey: `gmail.sync__${COMPANY_A}__2026-11-28T01:10`,
      },
    ]);
  });

  test("the nightly export files one row per active, unpaused company with the day slot key", async () => {
    const pausedCompanyIds = vi.fn().mockResolvedValue([COMPANY_B]);
    const { db, rows } = fakeDatabase({
      listCompanies: vi.fn().mockResolvedValue([
        { id: COMPANY_A, status: "active" },
        { id: COMPANY_B, status: "active" },
        { id: SUSPENDED_COMPANY, status: "suspended" },
      ]),
      pausedCompanyIds,
    });

    const filed = await fanOut(scheduleFor("company.export"), db, FIRED_AT);

    // The pause switch the fan-out reads is the backup workflow's own, so an
    // admin who paused backups gets no nightly export.
    expect(pausedCompanyIds).toHaveBeenCalledWith("backup");
    expect(filed).toBe(1);
    expect(rows).toEqual([
      {
        companyId: COMPANY_A,
        kind: "company.export",
        // A backup is a snapshot of the moment it runs, so the row carries no
        // reference date — the day lives in the dedupe slot alone.
        payload: {},
        dedupeKey: `company.export__${COMPANY_A}__2026-11-28`,
      },
    ]);

    await fanOut(scheduleFor("company.export"), db, FIRED_AT);
    expect(rows).toHaveLength(1);
  });

  test.each(SCHEDULES)(
    "the $kind row carries a payload the catalogue accepts",
    async (schedule) => {
      const { db, rows } = fakeDatabase({
        dueReportSchedules: vi
          .fn()
          .mockResolvedValue([{ companyId: COMPANY_A, scheduleId: REPORT_SCHEDULE }]),
        gmailConnections: vi
          .fn()
          .mockResolvedValue([{ companyId: COMPANY_A, connectionId: GMAIL_CONNECTION }]),
      });

      await fanOut(schedule, db, FIRED_AT);

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(() => JOB_CATALOG[row.kind].payload.parse(row.payload)).not.toThrow();
      }
    },
  );

  test.each(SCHEDULES)("the $kind cadence is the one the workflow catalogue shows", (schedule) => {
    // The admin panel prints the catalogue's cadence; a panel that promises a
    // time the worker does not keep is worse than no panel.
    expect(WORKFLOW_CATALOG[schedule.registryKey]?.schedule).toBe(schedule.pattern);
  });
});
