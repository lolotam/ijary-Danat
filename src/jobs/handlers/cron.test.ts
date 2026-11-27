import { beforeEach, describe, expect, test, vi } from "vitest";

import type { JobKind } from "@/jobs/catalog";

const mocks = vi.hoisted(() => ({
  /** ما كتبته دالّة `record_cron_run`. */
  recorded: [] as {
    key: string;
    status: string;
    durationMs: number | null;
    error: string | null;
  }[],
  /** قيمة `is_active` في صف السجل الذي تقرأه بوابة الإيقاف. */
  isActive: true,
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({
    from: (table: string) => {
      if (table !== "cron_jobs") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { is_active: mocks.isActive, recipient_targets: [] },
              error: null,
            }),
          }),
        }),
      };
    },
    rpc: async (
      fn: string,
      args: { _key: string; _status: string; _duration_ms: number | null; _error: string | null },
    ) => {
      if (fn !== "record_cron_run") throw new Error(`unexpected rpc ${fn}`);
      mocks.recorded.push({
        key: args._key,
        status: args._status,
        durationMs: args._duration_ms,
        error: args._error,
      });
      return { data: null, error: null };
    },
  }),
}));

import { CRON_JOBS, createCronHandlers, type CronJobTable } from "@/jobs/handlers/cron";

/**
 * اختبارات معالجات المهام الدورية: كل معالج ينفّذ العمل لشركة واحدة فقط،
 * ويكتب نتيجته في سجلّها.
 *
 * The only system boundary faked here is the Supabase client: the pause switch
 * and the run record go through it. The work itself is injected through the
 * factory — the same seam `createRunJob(ports, handlerFor)` uses — so the
 * assertions are about what the handler does with the work (which company,
 * which day) and not about the SQL each job function happens to call.
 */

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const JOB_REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const GMAIL_CONNECTION = "33333333-3333-4333-8333-333333333333";

/** بديل عن خريطة العمل: لكل نوع مهمة دالّة تسجّل ما طُلب منها. */
function fakeJobs(): { jobs: CronJobTable; calls: Map<string, unknown[][]> } {
  const calls = new Map<string, unknown[][]>();
  const jobs: CronJobTable = {};
  for (const kind of Object.keys(CRON_JOBS) as JobKind[]) {
    calls.set(kind, []);
    jobs[kind] = {
      registryKey: CRON_JOBS[kind]!.registryKey,
      work: async (...args: unknown[]) => {
        calls.get(kind)!.push(args);
        return { done: true };
      },
    };
  }
  return { jobs, calls };
}

/** الحمولة والتاريخ المرجعي لكل نوع مهمة دورية. */
const CASES = [
  { kind: "overdue.evaluate", payload: { date: "2026-11-27" }, asOf: "2026-11-27" },
  { kind: "overdue.remind", payload: { date: "2026-11-27" }, asOf: "2026-11-27" },
  { kind: "contract.expiry", payload: { date: "2026-11-27" }, asOf: "2026-11-27" },
  { kind: "notification.drain", payload: { date: "2026-11-27" }, asOf: "2026-11-27" },
  { kind: "log.retention", payload: { date: "2026-11-27" }, asOf: "2026-11-27" },
  { kind: "salaries.generate", payload: { month: "2026-11" }, asOf: "2026-11-01" },
  { kind: "payment.reconcile", payload: {}, asOf: null },
  { kind: "gmail.sync", payload: { connectionId: GMAIL_CONNECTION }, asOf: null },
] as const;

beforeEach(() => {
  mocks.recorded.length = 0;
  mocks.isActive = true;
});

describe("the cron handlers", () => {
  test.each(CASES)(
    "the $kind handler runs the work for its own company only",
    async ({ kind, payload, asOf }) => {
      const { jobs, calls } = fakeJobs();
      const handler = createCronHandlers(jobs)[kind];

      await handler?.({
        jobRequestId: JOB_REQUEST_ID,
        companyId: COMPANY_ID,
        payload,
        attempt: 1,
      });

      expect(calls.get(kind)).toEqual([[asOf, COMPANY_ID]]);
    },
  );

  test("a successful run is recorded with its duration", async () => {
    const { jobs } = fakeJobs();
    const handler = createCronHandlers(jobs)["overdue.evaluate"];

    await handler?.({
      jobRequestId: JOB_REQUEST_ID,
      companyId: COMPANY_ID,
      payload: { date: "2026-11-27" },
      attempt: 1,
    });

    expect(mocks.recorded).toEqual([
      { key: "overdue", status: "success", durationMs: expect.any(Number), error: null },
    ]);
  });

  test("a paused workflow is skipped and recorded without running the work", async () => {
    mocks.isActive = false;
    const { jobs, calls } = fakeJobs();
    const handler = createCronHandlers(jobs)["overdue.evaluate"];

    const result = await handler?.({
      jobRequestId: JOB_REQUEST_ID,
      companyId: COMPANY_ID,
      payload: { date: "2026-11-27" },
      attempt: 1,
    });

    expect(calls.get("overdue.evaluate")).toEqual([]);
    expect(mocks.recorded).toEqual([
      { key: "overdue", status: "skipped", durationMs: 0, error: null },
    ]);
    expect(result).toMatchObject({ skipped: true });
  });

  test("a failed run records the error and fails the job", async () => {
    const work = vi.fn().mockRejectedValue(new Error("job exploded"));
    const handler = createCronHandlers({
      "overdue.evaluate": { registryKey: "overdue", work },
    })["overdue.evaluate"];

    await expect(
      handler?.({
        jobRequestId: JOB_REQUEST_ID,
        companyId: COMPANY_ID,
        payload: { date: "2026-11-27" },
        attempt: 1,
      }),
    ).rejects.toThrow("job exploded");

    expect(mocks.recorded).toEqual([
      { key: "overdue", status: "error", durationMs: expect.any(Number), error: "job exploded" },
    ]);
  });
});
