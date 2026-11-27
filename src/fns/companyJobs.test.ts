import { beforeEach, describe, expect, test, vi } from "vitest";

const constants = vi.hoisted(() => ({
  COMPANY_ID: "11111111-1111-4111-8111-111111111111",
  ROW_ID: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
}));

/** عميل Supabase الذي يقرأ منه `companyClient` — الحدّ الفاصل الذي يُحاكى هنا. */
const supabase = vi.hoisted(() => ({
  from: vi.fn(),
}));

/**
 * دالة خادم وهمية: تأخذ مدخلات المُحقّق مباشرةً كما تفعل بقية اختبارات دوال
 * الخادم في هذا المجلد، وتطبّق مُحقّق Zod، فرفض مُعرّف غير صالح يقع قبل أي
 * قراءة من قاعدة البيانات.
 */
vi.mock("@tanstack/react-start", () => {
  function makeFn() {
    const fn: any = (data: any) => fn._handler({ data, context: fn._context });
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.validator = vi.fn().mockImplementation((schema: any) => {
      fn._schema = schema;
      return fn;
    });
    fn.inputValidator = vi.fn().mockReturnValue(fn);
    fn.handler = vi.fn().mockImplementation((handler: any) => {
      // Async on purpose: a schema failure must reject like the real
      // framework's does, not throw synchronously at the call site.
      fn._handler = async (args: any) =>
        handler({ ...args, data: fn._schema ? fn._schema.parse(args.data) : args.data });
      return fn;
    });
    return fn;
  }
  return {
    createServerFn: vi.fn().mockImplementation(() => makeFn()),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middlewareFn: any) => middlewareFn),
    }),
  };
});

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => supabase,
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: constants.COMPANY_ID,
    slug: "acme",
    status: "active",
    host: "acme.localhost",
  }),
}));

import { companyFailedJobs, retryJob, JOB_NOT_RETRYABLE, type FailedJob } from "@/fns/companyJobs";

/** نداء PostgREST واحد: الطريقة ووسائطها. */
interface QueryCall {
  method: string;
  args: unknown[];
}

/**
 * جدول Supabase وهمي: يسجّل كل نداء ويعيد نتيجة جاهزة.
 *
 * The builder is thenable, so `await db.from(...).select(...)` resolves to the
 * prepared result — the shape the real PostgREST builder returns.
 */
function fakeTable(result: { data: unknown; error: { message: string } | null }) {
  const calls: QueryCall[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit", "update", "maybeSingle"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return { builder, calls };
}

/** سياق مستخدم موقّع الدخول، يحمل صلاحية `company.update` أو لا يحملها. */
function authContext(allowed: boolean) {
  return {
    userId: "user-1",
    supabase: {
      rpc: vi.fn().mockImplementation((name: string) => {
        if (name === "has_permission") return { data: allowed, error: null };
        return { data: null, error: null };
      }),
    },
  };
}

/** يستدعي دالة خادم وهميةً في سياق مستخدم محدّد. */
function callServerFn<T>(fn: unknown, context: unknown, input?: unknown): Promise<T> {
  const serverFn = fn as { _context: unknown; (data?: unknown): Promise<T> };
  serverFn._context = context;
  return serverFn(input);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("companyFailedJobs", () => {
  test("returns the failed rows only, without the payload", async () => {
    const { builder, calls } = fakeTable({
      data: [
        {
          id: constants.ROW_ID,
          kind: "invoice.send",
          last_error: "smtp timeout",
          attempts: 3,
          created_at: "2026-11-20T10:00:00.000Z",
          finished_at: "2026-11-20T10:05:00.000Z",
        },
      ],
      error: null,
    });
    supabase.from.mockReturnValue(builder);

    const jobs = await callServerFn<FailedJob[]>(companyFailedJobs, authContext(true));

    expect(jobs).toEqual([
      {
        id: constants.ROW_ID,
        kind: "invoice.send",
        lastError: "smtp timeout",
        attempts: 3,
        createdAt: "2026-11-20T10:00:00.000Z",
        finishedAt: "2026-11-20T10:05:00.000Z",
      },
    ]);
    expect(calls).toContainEqual({ method: "eq", args: ["status", "failed"] });
    expect(calls).toContainEqual({ method: "limit", args: [50] });
    // Newest first, and a row that never finished sorts last.
    expect(calls).toContainEqual({
      method: "order",
      args: ["finished_at", { ascending: false, nullsFirst: false }],
    });
    const selected = calls.find((entry) => entry.method === "select")?.args[0] as string;
    expect(selected).not.toContain("payload");
  });

  test("refuses a caller without the company-settings permission, without reading the table", async () => {
    const context = authContext(false);

    await expect(callServerFn(companyFailedJobs, context)).rejects.toThrow(
      "You do not have permission to view failed background jobs.",
    );
    expect(context.supabase.rpc).toHaveBeenCalledWith("has_permission", {
      _code: "company.update",
      _user_id: "user-1",
    });
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe("retryJob", () => {
  test("a non-uuid id is refused before the table is touched", async () => {
    await expect(callServerFn(retryJob, authContext(true), { id: "not-a-uuid" })).rejects.toThrow();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("a failed row goes back to pending on the same row", async () => {
    const { builder, calls } = fakeTable({ data: { id: constants.ROW_ID }, error: null });
    supabase.from.mockReturnValue(builder);

    const result = await callServerFn<{ id: string }>(retryJob, authContext(true), {
      id: constants.ROW_ID,
    });

    expect(result).toEqual({ id: constants.ROW_ID });
    const update = calls.find((entry) => entry.method === "update")?.args[0];
    expect(update).toMatchObject({ status: "pending", attempts: 0, last_error: null });
    expect(calls).toContainEqual({ method: "eq", args: ["id", constants.ROW_ID] });
    expect(calls).toContainEqual({ method: "eq", args: ["status", "failed"] });
  });

  test("a row that is not failed — or is another company's — is refused as JOB_NOT_RETRYABLE", async () => {
    // Both cases reach the same zero rows: the company-scoped client cannot
    // see another company's row, and a row that is not failed does not match
    // the status filter. The refusal must not tell the two apart.
    const { builder } = fakeTable({ data: null, error: null });
    supabase.from.mockReturnValue(builder);

    await expect(
      callServerFn(retryJob, authContext(true), { id: constants.ROW_ID }),
    ).rejects.toMatchObject({
      code: JOB_NOT_RETRYABLE,
    });
  });
});
