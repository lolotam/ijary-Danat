import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildArchive, sha256Hex } from "@/lib/backupArchive";

import {
  createSyncFake,
  seedSyncTable,
  syncCompanyClientModule,
  syncRequestCompanyModule,
  type SyncFake,
} from "./sync.testkit";

// The handler reaches Postgres through the company client and the service-role
// client only through the scheduler's own module; the tests drive the former
// through the fake, so the real service-role client must never be built.
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/company/requestCompany.server", () => syncRequestCompanyModule());
vi.mock("@/company/companyClient.server", () => syncCompanyClientModule(fake));

const fake: SyncFake = createSyncFake();
const { createCompanyRestoreHandler } = await import("./syncRestore");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const REQUESTER_ID = "44444444-4444-4444-8444-444444444444";
const BACKUP_ID = "55555555-5555-4555-8555-555555555555";

/** الأرشيف الحقيقي الذي تستعيده الاختبارات، مع تجزئته الصحيحة. */
const archive = buildArchive([], {
  kind: "manual",
  createdAt: new Date(),
  schemaFingerprint: "test-fingerprint",
});

/** يشغّل معالج `company.restore` لشركة ونسخة وحمولة معيّنة. */
function runRestore(options: { backupId?: string; companyId?: string }) {
  const handler = createCompanyRestoreHandler();
  return handler({
    jobRequestId: JOB_ID,
    companyId: options.companyId ?? COMPANY_A,
    payload: { requestId: options.backupId ?? BACKUP_ID },
    attempt: 1,
  });
}

/** يزرع صف طلب ونسخة احتياطية سليمة التجزئة لشركة واحدة. */
async function seedRestoreTarget(companyId: string): Promise<void> {
  seedSyncTable(fake, "job_requests", [
    { id: JOB_ID, company_id: companyId, requested_by: REQUESTER_ID, kind: "company.restore" },
  ]);
  seedSyncTable(fake, "backups", [
    {
      id: BACKUP_ID,
      company_id: companyId,
      kind: "manual",
      storage_path: "p.zip",
      sha256: await sha256Hex(new Uint8Array(archive.bytes)),
    },
  ]);
  fake.objects.set("backups/p.zip", new Uint8Array(archive.bytes));
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

describe("the company.restore handler", () => {
  it("restores once, with a pre-restore safety archive keyed to the job id", async () => {
    await seedRestoreTarget(COMPANY_A);

    const result = (await runRestore({})) as { safetyBackupId: string; report: unknown };

    expect(fake.restoreCalls).toHaveLength(1);
    expect(fake.restoreCalls[0]).toMatchObject({ _actor: REQUESTER_ID });
    const backups = fake.tables.get("backups") ?? [];
    const safety = backups.find((row) => row.kind === "pre_restore");
    expect(safety).toMatchObject({
      id: result.safetyBackupId,
      period_key: JOB_ID,
      created_by: REQUESTER_ID,
    });
  });

  it("a second run of the same jobRequestId restores nothing twice", async () => {
    await seedRestoreTarget(COMPANY_A);

    await runRestore({});
    const second = (await runRestore({})) as { restored: boolean; skipped: number };

    // The safety archive the first run keyed to this job id is the marker the
    // second run reads before touching the database again.
    expect(second).toMatchObject({ restored: false, skipped: 1 });
    expect(fake.restoreCalls).toHaveLength(1);
    expect(
      (fake.tables.get("backups") ?? []).filter((row) => row.kind === "pre_restore"),
    ).toHaveLength(1);
  });

  it("finds nothing in a backup that belongs to another company", async () => {
    await seedRestoreTarget(COMPANY_B);

    await expect(runRestore({ companyId: COMPANY_A })).rejects.toThrow(/not found/i);
    expect(fake.restoreCalls).toEqual([]);
  });

  it("refuses when the requester is no longer an administrator", async () => {
    // The request passed the admin-role gate; the run re-checks it, because a
    // requester demoted between the click and the run must not get their
    // destructive restore.
    await seedRestoreTarget(COMPANY_A);
    fake.holdsAdminRole = false;

    await expect(runRestore({})).rejects.toThrow(/no longer an administrator/);
    expect(fake.restoreCalls).toEqual([]);
    expect(fake.tables.get("backups") ?? []).not.toContainEqual(
      expect.objectContaining({ kind: "pre_restore" }),
    );
  });

  it("refuses a restore job that never had a requester to re-check", async () => {
    await seedRestoreTarget(COMPANY_A);
    seedSyncTable(fake, "job_requests", [
      { id: JOB_ID, company_id: COMPANY_A, requested_by: null, kind: "company.restore" },
    ]);

    await expect(runRestore({})).rejects.toThrow(/no requester/);
    expect(fake.restoreCalls).toEqual([]);
  });
});
