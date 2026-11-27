/**
 * @vitest-environment jsdom
 *
 * تحديد جاهزية الدفع الإلكتروني في بوابة المستأجر: اتصال نشط واحد يكفي.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const constants = vi.hoisted(() => ({
  COMPANY_ID: "11111111-1111-4111-8111-111111111111",
}));

const dbBoundary = vi.hoisted(() => ({
  client: null as unknown,
}));

vi.mock("@tanstack/react-start", () => {
  function makeFn() {
    const fn: any = (data: any) => fn._handler({ data, context: fn._context });
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.validator = vi.fn().mockReturnValue(fn);
    fn.handler = vi.fn().mockImplementation((handler: any) => {
      fn._handler = async (args: any) => handler({ ...args, data: args.data });
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
  companyClient: () => dbBoundary.client,
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: constants.COMPANY_ID,
    slug: "acme",
    status: "active",
    host: "acme.localhost",
  }),
}));

import { portalPaymentAvailability } from "@/fns/portalPaymentAvailability";

/** صف اتصال كما يقرأه استعلام جاهزية الدفع. */
interface FakeConnectionRow {
  id: string;
  is_active: boolean;
}

/** عميل قاعدة بيانات وهمي يطبّق مرشّح `eq` على الصفوف قبل إرجاعها. */
function fakeClient(rows: FakeConnectionRow[] | { error: string }) {
  const filters: Array<(row: FakeConnectionRow) => boolean> = [];
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters.push((row) => row[column as keyof FakeConnectionRow] === value);
      return builder;
    },
    maybeSingle: () => builder,
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
      const result = Array.isArray(rows)
        ? {
            data: rows.find((row) => filters.every((matches) => matches(row))) ?? null,
            error: null,
          }
        : { data: null, error: { message: rows.error } };
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  dbBoundary.client = { from: () => builder };
}

/** يستدعي دالة الخادم الوهمية في سياق طلب مضيف الشركة. */
function call(): Promise<boolean> {
  return (portalPaymentAvailability as unknown as () => Promise<boolean>)();
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  dbBoundary.client = null;
});

describe("portalPaymentAvailability", () => {
  test.each([
    { rows: [{ id: "conn-1", is_active: true }], expected: true },
    { rows: [{ id: "conn-2", is_active: false }], expected: false },
    { rows: [], expected: false },
  ])("reports $expected for connections $rows", async ({ rows, expected }) => {
    fakeClient(rows);

    await expect(call()).resolves.toBe(expected);
  });

  test("throws the database error instead of offering online payment on a failed read", async () => {
    fakeClient({ error: "connection refused" });

    await expect(call()).rejects.toThrow(
      "Failed to read active payment gateway: connection refused",
    );
  });
});
