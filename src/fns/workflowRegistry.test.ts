import { beforeEach, describe, expect, test, vi } from "vitest";

const maybeSingle = vi.fn();
const rpc = vi.fn();

const TEST_COMPANY = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "danat",
  status: "active" as const,
};

vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => TEST_COMPANY,
  requireRequestCompany: () => TEST_COMPANY,
  runWithRequestCompany: async (_company: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    rpc: (...args: unknown[]) => rpc(...args),
  }),
}));

const { isWorkflowPaused, recordWorkflowRun, readWorkflowGate, runEventWorkflow } =
  await import("./workflowRegistry");

const ALL_TARGETS = ["admin", "company", "tenant"] as const;

beforeEach(() => {
  vi.clearAllMocks();
  maybeSingle.mockResolvedValue({
    data: { is_active: true, recipient_targets: [...ALL_TARGETS] },
    error: null,
  });
  rpc.mockResolvedValue({ data: null, error: null });
});

describe("readWorkflowGate", () => {
  test("returns paused and targets from one row", async () => {
    maybeSingle.mockResolvedValueOnce({
      data: { is_active: false, recipient_targets: ["company", "tenant"] },
      error: null,
    });
    await expect(readWorkflowGate("payment-succeeded")).resolves.toEqual({
      paused: true,
      targets: ["company", "tenant"],
    });
  });

  test("fails open on error", async () => {
    // Observability must never become a single point of failure for the thing
    // it observes. notifyPaymentSuccess sits on the MyFatoorah path — a
    // registry outage must not stop a tenant receiving their receipt.
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(readWorkflowGate("payment-succeeded")).resolves.toEqual({
      paused: false,
      targets: [...ALL_TARGETS],
    });
  });

  test("an unregistered key fails open", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(readWorkflowGate("never-seeded")).resolves.toEqual({
      paused: false,
      targets: [...ALL_TARGETS],
    });
  });

  test("missing recipient_targets fails open to all three", async () => {
    maybeSingle.mockResolvedValueOnce({ data: { is_active: true }, error: null });
    await expect(readWorkflowGate("payment-succeeded")).resolves.toEqual({
      paused: false,
      targets: [...ALL_TARGETS],
    });
  });
});

describe("isWorkflowPaused", () => {
  test("reports a paused workflow", async () => {
    maybeSingle.mockResolvedValueOnce({
      data: { is_active: false, recipient_targets: ["admin"] },
      error: null,
    });
    await expect(isWorkflowPaused("deposit-confirmed")).resolves.toBe(true);
  });

  test("an unreadable registry fails OPEN", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(isWorkflowPaused("payment-succeeded")).resolves.toBe(false);
  });

  test("an unregistered key is not treated as paused", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(isWorkflowPaused("never-seeded")).resolves.toBe(false);
  });
});

describe("recordWorkflowRun", () => {
  test("records through the shared RPC", async () => {
    await recordWorkflowRun("deposit-confirmed", "success", 42, null);
    expect(rpc).toHaveBeenCalledWith("record_cron_run", {
      _key: "deposit-confirmed",
      _status: "success",
      _duration_ms: 42,
      _error: null,
    });
  });

  test("swallows its own failure", async () => {
    // Recording that a workflow ran must never make the workflow report
    // failure.
    rpc.mockRejectedValueOnce(new Error("registry down"));
    await expect(recordWorkflowRun("x", "success", 1, null)).resolves.toBeUndefined();
  });
});

describe("runEventWorkflow", () => {
  test("a paused workflow does not run its body", async () => {
    // The defect this guards against is a switch that is written and never
    // read: it looks correct in the UI and passes any test that only asserts
    // the mutation succeeded.
    maybeSingle.mockResolvedValueOnce({
      data: { is_active: false, recipient_targets: [...ALL_TARGETS] },
      error: null,
    });
    const run = vi.fn().mockResolvedValue({ ran: true });

    const result = await runEventWorkflow({
      key: "deposit-confirmed",
      whenPaused: () => ({ ran: false }),
      run,
    });

    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({ ran: false });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "deposit-confirmed", _status: "skipped" }),
    );
  });

  test("an active workflow runs its body and records success", async () => {
    // The mirror of the test above: a gate that rejected everything would pass
    // that one and be just as broken.
    const run = vi.fn().mockResolvedValue({ ran: true });

    const result = await runEventWorkflow({
      key: "deposit-confirmed",
      whenPaused: () => ({ ran: false }),
      run,
    });

    expect(run).toHaveBeenCalledWith([...ALL_TARGETS]);
    expect(result).toEqual({ ran: true });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "deposit-confirmed", _status: "success", _error: null }),
    );
  });

  test("threads the row's recipient targets into run", async () => {
    maybeSingle.mockResolvedValueOnce({
      data: { is_active: true, recipient_targets: ["company"] },
      error: null,
    });
    const run = vi.fn().mockResolvedValue("ok");

    await runEventWorkflow({
      key: "payment-succeeded",
      whenPaused: () => "skipped",
      run,
    });

    expect(run).toHaveBeenCalledWith(["company"]);
  });

  test("a thrown body records the error and rethrows", async () => {
    const run = vi.fn().mockRejectedValue(new Error("smtp refused"));

    await expect(
      runEventWorkflow({ key: "deposit-confirmed", whenPaused: () => null, run }),
    ).rejects.toThrow(/smtp refused/);

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _status: "error", _error: "smtp refused" }),
    );
  });

  test("outcomeOf can record a nothing-to-do result as skipped, not failed", async () => {
    // The case this exists for: a declined KNET transaction makes
    // notifyPaymentSuccess return { ok: false, error: "No confirmed payments." },
    // which is the correct outcome. Recording it as an error would leave a
    // permanent red Failed badge on the monitoring tab.
    const run = vi.fn().mockResolvedValue({ ok: false, nothingToDo: true, error: "nothing" });

    const result = await runEventWorkflow({
      key: "payment-succeeded",
      whenPaused: () => ({ ok: true, nothingToDo: false, error: "" }),
      run,
      outcomeOf: (value: { nothingToDo: boolean; error: string }) =>
        value.nothingToDo
          ? { status: "skipped" as const, error: value.error }
          : { status: "error" as const, error: value.error },
    });

    expect(result).toMatchObject({ ok: false });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _status: "skipped", _error: "nothing" }),
    );
  });

  test("outcomeOf can still record a genuine failure as an error", async () => {
    // The mirror of the test above: a classifier that called everything skipped
    // would pass that one and hide every real breakage.
    const run = vi.fn().mockResolvedValue({ nothingToDo: false, error: "smtp refused" });

    await runEventWorkflow({
      key: "payment-succeeded",
      whenPaused: () => ({ nothingToDo: false, error: "" }),
      run,
      outcomeOf: (value: { nothingToDo: boolean; error: string }) =>
        value.nothingToDo
          ? { status: "skipped" as const, error: value.error }
          : { status: "error" as const, error: value.error },
    });

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _status: "error", _error: "smtp refused" }),
    );
  });

  test("without outcomeOf a returned result is a success", async () => {
    const run = vi.fn().mockResolvedValue({ ids: ["a"] });

    await runEventWorkflow({
      key: "user-credentials-tenant",
      whenPaused: () => ({ ids: [] }),
      run,
    });

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _status: "success", _error: null }),
    );
  });

  test("an unreadable registry still runs the body with all targets", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    const run = vi.fn().mockResolvedValue("sent");

    await expect(
      runEventWorkflow({ key: "payment-succeeded", whenPaused: () => "skipped", run }),
    ).resolves.toBe("sent");
    expect(run).toHaveBeenCalledWith([...ALL_TARGETS]);
  });
});
