import { describe, test, expect, vi, beforeEach } from "vitest";
import { runBackupJob } from "@/fns/backupJob";
import * as backupCore from "@/fns/backupCore";
import { JOBS } from "@/fns/cronJobs";
import { WORKFLOW_CATALOG } from "@/lib/workflowCatalog";
import { periodKeyFor } from "@/lib/backupArchive";

const supabaseAdmin = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/fns/backupCore", () => ({
  createBackupArchive: vi.fn(),
  BACKUP_BUCKET: "backups",
  BACKUP_RETENTION_KEEP: 10,
  BACKUP_RETENTION_KEEP_PRE_RESTORE: 5,
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => supabaseAdmin,
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: "11111111-1111-4111-8111-111111111111",
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
}));

// `@/lib/backupArchive` is deliberately NOT mocked. It is pure and cheap, and
// the previous version of this file reimplemented `isBackupDue` inside a mock —
// so the job was asserted against a fake decision function, using a period key
// ("daily:mock") that the real one never produces. The test would have passed
// no matter what the real rules did. Let the real function run.

describe("runBackupJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (supabaseAdmin.rpc as any).mockResolvedValue({ data: null, error: null });
  });

  test("Parity: every key in the JOBS map has a WORKFLOW_CATALOG entry and vice versa for scheduled kinds", () => {
    const jobKeys = Object.keys(JOBS);
    const catalogScheduledKeys = Object.entries(WORKFLOW_CATALOG)
      .filter(([_, entry]) => entry.kind === "scheduled")
      .map(([key]) => key);

    for (const key of jobKeys) {
      expect(catalogScheduledKeys).toContain(key);
    }
    for (const key of catalogScheduledKeys) {
      expect(jobKeys).toContain(key);
    }
  });

  test("with both switches off creates nothing", async () => {
    const fromMock = vi.fn((table: string) => {
      if (table === "companies") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: { backup_daily_enabled: false, backup_weekly_enabled: false },
            error: null,
          }),
        };
      }
      if (table === "backups") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
        };
      }
      return {};
    });
    (supabaseAdmin.from as any) = fromMock;

    const result = await runBackupJob();
    expect(result.skipped).toBe("disabled");
    expect(backupCore.createBackupArchive).not.toHaveBeenCalled();
  });

  test("skips when this period's key already exists", async () => {
    const now = new Date();
    const fromMock = vi.fn((table: string) => {
      if (table === "companies") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: { backup_daily_enabled: true, backup_weekly_enabled: false },
            error: null,
          }),
        };
      }
      if (table === "backups") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [{ created_at: now.toISOString(), period_key: periodKeyFor("daily", now) }],
            error: null,
          }),
        };
      }
      return {};
    });
    (supabaseAdmin.from as any) = fromMock;

    const result = await runBackupJob();
    expect(result.skipped).toBe("already-done");
    expect(backupCore.createBackupArchive).not.toHaveBeenCalled();
  });

  test("creates exactly one when due", async () => {
    const fromMock = vi.fn((table: string) => {
      if (table === "companies") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: { backup_daily_enabled: true, backup_weekly_enabled: false },
            error: null,
          }),
        };
      }
      if (table === "backups") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
        };
      }
      return {};
    });
    (supabaseAdmin.from as any) = fromMock;

    (backupCore.createBackupArchive as any).mockResolvedValue({ id: "mock-id" });

    const result = await runBackupJob();
    expect(result.created).toBe("mock-id");
    expect(backupCore.createBackupArchive).toHaveBeenCalledTimes(1);
    expect(backupCore.createBackupArchive).toHaveBeenCalledWith({
      kind: "automatic",
      createdBy: null,
      periodKey: periodKeyFor("daily", new Date()),
    });
  });

  test("reports a racing unique-violation as skipped", async () => {
    const fromMock = vi.fn((table: string) => {
      if (table === "companies") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: { backup_daily_enabled: true, backup_weekly_enabled: false },
            error: null,
          }),
        };
      }
      if (table === "backups") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [], // Due!
            error: null,
          }),
        };
      }
      return {};
    });
    (supabaseAdmin.from as any) = fromMock;

    const duplicateError = new Error("duplicate key value");
    (duplicateError as any).code = "23505";
    (backupCore.createBackupArchive as any).mockRejectedValue(duplicateError);

    const result = await runBackupJob();
    expect(result.skipped).toBe("racing-tick-duplicate");
  });
});
