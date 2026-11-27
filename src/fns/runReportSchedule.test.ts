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
const SCHEDULE_ID = "22222222-2222-4222-8222-222222222222";

const rpc = vi.fn();

// The request reads nothing but the catalogue: a report snapshot and a PDF
// render belong to the worker, so any table read here fails the test.
const dbClient = {
  from: (table: string) => {
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

const { runReportSchedule } = await import("./runReportSchedule");

const context = {
  userId: "user-1",
  supabase: { rpc: async () => ({ data: true, error: null }) },
};

const run = (asOf: string | null | undefined) =>
  (runReportSchedule as unknown as (a: { data: unknown; context: unknown }) => Promise<unknown>)({
    data: { scheduleId: SCHEDULE_ID, asOf },
    context,
  });

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: "job-1", error: null });
});

describe("runReportSchedule queues the report instead of building it", () => {
  test("queues one report.run job whose payload matches the catalogue", async () => {
    const result = (await run("2026-09-28")) as { queued: boolean; jobRequestIds: string[] };

    // One row in the outbox. The payload reached it only because it passed the
    // catalogue's schema: `enqueueJob` parses it before the insert.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("enqueue_job", {
      _kind: "report.run",
      _payload: { scheduleId: SCHEDULE_ID, date: "2026-09-28" },
      _dedupe_key: `report.run:${SCHEDULE_ID}:2026-09-28`,
      _requested_by: null,
    });
    expect(result).toEqual({ queued: true, jobRequestIds: ["job-1"] });
  });

  test("runs for today when no date was asked for", async () => {
    await run(null);

    const args = rpc.mock.calls[0]?.[1] as { _payload: { date: string } };
    expect(args._payload.date).toBe(new Date().toISOString().slice(0, 10));
  });

  test("deduplicates the same schedule on the same day", async () => {
    await run("2026-09-28");

    const args = rpc.mock.calls[0]?.[1] as { _dedupe_key: string | null };
    expect(args._dedupe_key).toBe(`report.run:${SCHEDULE_ID}:2026-09-28`);
  });
});
