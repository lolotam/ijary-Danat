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
const { generateInvoices } = await import("./generateInvoices");

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

/** ما يعيده نداء الخادم: الحجز كما يراه المتصفح. */
interface GenerateResult {
  queued: boolean;
  jobRequestId: string;
  alreadyRunning?: boolean;
}

/**
 * ينادي دالة الخادم كما يناديها المتصفح: بالحمولة وسياق الطلب.
 */
function callGenerate(data: unknown, permission = true): Promise<GenerateResult> {
  const { context } = fakeRequestContext(permission);
  return (
    generateInvoices as unknown as (a: {
      data: unknown;
      context: unknown;
    }) => Promise<GenerateResult>
  )({ data, context });
}

beforeEach(() => {
  resetFakeDb(fake);
  jobStates.clear();
});

describe("generateInvoices server function", () => {
  it("enqueues exactly one catalogue-valid invoices.generate job and generates nothing here", async () => {
    const result = await callGenerate({ year: 2026 });

    // The request does no bulk work: one outbox row, no generator call, and
    // the payload the worker will validate is the one the catalogue accepts.
    expect(fake.jobs).toHaveLength(1);
    expect(fake.jobs[0].kind).toBe("invoices.generate");
    // المفتاح يحمل طلبًا عشوائيًا لكل نقرة، فلا يطوي الطلب الثاني على مهمة قديمة.
    expect(fake.jobs[0].dedupeKey).toMatch(/^invoices\.generate:2026:[0-9a-f-]{36}$/);
    expect(() =>
      JOB_CATALOG["invoices.generate"].payload.parse(fake.jobs[0].payload),
    ).not.toThrow();
    expect(fake.jobs[0].payload).toEqual({ year: 2026 });
    expect(fake.rpcs.filter((call) => call.name === "generate_invoices")).toEqual([]);
    expect(result.queued).toBe(true);
    expect(result.jobRequestId).toBe(fake.jobs[0].id);
    expect(result.alreadyRunning).toBeFalsy();
  });

  it.each(["pending", "published", "running"])(
    "a second click while the first job is %s returns the running job and queues nothing",
    async (state) => {
      await callGenerate({ year: 2026 });
      jobStates.set(fake.jobs[0].id, state);

      const second = await callGenerate({ year: 2026 });

      // لا تشغيل ثانٍ لنفس السنة: النقرة الثانية تُجاب بمعرّف المهمة الجارية.
      expect(second.jobRequestId).toBe(fake.jobs[0].id);
      expect(second.alreadyRunning).toBe(true);
      expect(fake.jobs).toHaveLength(1);
    },
  );

  it.each(["succeeded", "failed"])(
    "a second click after the first job ended %s queues a NEW job",
    async (state) => {
      await callGenerate({ year: 2026 });
      jobStates.set(fake.jobs[0].id, state);

      const second = await callGenerate({ year: 2026 });

      // المهمة المنتهية لا تحجب أبداً: التوليد من جديد قابل للتكرار بعد النجاح
      // (قراءات جديدة) وبعد الفشل (إعادة محاولة)، ومفتاح النقرة الثانية جديد.
      expect(fake.jobs).toHaveLength(2);
      expect(second.jobRequestId).toBe(fake.jobs[1].id);
      expect(second.alreadyRunning).toBeFalsy();
      expect(fake.jobs[1].dedupeKey).not.toBe(fake.jobs[0].dedupeKey);
      expect(fake.jobs[1].dedupeKey).toMatch(/^invoices\.generate:2026:[0-9a-f-]{36}$/);
    },
  );

  it("an in-flight job for another year does not block this year", async () => {
    await callGenerate({ year: 2026 });
    jobStates.set(fake.jobs[0].id, "running");

    const second = await callGenerate({ year: 2027 });

    expect(second.jobRequestId).toBe(fake.jobs[1].id);
    expect(second.alreadyRunning).toBeFalsy();
  });

  // Regression guard for the audit finding: the guard used to
  // `throw new Response("Forbidden", { status: 403 })`, which TanStack Start
  // hands back to the caller instead of rejecting — the await resolved and the
  // UI fired its success path while no invoice was generated. The refusal must
  // reject with a named Error, and no job may be enqueued.
  it("rejects with a permission Error when user lacks permission", async () => {
    await expect(callGenerate({ year: 2026 }, false)).rejects.toThrow(
      "You do not have permission to generate invoices.",
    );

    expect(fake.jobs).toEqual([]);
  });
});
