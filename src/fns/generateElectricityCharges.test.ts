import { beforeEach, describe, expect, it, vi } from "vitest";

import { JOB_CATALOG } from "@/jobs/catalog";

import {
  createFakeDb,
  fakeClient,
  fakeRequestContext,
  requestCompanyModule,
  resetFakeDb,
  tanstackStartModule,
  type FakeDb,
} from "@/jobs/handlers/bulkHandlers.testkit";

vi.mock("@tanstack/react-start", () => tanstackStartModule());
vi.mock("@/company/requestCompany.server", () => requestCompanyModule());
vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => fakeClientWithJobRequests(fake),
}));

const fake: FakeDb = createFakeDb();
const { generateElectricityCharges } = await import("./generateElectricityCharges");

/** الشركة التي يعمل تحتها كل اختبار — صفوف `job_requests` تنتمي إليها. */
const COMPANY_ID = "00000000-0000-4000-8000-000000000001";

/**
 * حالة كل طلب مهمة كما يحفظها الاختبار.
 *
 * The shared fake records the outbox rows but not their status; this map is
 * the boundary's `status` column, and a row without an entry is `pending` —
 * exactly what `enqueue_job` writes.
 */
const jobStates = new Map<string, string>();

/**
 * يبني استعلام `job_requests` فوق صفوف المهام التي سجّلتها `enqueue_job`.
 *
 * The shared fake answers this table with the held-dispatch payloads only, so
 * the in-flight guard gets its own boundary view here: the same rows the outbox
 * holds, filtered by the `eq`/`in` calls the guard makes. Nothing internal is
 * mocked — the guard's own query logic runs against these rows.
 */
function jobRequestsQuery(source: FakeDb) {
  const filters: Array<(row: Record<string, unknown>) => boolean> = [];
  const rows = () =>
    source.jobs
      .map((job) => ({
        id: job.id,
        kind: job.kind,
        payload: job.payload,
        status: jobStates.get(job.id) ?? "pending",
        company_id: COMPANY_ID,
      }))
      .filter((row) => filters.every((test) => test(row)));
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (column: string, value: unknown) => {
    filters.push((row) => row[column] === value);
    return chain;
  };
  chain.in = (column: string, values: readonly unknown[]) => {
    filters.push((row) => values.includes(row[column]));
    return chain;
  };
  chain.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: rows(), error: null }).then(resolve);
  return chain;
}

/**
 * يبني عميل العدّة الوهمي مع إحالة جدول `job_requests` إلى صفوف المهام المسجَّلة.
 */
function fakeClientWithJobRequests(source: FakeDb) {
  const base = fakeClient(source);
  return {
    ...base,
    from: (table: string) =>
      table === "job_requests" ? jobRequestsQuery(source) : base.from(table),
  };
}

/** ما يعيده نداء الخادم: الحجز كما يراه حوار التوليد. */
interface GenerateResult {
  queued: boolean;
  created?: number;
  jobRequestId?: string;
  alreadyRunning?: boolean;
}

/**
 * ينادي دالة الخادم كما يناديها حوار التوليد.
 */
function callGenerate(data: unknown, permission = true): Promise<GenerateResult> {
  const { context } = fakeRequestContext(permission);
  return (
    generateElectricityCharges as unknown as (a: {
      data: unknown;
      context: unknown;
    }) => Promise<GenerateResult>
  )({ data, context });
}

beforeEach(() => {
  resetFakeDb(fake);
  jobStates.clear();
});

describe("generateElectricityCharges server function", () => {
  it("enqueues exactly one catalogue-valid electricity.generate job for a whole period", async () => {
    const result = await callGenerate({ periodMonth: 9, periodYear: 2026, unitId: null });

    // The request does no bulk work: one outbox row carrying the period, and
    // no charge generation call — the worker does that in 200-unit chunks.
    expect(fake.jobs).toHaveLength(1);
    expect(fake.jobs[0].kind).toBe("electricity.generate");
    expect(fake.jobs[0].payload).toEqual({ period: "2026-09" });
    // المفتاح يحمل طلبًا عشوائيًا لكل نقرة: قراءات جديدة تصل بعد توليد سابق،
    // والمهمة الفاشلة يجب أن تقبل إعادة التشغيل.
    expect(fake.jobs[0].dedupeKey).toMatch(/^electricity\.generate:2026-09:[0-9a-f-]{36}$/);
    expect(() =>
      JOB_CATALOG["electricity.generate"].payload.parse(fake.jobs[0].payload),
    ).not.toThrow();
    expect(fake.rpcs.filter((call) => call.name === "generate_electricity_charges")).toEqual([]);
    expect(result.queued).toBe(true);
    expect(result.alreadyRunning).toBeFalsy();
  });

  it.each(["pending", "published", "running"])(
    "a second click while the first job is %s returns the running job and queues nothing",
    async (state) => {
      await callGenerate({ periodMonth: 9, periodYear: 2026, unitId: null });
      jobStates.set(fake.jobs[0].id, state);

      const second = await callGenerate({ periodMonth: 9, periodYear: 2026, unitId: null });

      // لا تشغيل ثانٍ لنفس الفترة: النقرة الثانية تُجاب بمعرّف المهمة الجارية.
      expect(second.jobRequestId).toBe(fake.jobs[0].id);
      expect(second.alreadyRunning).toBe(true);
      expect(fake.jobs).toHaveLength(1);
    },
  );

  it.each(["succeeded", "failed"])(
    "a second click after the first job ended %s queues a NEW job",
    async (state) => {
      await callGenerate({ periodMonth: 9, periodYear: 2026, unitId: null });
      jobStates.set(fake.jobs[0].id, state);

      const second = await callGenerate({ periodMonth: 9, periodYear: 2026, unitId: null });

      // المهمة المنتهية لا تحجب أبداً — النقرة الثانية حجز مستقل بمفتاح جديد.
      expect(fake.jobs).toHaveLength(2);
      expect(second.jobRequestId).toBe(fake.jobs[1].id);
      expect(second.alreadyRunning).toBeFalsy();
      expect(fake.jobs[1].dedupeKey).not.toBe(fake.jobs[0].dedupeKey);
      expect(fake.jobs[1].dedupeKey).toMatch(/^electricity\.generate:2026-09:[0-9a-f-]{36}$/);
    },
  );

  it("an in-flight job for another period does not block this period", async () => {
    await callGenerate({ periodMonth: 9, periodYear: 2026, unitId: null });
    jobStates.set(fake.jobs[0].id, "running");

    const second = await callGenerate({ periodMonth: 10, periodYear: 2026, unitId: null });

    expect(second.jobRequestId).toBe(fake.jobs[1].id);
    expect(second.alreadyRunning).toBeFalsy();
  });

  it("generates one unit's charges in the request, since that scope cannot travel in the payload", async () => {
    // The catalogue payload names the period only (contracts/jobs.md section
    // 5), so a single-unit scope stays synchronous — one idempotent RPC call,
    // not bulk work — instead of silently widening to every unit.
    const result = await callGenerate({
      periodMonth: 9,
      periodYear: 2026,
      unitId: "33333333-3333-4333-8333-333333333333",
    });

    expect(result.queued).toBe(false);
    expect(fake.jobs).toEqual([]);
    const calls = fake.rpcs.filter((call) => call.name === "generate_electricity_charges");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({
      p_period_month: 9,
      p_period_year: 2026,
      p_unit_id: "33333333-3333-4333-8333-333333333333",
    });
  });

  // Regression guard for the audit finding: the guard used to
  // `throw new Response("Forbidden", { status: 403 })`, which TanStack Start
  // hands back to the caller instead of rejecting — the await resolved and the
  // UI fired its success path while no charge was generated. The refusal must
  // reject with a named Error, and neither path may run.
  it("rejects with a permission Error when user lacks permission", async () => {
    await expect(
      callGenerate({ periodMonth: 9, periodYear: 2026, unitId: null }, false),
    ).rejects.toThrow("You do not have permission to generate electricity charges.");

    expect(fake.jobs).toEqual([]);
    expect(fake.rpcs.filter((call) => call.name === "generate_electricity_charges")).toEqual([]);
  });
});
