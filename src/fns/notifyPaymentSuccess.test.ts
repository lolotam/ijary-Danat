import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@tanstack/react-start", () => {
  const fn: {
    (input: { data: unknown; context: unknown }): unknown;
    _handler?: (args: { data: unknown; context: unknown }) => unknown;
    middleware: ReturnType<typeof vi.fn>;
    inputValidator: ReturnType<typeof vi.fn>;
    validator: ReturnType<typeof vi.fn>;
    handler: ReturnType<typeof vi.fn>;
  } = ((args: { data: unknown; context: unknown }) => fn._handler?.(args)) as never;
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.inputValidator = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((h) => {
    fn._handler = h;
    return fn;
  });
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middlewareFn) => middlewareFn),
    }),
  };
});

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const PAYMENT_A = "22222222-2222-4222-8222-222222222222";
const PAYMENT_B = "cccccccc-3333-4ccc-8ccc-cccccccccccc";

const maybeSingle = vi.fn();
const rpc = vi.fn();

// The workflow registry is the only thing the request reads: the switch, and
// the row it records the run in. The receipt itself belongs to the worker.
const dbClient = {
  from: (table: string) => {
    if (table === "cron_jobs") {
      return { select: () => ({ eq: () => ({ maybeSingle }) }) };
    }
    throw new Error(`Unexpected table in test: ${table}`);
  },
  rpc: (...args: unknown[]) => rpc(...args),
};

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => dbClient,
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));

const { notifyManualPaymentInvoice, notifyPaymentSuccess } =
  await import("./notifyPaymentSuccess.server");
const { notifyPaymentSuccessFn } = await import("./notifyPaymentSuccess");

const context = {
  userId: "user-1",
  supabase: { rpc: async () => ({ data: true, error: null }) },
};

const notifyFromTheButton = (paymentIds: string[]) =>
  (
    notifyPaymentSuccessFn as unknown as (a: {
      data: unknown;
      context: unknown;
    }) => Promise<unknown>
  )({ data: { paymentIds }, context });

/** The outbox inserts the request made, without the registry's own writes. */
function enqueueCalls(): unknown[][] {
  return rpc.mock.calls.filter(([name]) => name === "enqueue_job");
}

beforeEach(() => {
  vi.clearAllMocks();
  maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
  rpc.mockImplementation(async (name: string) =>
    name === "enqueue_job" ? { data: "job-1", error: null } : { data: null, error: null },
  );
});

describe("the payment-succeeded workflow switch", () => {
  test("a paused workflow queues nothing", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });

    const result = await notifyPaymentSuccess([PAYMENT_A]);

    expect(enqueueCalls()).toHaveLength(0);
    expect(result).toMatchObject({ skipped: true });
  });

  test("pausing records against this workflow's own key", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });

    await notifyPaymentSuccess([PAYMENT_A]);

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "payment-succeeded", _status: "skipped" }),
    );
  });

  test("a paused workflow reports ok, not failure", async () => {
    // This sits on the MyFatoorah path. A deliberate pause must not look like a
    // payment-notification failure to the webhook that logs the result.
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });

    const result = await notifyPaymentSuccess([PAYMENT_A]);

    expect(result).toMatchObject({ ok: true });
  });
});

describe("classifying what the sender did", () => {
  test("having nothing to send records skipped, not failed", async () => {
    // "No payment ids." is a correct outcome, not a break: recording it as an
    // error would leave a permanent red Failed badge on the monitoring tab and
    // train admins to ignore it.
    const result = await notifyPaymentSuccess([]);

    expect(result).toMatchObject({ ok: false });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "payment-succeeded", _status: "skipped" }),
    );
  });

  test("a nothing-to-do result is never recorded as a success either", async () => {
    // The other half of the same claim: a green row would say a receipt went
    // out when none did.
    await notifyPaymentSuccess([]);

    const statuses = rpc.mock.calls
      .filter(([name]) => name === "record_cron_run")
      .map(([, args]) => (args as { _status: string })._status);
    expect(statuses).not.toContain("success");
  });

  test("a genuine failure still records an error, not a skip", async () => {
    // The mirror of the two tests above, and the one that stops the fix from
    // rotting: `nothingToDo` is tagged on two returns three lines away from the
    // catch block's return. If someone ever tags the catch too, every real
    // breakage would silently become a grey Skipped badge — and without this
    // test, nothing would fail.
    rpc.mockImplementation(async (name: string) =>
      name === "enqueue_job"
        ? { data: null, error: { message: "connection lost" } }
        : { data: null, error: null },
    );

    const result = await notifyPaymentSuccess([PAYMENT_A]);

    expect(result).toMatchObject({ ok: false });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({
        _key: "payment-succeeded",
        _status: "error",
        _error: expect.stringContaining("connection lost"),
      }),
    );
  });
});

describe("the payment.receipt job the sender queues", () => {
  test("queues one job per payment whose payload matches the catalogue", async () => {
    const result = await notifyPaymentSuccess([PAYMENT_A, PAYMENT_B]);

    // One row in the outbox per payment. The payloads reached it only because
    // they passed the catalogue's schema: `enqueueJob` parses before the insert.
    expect(enqueueCalls()).toHaveLength(2);
    expect(enqueueCalls().map(([, args]) => (args as { _payload: unknown })._payload)).toEqual([
      { paymentId: PAYMENT_A, workflow: "payment-succeeded" },
      { paymentId: PAYMENT_B, workflow: "payment-succeeded" },
    ]);
    expect(result).toMatchObject({ ok: true, skipped: false });
  });

  test("the manual settlement queues the receipt under its own workflow", async () => {
    // The worker judges the receipt by the workflow the request ran under, so
    // the manual settlement must not travel as the card payment's.
    await notifyManualPaymentInvoice([PAYMENT_A]);

    const args = enqueueCalls()[0]?.[1] as { _payload: { workflow: string } };
    expect(args._payload.workflow).toBe("manual-payment-invoice");
  });

  test("the money path deduplicates the receipt of one payment", async () => {
    // The gateway webhook and the reconciliation run can reach the same
    // payment, and the receipt must go out once.
    await notifyPaymentSuccess([PAYMENT_A]);

    const args = enqueueCalls()[0]?.[1] as { _dedupe_key: string | null };
    expect(args._dedupe_key).toBe(`payment.receipt:${PAYMENT_A}`);
  });

  test("the manual button queues the same job without a dedupe key", async () => {
    // An admin re-sending a receipt on purpose must not be stopped by a key
    // left over from an earlier send.
    const result = (await notifyFromTheButton([PAYMENT_A])) as {
      queued: boolean;
      jobRequestIds: string[];
    };

    expect(enqueueCalls()).toHaveLength(1);
    const args = enqueueCalls()[0]?.[1] as { _dedupe_key: string | null };
    expect(args._dedupe_key).toBeNull();
    expect(result).toEqual({ queued: true, jobRequestIds: ["job-1"] });
  });
});
