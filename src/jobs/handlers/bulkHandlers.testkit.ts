import { vi } from "vitest";

/**
 * عدّة اختبار معالجات المهام الضخمة: قاعدة بيانات وهمية تحاكي حدود النظام
 * فقط — جداول PostgREST ووظائف SQL — مع نمذجة قيود التفرد التي يعتمد عليها
 * كل نوع (مفتاح منع التكرار، `on conflict do nothing`، حالة الصف).
 *
 * Nothing internal is mocked: handlers and server functions run their real
 * chunking, payload validation and counting against this boundary. The fake
 * records every range read (the observable chunk boundary) and every effect,
 * and can crash a chosen call with a code-less error to simulate a chunk
 * dying mid-run. The `.testkit.ts` suffix keeps it out of the vitest include
 * glob.
 */

/** طلب مهمة مسجَّل عبر `enqueue_job`، كما يراه استعلام "مهمة ممسوكة". */
export interface FakeJobRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
}

/** قراءة دفعة مسجَّلة: الجدول ونطاق القراءة — حدّ الدفعة المرصود للاختبار. */
export interface FakeRangeRead {
  table: string;
  from: number;
  to: number;
}

export interface FakeDb {
  /** صفوف الجداول التي تقرأها حمّالات الدفعات، مرتّبةً بالمعرّف عند القراءة. */
  tables: Record<string, Array<Record<string, unknown>>>;
  /** طلبات المهام المسجَّلة عبر `enqueue_job`. */
  jobs: FakeJobRow[];
  /** مفاتيح السجلات التي أُنشئت فعلاً — قيد التفرد الذي تحاكيه الوظائف. */
  createdKeys: Set<string>;
  /** قراءات الدفعات المرصودة، بالترتيب. */
  reads: FakeRangeRead[];
  /** استدعاءات `rpc` المرصودة، بالترتيب. */
  rpcs: Array<{ name: string; args: Record<string, unknown> }>;
  /** لحظة الانهيار: الاستدعاء رقم `at` من `name` يرمي خطأً بلا رمز SQLSTATE. */
  crashAt: { name: string; at: number } | null;
  /** رفض صف واحد: `name` عند تطابق `match` يعيد خطأً برمز SQLSTATE. */
  refusal: {
    name: string;
    match: (args: Record<string, unknown>) => boolean;
    error: { message: string; code: string };
  } | null;
}

/** يبني قاعدة بيانات وهمية جاهزة لاختبارات العائلة الضخمة. */
export function createFakeDb(): FakeDb {
  const fake: FakeDb = {
    tables: {},
    jobs: [],
    createdKeys: new Set<string>(),
    reads: [],
    rpcs: [],
    crashAt: null,
    refusal: null,
  };
  return fake;
}

/** يعيد قاعدة وهمية إلى حالتها الأولى بين الاختبارات. */
export function resetFakeDb(fake: FakeDb): void {
  const fresh = createFakeDb();
  fake.tables = fresh.tables;
  fake.jobs = fresh.jobs;
  fake.createdKeys = fresh.createdKeys;
  fake.reads = fresh.reads;
  fake.rpcs = fresh.rpcs;
  fake.crashAt = null;
  fake.refusal = null;
}

/** يضبط صفوف جدول واحد في القاعدة الوهمية. */
export function seedTable(fake: FakeDb, table: string, rows: Array<Record<string, unknown>>): void {
  fake.tables[table] = [...rows];
}

/**
 * يولّد سجلات قابلة للتوليد بكميات كبيرة لاختبارات الدفعات.
 *
 * `makeRow` names the id so the fake can sort by it exactly like the
 * handlers' `order("id")` does, which is what keeps the range slices stable.
 */
export function makeRows(count: number, prefix: string, fields: Record<string, unknown> = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index + 1).padStart(4, "0")}`,
    ...fields,
  }));
}

/**
 * يولّد سجلات بكميات كبيرة تحمل معرّفات UUID صالحة لخطط الكتالوج.
 *
 * The notification fixtures feed `enqueueJob`, whose payload schema demands
 * real UUIDs — an id like `notif-0001` would be rejected by the very
 * validation under test.
 */
export function makeUuidRows(count: number, fields: Record<string, unknown> = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    ...fields,
  }));
}

/**
 * يبني عميل Supabase وهمياً: سلاسل قراءة بترتيب ونطاق، واستدعاءات `rpc`
 * محاكية لقيود التفرد الحقيقية.
 */
export function fakeClient(fake: FakeDb) {
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    const state: { from: number; to: number } = { from: 0, to: Number.MAX_SAFE_INTEGER };
    for (const method of ["select", "eq", "is", "gte", "in", "contains", "order"]) {
      chain[method] = () => chain;
    }
    chain.range = (from: number, to: number) => {
      state.from = from;
      state.to = to;
      return chain;
    };
    chain.single = () => Promise.resolve({ data: resolveRows()[0] ?? null, error: null });
    chain.maybeSingle = () => Promise.resolve({ data: resolveRows()[0] ?? null, error: null });
    chain.then = (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve({ data: resolveRows(), error: null }).then(onFulfilled);
    function resolveRows(): Array<Record<string, unknown>> {
      if (table === "job_requests") {
        // The held-jobs lookup: jobs recorded by `enqueue_job`, as payloads.
        return fake.jobs
          .filter((job) => job.kind === "notification.dispatch")
          .map((job) => ({ payload: job.payload }));
      }
      const rows = [...(fake.tables[table] ?? [])].sort((a, b) =>
        String(a.id).localeCompare(String(b.id)),
      );
      fake.reads.push({ table, from: state.from, to: state.to });
      return rows.slice(state.from, state.to + 1);
    }
    return chain;
  }

  /**
   * يحاكي استدعاءات RPC بقيود التفرد الحقيقية لكل نوع.
   *
   * `enqueue_job` dedupes on `(kind, dedupe_key)` and returns the existing id;
   * the generators insert under an `on conflict`-style key and return rows
   * only on the first call; `regenerate_contract_invoices` reconciles — it
   * reports `inserted` once and `skipped` afterwards.
   */
  async function rpc(name: string, args: Record<string, unknown>) {
    fake.rpcs.push({ name, args });
    const crash = fake.crashAt;
    if (crash && crash.name === name) {
      const callsSoFar = fake.rpcs.filter((entry) => entry.name === name).length;
      if (callsSoFar === crash.at) throw new Error(`simulated crash in ${name} call ${crash.at}`);
    }
    const refusal = fake.refusal;
    if (refusal && refusal.name === name && refusal.match(args)) {
      return { data: null, error: refusal.error };
    }
    if (name === "enqueue_job") {
      const kind = String(args._kind);
      const dedupeKey = (args._dedupe_key as string | null) ?? null;
      const existing = fake.jobs.find(
        (job) => job.kind === kind && job.dedupeKey !== null && job.dedupeKey === dedupeKey,
      );
      if (existing) return { data: existing.id, error: null };
      const job: FakeJobRow = {
        id: `job-${fake.jobs.length + 1}`,
        kind,
        payload: args._payload as Record<string, unknown>,
        dedupeKey,
      };
      fake.jobs.push(job);
      return { data: job.id, error: null };
    }
    if (name === "generate_invoices") {
      return insertOnce(fake, `invoice:${args.p_contract_id}`, { id: `inv-${args.p_contract_id}` });
    }
    if (name === "generate_electricity_charges") {
      return insertOnce(
        fake,
        `charge:${args.p_unit_id}:${args.p_period_year}-${args.p_period_month}`,
        { id: `charge-${args.p_unit_id}` },
      );
    }
    if (name === "regenerate_contract_invoices") {
      const key = `regen:${args.p_contract_id}`;
      if (fake.createdKeys.has(key)) return { data: [{ action: "skipped" }], error: null };
      fake.createdKeys.add(key);
      return { data: [{ action: "inserted" }], error: null };
    }
    return { data: null, error: null };
  }

  return { from: (table: string) => builder(table), rpc };
}

/**
 * يحاكي إدراجاً محمياً بقيد تفرد: أول استدعاء ينشئ السجل ويعيد صفوفاً، وما
 * بعده يعيد فارغاً كما يفعل `on conflict do nothing`.
 */
function insertOnce(fake: FakeDb, key: string, row: Record<string, unknown>) {
  if (fake.createdKeys.has(key)) return { data: [], error: null };
  fake.createdKeys.add(key);
  return { data: [row], error: null };
}

/** مصنع `vi.mock("@/company/requestCompany.server", …)` لاختبارات العائلة. */
export function requestCompanyModule() {
  const company = { id: "00000000-0000-4000-8000-000000000001", slug: "danat", status: "active" };
  return {
    getRequestCompany: () => company,
    requireRequestCompany: () => company,
    runWithRequestCompany: async (_company: unknown, fn: () => unknown) => fn(),
  };
}

/**
 * يبني سياق طلب خادم وهمياً: صلاحية حسب الطلب وrpc مسجَّل للاختبارات.
 */
export function fakeRequestContext(permission = true) {
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    rpcs,
    context: {
      userId: "11111111-1111-4111-8111-111111111111",
      supabase: {
        rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
          rpcs.push({ name, args });
          if (name === "has_permission") return { data: permission, error: null };
          return { data: null, error: null };
        }),
      },
    },
  };
}

/**
 * مصنع `vi.mock("@tanstack/react-start", …)`: دالة خادم تستدعي معالجها مباشرة.
 *
 * The callable passes `{ data, context }` straight to the handler, so each
 * test supplies its own context alongside the payload.
 */
export function tanstackStartModule() {
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
}
