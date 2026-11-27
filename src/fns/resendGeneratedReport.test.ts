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
const REPORT_ID = "22222222-2222-4222-8222-222222222222";
const SCHEDULE_ID = "33333333-3333-4333-8333-333333333333";

const reportRow = vi.fn();
const rpc = vi.fn();

// The stub answers only the tables the request may read. Anything else throws,
// so a resend that reached the database would fail the test instead of passing it.
const dbClient = {
  from: (table: string) => {
    if (table === "generated_reports") {
      return { select: () => ({ eq: () => ({ single: reportRow }) }) };
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

const { resendGeneratedReport } = await import("./resendGeneratedReport");

const context = {
  userId: "user-1",
  supabase: { rpc: async () => ({ data: true, error: null }) },
};

const resend = () =>
  (
    resendGeneratedReport as unknown as (a: { data: unknown; context: unknown }) => Promise<unknown>
  )({
    data: { reportId: REPORT_ID },
    context,
  });

beforeEach(() => {
  vi.clearAllMocks();
  reportRow.mockResolvedValue({
    data: { id: REPORT_ID, schedule_id: SCHEDULE_ID, period_end: "2026-09-28" },
    error: null,
  });
  rpc.mockResolvedValue({ data: "job-1", error: null });
});

describe("resendGeneratedReport queues the report instead of sending it", () => {
  test("queues one report.run job whose payload matches the catalogue", async () => {
    const result = (await resend()) as { queued: boolean; jobRequestIds: string[] };

    // One row in the outbox. The payload reached it only because it passed the
    // catalogue's schema: `enqueueJob` parses it before the insert.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("enqueue_job", {
      _kind: "report.run",
      _payload: { scheduleId: SCHEDULE_ID, date: "2026-09-28" },
      _dedupe_key: null,
      _requested_by: null,
    });
    expect(result).toEqual({ queued: true, jobRequestIds: ["job-1"] });
  });

  test("carries no dedupe key, so an admin may resend the same report", async () => {
    await resend();

    const args = rpc.mock.calls[0]?.[1] as { _dedupe_key: string | null };
    expect(args._dedupe_key).toBeNull();
  });

  test("runs for today when the stored report has no period end", async () => {
    reportRow.mockResolvedValue({
      data: { id: REPORT_ID, schedule_id: SCHEDULE_ID, period_end: null },
      error: null,
    });

    await resend();

    const args = rpc.mock.calls[0]?.[1] as { _payload: { date: string } };
    expect(args._payload.date).toBe(new Date().toISOString().slice(0, 10));
  });

  test("refuses a report that is not this company's", async () => {
    reportRow.mockResolvedValue({ data: null, error: { message: "Report not found" } });

    await expect(resend()).rejects.toThrow("Report not found");
    expect(rpc).not.toHaveBeenCalled();
  });
});
