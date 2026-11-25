import { beforeEach, describe, expect, test, vi } from "vitest";

const maybeSingle = vi.fn();
const rpc = vi.fn();
const claimed = vi.fn();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle }),
      }),
    }),
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

const overdue = vi.fn();
vi.mock("@/fns/evaluateOverdue", () => ({
  runEvaluateOverdueJob: (...a: unknown[]) => overdue(...a),
}));
vi.mock("@/fns/overdueRemindersJob", () => ({ runOverdueRemindersJob: vi.fn() }));
vi.mock("@/fns/contractExpiryJob", () => ({ runContractExpiryJob: vi.fn() }));
vi.mock("@/fns/scheduledReportsJob", () => ({ runScheduledReportsJob: vi.fn() }));
vi.mock("@/fns/notificationDrainJob", () => ({ runNotificationDrainJob: vi.fn() }));
vi.mock("@/fns/gmailSyncJob", () => ({ runGmailSyncJob: vi.fn() }));
vi.mock("@/fns/salariesJob", () => ({ runSalariesJob: vi.fn() }));
const reconcile = vi.fn();
vi.mock("@/fns/paymentReconcileJob", () => ({
  runPaymentReconcileJob: (...a: unknown[]) => reconcile(...a),
}));
vi.mock("@/lib/cronAuth", () => ({
  isValidCronSecret: async () => true,
  readCronSecretHeader: () => "secret",
}));

const { respondToCronRequest } = await import("./cronJobs");

function cronRequest(job: string) {
  return new Request("https://example.test/api/public/cron", {
    method: "POST",
    body: JSON.stringify({ job }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "secret";
  maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
  claimed.mockResolvedValue({ data: true, error: null });
  rpc.mockImplementation((fn: string) =>
    fn === "claim_cron_run" ? claimed() : Promise.resolve({ data: null, error: null }),
  );
  overdue.mockResolvedValue({ updated: 3 });
});

describe("paused jobs", () => {
  test("a paused job is skipped rather than run", async () => {
    maybeSingle.mockResolvedValueOnce({ data: { is_active: false }, error: null });

    const response = await respondToCronRequest(cronRequest("overdue"));

    expect(overdue).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ job: "overdue", skipped: true });
  });

  test("skipping answers 200, not an error", async () => {
    // A paused job is a deliberate admin decision. Returning 5xx would make
    // every cron tick alert on something someone switched off on purpose.
    maybeSingle.mockResolvedValueOnce({ data: { is_active: false }, error: null });
    const response = await respondToCronRequest(cronRequest("overdue"));
    expect(response.ok).toBe(true);
  });

  test("an unreadable registry fails OPEN — the job still runs", async () => {
    // Observability must never become a single point of failure for the thing
    // it observes. A registry outage must not silently stop invoices being
    // marked overdue.
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } });

    const response = await respondToCronRequest(cronRequest("overdue"));

    expect(overdue).toHaveBeenCalled();
    expect(response.status).toBe(200);
  });
});

describe("run recording", () => {
  test("a successful run records status and duration", async () => {
    await respondToCronRequest(cronRequest("overdue"));

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "overdue", _status: "success", _error: null }),
    );
  });

  test("a failed run records the error and still reports durationMs", async () => {
    // durationMs used to be reported only on success, which made a slow failure
    // indistinguishable from a fast one.
    overdue.mockRejectedValueOnce(new Error("job exploded"));

    const response = await respondToCronRequest(cronRequest("overdue"));

    expect(response.status).toBe(500);
    const body = (await response.json()) as { durationMs?: number; error?: string };
    expect(body.error).toBe("job exploded");
    expect(typeof body.durationMs).toBe("number");
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _status: "error", _error: "job exploded" }),
    );
  });

  test("a failure to record does not turn a successful run into a failure", async () => {
    rpc.mockImplementation((fn: string) =>
      fn === "record_cron_run"
        ? Promise.reject(new Error("registry down"))
        : Promise.resolve({ data: true, error: null }),
    );
    const response = await respondToCronRequest(cronRequest("overdue"));
    expect(response.status).toBe(200);
  });
});

describe("one run at a time per job", () => {
  test("a second request while the job is still running is refused, not run twice", async () => {
    // 2026-09-01 and 09-02: overdue-reminders, contract-expiry and the drain
    // each ran twice within the same second, doubling the WhatsApp burst that
    // preceded the device being unlinked. Whatever fires the duplicate, the
    // process must not execute the same job concurrently with itself.
    let finish!: (value: unknown) => void;
    overdue.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));

    const first = respondToCronRequest(cronRequest("overdue"));
    await Promise.resolve();
    const second = await respondToCronRequest(cronRequest("overdue"));

    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toMatch(/already running/i);
    expect(overdue).toHaveBeenCalledTimes(1);

    finish({ updated: 1 });
    expect((await first).status).toBe(200);

    // Released once the first run settles — the next tick runs normally.
    const third = await respondToCronRequest(cronRequest("overdue"));
    expect(third.status).toBe(200);
    expect(overdue).toHaveBeenCalledTimes(2);
  });

  test("the lock is released when the job throws", async () => {
    overdue.mockRejectedValueOnce(new Error("boom"));
    await respondToCronRequest(cronRequest("overdue"));

    const next = await respondToCronRequest(cronRequest("overdue"));
    expect(next.status).toBe(200);
  });

  test("a different job runs while one is in flight — the lock is per job", async () => {
    // The incident was the SAME job racing itself. Two DIFFERENT jobs running
    // concurrently is normal — ticks overlap — so the lock must key on the
    // job name, not the process.
    let finishOverdue!: (value: unknown) => void;
    overdue.mockImplementationOnce(() => new Promise((resolve) => (finishOverdue = resolve)));
    reconcile.mockResolvedValueOnce({ count: 0, settled: 0, failed: 0, errors: [] });

    const first = respondToCronRequest(cronRequest("overdue"));
    const second = await respondToCronRequest(cronRequest("payment-reconcile"));

    // `overdue` is still mid-flight here, yet payment-reconcile went through.
    expect(second.status).toBe(200);
    expect(reconcile).toHaveBeenCalledTimes(1);

    finishOverdue({ updated: 1 });
    expect((await first).status).toBe(200);
    expect(overdue).toHaveBeenCalledTimes(1);
  });
});

describe("database claim (migration 229)", () => {
  test("a duplicate that arrives after the first run finished is refused, not run again", async () => {
    // 2026-09-23/24: contract-expiry and notification-drain ran twice ~0.5 s
    // apart, AFTER the first run had returned, so the in-process lock was
    // already released. Only the database claim can see that second call.
    const first = await respondToCronRequest(cronRequest("overdue"));
    claimed.mockResolvedValueOnce({ data: false, error: null });
    const second = await respondToCronRequest(cronRequest("overdue"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(overdue).toHaveBeenCalledTimes(1);
  });

  test("a claim that cannot be checked fails OPEN — the job still runs", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    claimed.mockRejectedValueOnce(new Error("fetch failed"));

    const response = await respondToCronRequest(cronRequest("overdue"));

    expect(response.status).toBe(200);
    expect(overdue).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  test("a claim answered with an error result also fails OPEN", async () => {
    // supabase-js reports most failures as { error } rather than throwing;
    // reading that as "not claimed" would silently skip the night's run.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    claimed.mockResolvedValueOnce({ data: null, error: { message: "permission denied" } });

    const response = await respondToCronRequest(cronRequest("overdue"));

    expect(response.status).toBe(200);
    expect(overdue).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  test("a paused job is not claimed, so un-pausing does not wait out the window", async () => {
    maybeSingle.mockResolvedValueOnce({ data: { is_active: false }, error: null });

    await respondToCronRequest(cronRequest("overdue"));

    expect(claimed).not.toHaveBeenCalled();
  });
});

describe("validation still applies", () => {
  test("an unknown job is rejected before anything is recorded", async () => {
    const response = await respondToCronRequest(cronRequest("not-a-job"));
    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  test("salaries is a registered job", async () => {
    const response = await respondToCronRequest(cronRequest("salaries"));
    expect(response.status).toBe(200);
  });

  test("an event workflow key is not dispatchable as a cron job", async () => {
    // Event rows now share the cron_jobs table. That must not widen what
    // POST /api/public/cron will run: isCronJobName tests membership of the
    // hardcoded JOBS map, and no event key is in it.
    const response = await respondToCronRequest(cronRequest("deposit-confirmed"));
    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("payment-reconcile job", () => {
  test("is routable from the cron endpoint", async () => {
    reconcile.mockResolvedValue({ count: 1, settled: 1, failed: 0, errors: [] });

    const response = await respondToCronRequest(cronRequest("payment-reconcile"));

    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalled();
  });
});
