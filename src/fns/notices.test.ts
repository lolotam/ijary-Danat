import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  // A FRESH object per createServerFn() call: a shared object would make every
  // server function in the module point at the same handler.
  createServerFn: vi.fn().mockImplementation(() => {
    const fn: any = async (input?: { data?: unknown }) => {
      const raw = input?.data;
      // The real builder validates before the handler runs; without this the
      // schema would never be exercised and a bad id would reach the database.
      const data = fn._schema ? fn._schema.parse(raw) : raw;
      return fn._handler({ data, context: fn._context });
    };
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.validator = vi.fn().mockImplementation((schema: any) => {
      fn._schema = schema;
      return fn;
    });
    fn.inputValidator = vi.fn().mockReturnValue(fn);
    fn.handler = vi.fn().mockImplementation((handler: any) => {
      fn._handler = handler;
      return fn;
    });
    return fn;
  }),
  createMiddleware: vi.fn().mockReturnValue({
    server: vi.fn().mockImplementation((middlewareFn: any) => middlewareFn),
  }),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));

import { markNoticeRead, myNotices } from "@/fns/notices";
import type { Tables } from "@/integrations/supabase/database.types";

/** صف الإشعار كما ترده قاعدة البيانات. */
type NoticeRow = Tables<"user_notices">;

const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const NOTICE_ID = "11111111-1111-4111-8111-111111111111";

/**
 * حالة قاعدة البيانات التي تراها دوال الإشعارات.
 *
 * Only the Supabase client is faked: the rows, the error and the number of
 * rows an update matched are what the functions must turn into a result.
 */
const db = {
  rows: [] as NoticeRow[],
  readError: null as { message: string } | null,
  updatedRows: [] as unknown[],
  updateError: null as { message: string } | null,
  updateValues: null as Record<string, unknown> | null,
  isStaff: true,
};

/**
 * يبني استعلام `user_notices` الذي يعيد النتيجة المهيّأة.
 *
 * `update()` switches the result to the update's own: a select and an update
 * are different statements with different outcomes.
 */
function noticeTable() {
  let result: { data: unknown; error: { message: string } | null } = {
    data: db.rows,
    error: db.readError,
  };
  const chain: any = {
    select: () => chain,
    order: () => chain,
    limit: () => chain,
    update: (values: Record<string, unknown>) => {
      db.updateValues = values;
      result = { data: db.updatedRows, error: db.updateError };
      return chain;
    },
    eq: () => chain,
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

const client = {
  rpc: vi.fn(async (name: string) => {
    if (name === "is_staff") return { data: db.isStaff, error: null };
    return { data: null, error: null };
  }),
  from: vi.fn(() => noticeTable()),
};

const context = { supabase: client, userId: STAFF_ID };

/** صف إشعار واحد، بمعرّف وتاريخ قابلين للتعديل. */
function noticeRow(overrides: Partial<NoticeRow> = {}): NoticeRow {
  return {
    id: NOTICE_ID,
    company_id: "33333333-3333-4333-8333-333333333333",
    user_id: STAFF_ID,
    job_request_id: null,
    kind: "invoices.generate",
    title_key: "notices.invoices.generate.success",
    body: {},
    level: "success",
    read_at: null,
    created_at: "2026-11-27T10:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  db.rows = [];
  db.readError = null;
  db.updatedRows = [];
  db.updateError = null;
  db.updateValues = null;
  db.isStaff = true;
  (myNotices as any)._context = context;
  (markNoticeRead as any)._context = context;
});

describe("myNotices", () => {
  test("the unread notices come first and the list stops at twenty", async () => {
    db.rows = [
      ...Array.from({ length: 5 }, (_, index) =>
        noticeRow({ id: `read-${index}`, read_at: "2026-11-27T09:00:00Z" }),
      ),
      ...Array.from({ length: 20 }, (_, index) =>
        noticeRow({
          id: `unread-${index}`,
          created_at: `2026-11-27T10:${String(index).padStart(2, "0")}:00Z`,
        }),
      ),
    ];

    const notices = await myNotices();

    expect(notices).toHaveLength(20);
    expect(notices.every((notice) => notice.readAt === null)).toBe(true);
    expect(notices[0].id).toBe("unread-19");
  });

  test("a read that fails is not silent", async () => {
    db.readError = { message: "boom" };

    await expect(myNotices()).rejects.toThrow("boom");
  });

  test("a caller who is not staff is refused", async () => {
    db.isStaff = false;

    await expect(myNotices()).rejects.toThrow(/permission/i);
  });
});

describe("markNoticeRead", () => {
  test("an id that is not a uuid never reaches the database", async () => {
    await expect(markNoticeRead({ data: { id: "not-a-uuid" } })).rejects.toThrow();
    expect(db.updateValues).toBeNull();
  });

  test("a notice that belongs to somebody else is a silent no-op", async () => {
    // The update matched no row: RLS hid it, so the function must not say so.
    db.updatedRows = [];

    await expect(markNoticeRead({ data: { id: NOTICE_ID } })).resolves.toBeUndefined();
  });

  test("only the read timestamp is written", async () => {
    db.updatedRows = [{ id: NOTICE_ID }];

    await markNoticeRead({ data: { id: NOTICE_ID } });

    expect(Object.keys(db.updateValues ?? {})).toEqual(["read_at"]);
  });
});
