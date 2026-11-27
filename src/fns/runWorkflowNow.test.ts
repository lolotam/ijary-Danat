import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => {
  const fn: any = (data: any) => {
    return fn._handler({ data, context: fn._context });
  };
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.inputValidator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((h: any) => {
    fn._handler = h;
    return fn;
  });
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middlewareFn: any) => middlewareFn),
    }),
  };
});

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

vi.mock("@/company/hostCompany.server", () => ({
  listActiveCompanies: vi.fn().mockResolvedValue([]),
}));

const overdue = vi.fn();
vi.mock("@/fns/evaluateOverdue.server", () => ({
  runEvaluateOverdueJob: (...a: unknown[]) => overdue(...a),
}));
vi.mock("@/fns/overdueRemindersJob", () => ({ runOverdueRemindersJob: vi.fn() }));
vi.mock("@/fns/contractExpiryJob.server", () => ({ runContractExpiryJob: vi.fn() }));
vi.mock("@/fns/scheduledReportsJob.server", () => ({ runScheduledReportsJob: vi.fn() }));
vi.mock("@/fns/notificationDrainJob", () => ({ runNotificationDrainJob: vi.fn() }));
vi.mock("@/fns/gmailSyncJob", () => ({ runGmailSyncJob: vi.fn() }));
vi.mock("@/fns/salariesJob", () => ({ runSalariesJob: vi.fn() }));
const runBackupJob = vi.fn();
vi.mock("@/fns/backupJob", () => ({ runBackupJob: (...a: unknown[]) => runBackupJob(...a) }));

const isWorkflowPaused = vi.fn();
const recordWorkflowRun = vi.fn();
vi.mock("@/fns/workflowRegistry", () => ({
  isWorkflowPaused: (...a: unknown[]) => isWorkflowPaused(...a),
  recordWorkflowRun: (...a: unknown[]) => recordWorkflowRun(...a),
}));

import { runWorkflowNow } from "./runWorkflowNow";

function callRun(
  input: { key: string; asOf?: string | null },
  opts: {
    allowed?: boolean;
    permissionError?: { message: string } | null;
    isAdmin?: boolean;
  } = {},
) {
  const { allowed = true, permissionError = null, isAdmin = true } = opts;
  const mockRpc = vi.fn().mockImplementation((rpcName: string) => {
    if (rpcName === "has_permission") {
      return Promise.resolve({ data: allowed, error: permissionError });
    }
    if (rpcName === "has_role") {
      return Promise.resolve({ data: isAdmin, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });

  const gFn = runWorkflowNow as any;
  gFn._context = {
    supabase: { rpc: mockRpc },
    userId: "test-user-id",
  };

  return { result: gFn(input), mockRpc };
}

// File-scoped so every describe below starts from clean mocks — the shared
// per-job lock lives in module state, and stale call counts across tests
// would make the concurrency assertions below lie.
beforeEach(() => {
  vi.clearAllMocks();
  isWorkflowPaused.mockResolvedValue(false);
  recordWorkflowRun.mockResolvedValue(undefined);
  overdue.mockResolvedValue({ count: 1 });
});

describe("runWorkflowNow", () => {
  it("throws Error (not Response) when the caller lacks permission", async () => {
    const { result, mockRpc } = callRun({ key: "overdue" }, { allowed: false });

    const error = await result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(Response);
    expect((error as Error).message).toMatch(/permission denied/i);

    expect(mockRpc).toHaveBeenCalledWith("has_permission", {
      _code: "invoices.update",
      _user_id: "test-user-id",
    });
    expect(overdue).not.toHaveBeenCalled();
    expect(recordWorkflowRun).not.toHaveBeenCalled();
  });

  it("refuses the backup job to a caller without settings.backup", async () => {
    // Backup writes a full copy of the database, secrets included. It must gate
    // on the dedicated code, not a general one like company.update.
    const { result, mockRpc } = callRun({ key: "backup" }, { allowed: false });

    const error = await result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(mockRpc).toHaveBeenCalledWith("has_permission", {
      _code: "settings.backup",
      _user_id: "test-user-id",
    });
    expect(runBackupJob).not.toHaveBeenCalled();
    expect(recordWorkflowRun).not.toHaveBeenCalled();
  });

  it("runs the backup job for a non-admin who holds settings.backup", async () => {
    // The permission is the whole gate now; no admin role check sits on top.
    runBackupJob.mockResolvedValue({ created: "backup-id" });

    const { result } = callRun({ key: "backup" }, { allowed: true, isAdmin: false });

    await expect(result).resolves.toMatchObject({ job: "backup", skipped: false });
    expect(runBackupJob).toHaveBeenCalledTimes(1);
  });

  it("rejects an event key — there is no payload to replay", async () => {
    const { result } = callRun({ key: "payment-succeeded" });

    await expect(result).rejects.toThrow(/scheduled/i);
    expect(overdue).not.toHaveBeenCalled();
    expect(recordWorkflowRun).not.toHaveBeenCalled();
  });

  it("runs the job and records success for a permitted, unpaused key", async () => {
    // The primary behaviour. Without this the suite would pass even if the
    // dispatcher never invoked the job at all — every other test here asserts
    // the job did NOT run.
    const { result } = callRun({ key: "overdue", asOf: "2026-08-03" });

    await expect(result).resolves.toEqual({
      job: "overdue",
      durationMs: expect.any(Number),
      result: { count: 1 },
      skipped: false,
    });

    expect(overdue).toHaveBeenCalledWith("2026-08-03");
    expect(recordWorkflowRun).toHaveBeenCalledWith("overdue", "success", expect.any(Number), null);
  });

  it("records the error and rethrows when the job fails", async () => {
    // The registry must show a failed manual run, otherwise the Workflows tab
    // reports the last successful run and the failure is invisible.
    overdue.mockRejectedValueOnce(new Error("overdue exploded"));

    const { result } = callRun({ key: "overdue" });

    await expect(result).rejects.toThrow("overdue exploded");
    expect(recordWorkflowRun).toHaveBeenCalledWith(
      "overdue",
      "error",
      expect.any(Number),
      "overdue exploded",
    );
  });

  it("records skipped when the workflow is paused, without running the job", async () => {
    isWorkflowPaused.mockResolvedValueOnce(true);

    const { result } = callRun({ key: "overdue" });
    await expect(result).resolves.toEqual({
      job: "overdue",
      durationMs: 0,
      skipped: true,
    });

    expect(overdue).not.toHaveBeenCalled();
    expect(recordWorkflowRun).toHaveBeenCalledWith("overdue", "skipped", 0, null);
  });
});

describe("runWorkflowNow: one run at a time per job", () => {
  // The lock is the same one respondToCronRequest holds (audit H4): before it
  // was shared, pressing Run now while a cron tick of the same job was
  // mid-flight reproduced exactly the 2026-09-01/02 double-fire.

  it("refuses a second run of the same job while the first is in flight", async () => {
    // The refusal must be a thrown Error — a thrown Response would resolve
    // as success on the client via x-tss-raw and toast a "run started".
    let finish!: (value: unknown) => void;
    overdue.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));

    const { result: first } = callRun({ key: "overdue" });
    await Promise.resolve();
    const { result: second } = callRun({ key: "overdue" });

    const error = await second.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(Response);
    expect((error as Error).message).toMatch(/already running/i);

    expect(overdue).toHaveBeenCalledTimes(1);

    finish({ count: 1 });
    await expect(first).resolves.toMatchObject({ job: "overdue", skipped: false });

    // The refused call records nothing — the in-flight run records itself.
    expect(recordWorkflowRun).toHaveBeenCalledTimes(1);
    expect(recordWorkflowRun).toHaveBeenCalledWith("overdue", "success", expect.any(Number), null);
  });

  it("allows a different job through while one is in flight", async () => {
    let finishOverdue!: (value: unknown) => void;
    overdue.mockImplementationOnce(() => new Promise((resolve) => (finishOverdue = resolve)));
    runBackupJob.mockResolvedValueOnce({ created: "backup-id" });

    const { result: first } = callRun({ key: "overdue" });
    await Promise.resolve();
    const { result: second } = callRun({ key: "backup" });

    await expect(second).resolves.toMatchObject({ job: "backup", skipped: false });
    expect(runBackupJob).toHaveBeenCalledTimes(1);

    finishOverdue({ count: 1 });
    await expect(first).resolves.toMatchObject({ job: "overdue", skipped: false });
  });

  it("releases the lock when the job throws, so the next run succeeds", async () => {
    // The finally regression guard: a throwing job must not wedge the lock,
    // or one failed run would refuse every run after it.
    overdue.mockRejectedValueOnce(new Error("boom"));

    const { result: first } = callRun({ key: "overdue" });
    await expect(first).rejects.toThrow("boom");

    const { result: second } = callRun({ key: "overdue" });
    await expect(second).resolves.toMatchObject({ job: "overdue", skipped: false });
    expect(overdue).toHaveBeenCalledTimes(2);
  });
});
