import { beforeEach, describe, expect, it, vi } from "vitest";

import { JOB_CATALOG } from "@/jobs/catalog";

import {
  createSyncFake,
  seedSyncTable,
  syncCompanyClientModule,
  syncRequestCompanyModule,
  type SyncFake,
} from "./sync.testkit";

// The handlers reach Postgres through the company client and the service-role
// client only through the scheduler's own module; the tests drive the former
// through the fake, so the real service-role client must never be built.
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/company/requestCompany.server", () => syncRequestCompanyModule());
vi.mock("@/company/companyClient.server", () => syncCompanyClientModule(fake));

const fake: SyncFake = createSyncFake();
const { createCompanyExportHandler } = await import("./syncExport");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const REQUESTER_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";

/** يشغّل معالج `company.export` لشركة ومهمة وحمولة معيّنة. */
function runExport(options: {
  payload: Record<string, unknown>;
  jobRequestId?: string;
  companyId?: string;
}) {
  const handler = createCompanyExportHandler();
  return handler({
    jobRequestId: options.jobRequestId ?? JOB_ID,
    companyId: options.companyId ?? COMPANY_A,
    payload: options.payload,
    attempt: 1,
  });
}

beforeEach(() => {
  fake.tables.clear();
  fake.objects.clear();
  fake.rpcs.length = 0;
  fake.jobs.length = 0;
  fake.restoreCalls.length = 0;
  fake.holdsAdminRole = true;
  fake.ingested.clear();
  seedSyncTable(fake, "cron_jobs", []);
});

describe("the company.export handler (manual request)", () => {
  it("creates one manual backup keyed to the job id and reports it", async () => {
    // The job id is the backup's natural key (`period_key`), so the row a
    // retry would find is written by the first run and by nothing else.
    seedSyncTable(fake, "job_requests", [
      { id: JOB_ID, company_id: COMPANY_A, requested_by: REQUESTER_ID, kind: "company.export" },
    ]);

    const result = (await runExport({ payload: { requestId: REQUEST_ID } })) as {
      backupId: string;
      created: number;
      skipped: number;
    };

    expect(result).toMatchObject({ created: 1, skipped: 0 });
    const backups = fake.tables.get("backups") ?? [];
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({
      id: result.backupId,
      kind: "manual",
      period_key: JOB_ID,
      created_by: REQUESTER_ID,
      company_id: COMPANY_A,
    });
    expect(fake.objects.size).toBe(1);
  });

  it("a second run of the same jobRequestId creates no second backup", async () => {
    seedSyncTable(fake, "job_requests", [
      { id: JOB_ID, company_id: COMPANY_A, requested_by: REQUESTER_ID, kind: "company.export" },
    ]);

    await runExport({ payload: { requestId: REQUEST_ID } });
    const second = (await runExport({ payload: { requestId: REQUEST_ID } })) as {
      created: number;
      skipped: number;
    };

    expect(second).toMatchObject({ created: 0, skipped: 1 });
    expect(fake.tables.get("backups")).toHaveLength(1);
  });

  it("finds nothing in a job request that belongs to another company", async () => {
    // The company and the requester come from the job row, never the payload:
    // a row outside this company is invisible to this company's client, so
    // there is nothing to run.
    seedSyncTable(fake, "job_requests", [
      { id: JOB_ID, company_id: COMPANY_B, requested_by: REQUESTER_ID, kind: "company.export" },
    ]);

    await expect(runExport({ payload: { requestId: REQUEST_ID } })).rejects.toThrow(/not found/);
    expect(fake.tables.get("backups")).toBeUndefined();
    expect(fake.rpcs.filter((call) => call.name === "backup_dump_all")).toEqual([]);
  });
});

describe("the company.export handler (nightly fan-out)", () => {
  beforeEach(() => {
    seedSyncTable(fake, "companies", [
      { id: COMPANY_A, backup_daily_enabled: true, backup_weekly_enabled: false },
    ]);
    seedSyncTable(fake, "backups", []);
    seedSyncTable(fake, "job_requests", [
      { id: JOB_ID, company_id: COMPANY_A, requested_by: null, kind: "company.export" },
    ]);
  });

  it("runs the automatic backup for the company and records the run", async () => {
    const result = await runExport({ payload: {} });

    expect(result).toMatchObject({ companyId: COMPANY_A, skipped: false });
    const backups = fake.tables.get("backups") ?? [];
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ kind: "automatic", created_by: null });
    expect(String(backups[0].period_key)).toMatch(/^d:\d{4}-\d{2}-\d{2}$/);
    expect(fake.rpcs.some((call) => call.name === "record_cron_run")).toBe(true);
  });

  it("a second run of the same jobRequestId finds the period done and backs up nothing", async () => {
    await runExport({ payload: {} });
    await runExport({ payload: {} });

    // `runBackupJob` reads the newest automatic period key before writing, so
    // the second run reports already-done instead of snapshotting twice.
    expect(fake.tables.get("backups")).toHaveLength(1);
  });

  it("skips a company that paused the backup workflow", async () => {
    seedSyncTable(fake, "cron_jobs", [{ key: "backup", is_active: false, recipient_targets: [] }]);

    const result = await runExport({ payload: {} });

    expect(result).toMatchObject({ companyId: COMPANY_A, skipped: true });
    expect(fake.rpcs.filter((call) => call.name === "backup_dump_all")).toEqual([]);
    expect(fake.tables.get("backups")).toHaveLength(0);
  });

  it("skips a company that turned automatic backups off", async () => {
    seedSyncTable(fake, "companies", [
      { id: COMPANY_A, backup_daily_enabled: false, backup_weekly_enabled: false },
    ]);

    const result = (await runExport({ payload: {} })) as { result?: { skipped?: string } };

    expect(result.result?.skipped).toBe("disabled");
    expect(fake.tables.get("backups")).toHaveLength(0);
  });
});

describe("the company.export payload", () => {
  it.each([
    { name: "a manual request's id", payload: { requestId: REQUEST_ID } },
    { name: "the nightly fan-out's empty payload", payload: {} },
  ])("is catalogue-valid for $name", ({ payload }) => {
    expect(() => JOB_CATALOG["company.export"].payload.parse(payload)).not.toThrow();
  });

  it("rejects a stray field", () => {
    // Strict schemas are how a payload that grew a field by accident fails
    // loudly instead of being ignored.
    expect(() =>
      JOB_CATALOG["company.export"].payload.parse({ requestId: REQUEST_ID, note: "hi" }),
    ).toThrow();
  });
});
