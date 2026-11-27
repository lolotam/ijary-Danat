import { beforeEach, describe, expect, it, vi } from "vitest";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

/**
 * عميل Supabase الذي يمرّر companyClient — الحدّ الفاصل الذي يُحاكى هنا.
 *
 * The builder is thenable so `await` sees the prepared PostgREST result, and
 * the RPC records what the import sent to the database.
 */
const mocks = vi.hoisted(() => ({
  /** نتيجة استدعاء `bulk_import_phase6`. */
  importResult: { data: null, error: null } as { data: unknown; error: unknown },
  /** الاستدعاءات التي وصلت إلى قاعدة البيانات. */
  rpcCalls: [] as Array<{ args: unknown; name: string }>,
  /** نتائج جداول الشركة. */
  tableResults: {} as Record<string, unknown>,
}));

// The handler is only reachable with `createServerFn` stubbed; the pure helpers
// below are unaffected by the stub and keep importing normally.
vi.mock("@tanstack/react-start", () => {
  const fn: any = (data: any) => fn._handler({ data, context: fn._context });
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((handler) => {
    fn._handler = handler;
    return fn;
  });
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middleware) => middleware),
    }),
  };
});

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "maybeSingle"]) {
        builder[method] = () => builder;
      }
      builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(mocks.tableResults[table]).then(resolve);
      return builder;
    },
    rpc: (name: string, args: unknown) => {
      mocks.rpcCalls.push({ args, name });
      return Promise.resolve(mocks.importResult);
    },
  }),
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "acme",
    status: "active",
    host: "acme.localhost",
  }),
}));

import {
  bulkImport,
  dedupeRowsByCode,
  ENTITIES_DEDUPED_BY_CODE,
  type BulkImportResult,
} from "@/fns/bulkImport";

describe("dedupeRowsByCode", () => {
  it("imports a tenant once when the CSV repeats it per contract", () => {
    const rows = [
      { code: "T-1", name: "A" },
      { code: "T-1", name: "A" },
      { code: "T-2", name: "B" },
    ];
    expect(dedupeRowsByCode(rows)).toHaveLength(2);
  });

  it("keeps the first occurrence, matching the old primary-contract round trip", () => {
    const rows = [
      { code: "T-1", name: "first" },
      { code: "T-1", name: "second" },
    ];
    expect(dedupeRowsByCode(rows)[0].name).toBe("first");
  });

  it("leaves rows with a blank code alone — the importer generates one per row", () => {
    // `coalesce(nullif(row_data.code,''), public.next_tenant_code())` in the SQL
    // means a blank code is a NEW tenant each time, not a duplicate.
    expect(dedupeRowsByCode([{ code: "" }, { code: "" }])).toHaveLength(2);
  });

  it("treats whitespace-only codes as blank and does not collapse them", () => {
    expect(dedupeRowsByCode([{ code: "  " }, { code: "  " }])).toHaveLength(2);
  });

  it("ignores missing code fields the same way as blank — generate new tenants", () => {
    expect(dedupeRowsByCode([{ name: "A" }, { name: "B" }])).toHaveLength(2);
  });
});

describe("ENTITIES_DEDUPED_BY_CODE", () => {
  it("collapses contracts too — one-row-per-unit export re-imports without 23505", () => {
    const rows = [
      { code: "CTR-1", unit_code: "U-1" },
      { code: "CTR-1", unit_code: "U-2" },
      { code: "CTR-2", unit_code: "U-9" },
    ];
    expect(dedupeRowsByCode(rows).map((row) => row.unit_code)).toEqual(["U-1", "U-9"]);
  });

  it("covers exactly the two entities whose exports repeat a code", () => {
    // Deduping any other entity would silently drop legitimate rows: units and
    // expenses share no code across rows, and contracts rows legitimately repeat
    // tenant_code, which is NOT the dedupe key.
    expect([...ENTITIES_DEDUPED_BY_CODE]).toEqual(["tenants", "contracts"]);
  });
});

/**
 * يسجّل رفض الاستيراد بسبب الصلاحية.
 *
 * Review finding on PR #206: a direct call to this endpoint by an unauthorized
 * user was refused and left no trace, so the audit screen could not show a
 * bulk-import attempt that was stopped. The refusal itself is unchanged — only
 * the record is new, and the row must say whether a decision was made or the
 * check never ran.
 */
describe("bulkImport permission refusal", () => {
  /** يجهّز عميل Supabase مزيَّفاً بنتيجة تحقق صلاحية محدَّدة. */
  function arrange(permission: { data: unknown; error: unknown }) {
    const rpc = vi.fn((name: string) =>
      name === "has_permission" ? permission : { data: null, error: null },
    );
    (bulkImport as any)._context = { supabase: { rpc }, userId: "test-user-id" };
    return rpc;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [
      "the user lacks the entity permission",
      { data: false, error: null },
      { p_result: "failure", p_error_code: "FORBIDDEN" },
    ],
    [
      "the permission check itself errors",
      { data: null, error: { message: "boom" } },
      { p_result: "error", p_error_code: "PERMISSION_CHECK_FAILED" },
    ],
  ])("refuses, imports nothing and records why when %s", async (_scenario, permission, audited) => {
    const rpc = arrange(permission as { data: unknown; error: unknown });

    await expect(
      (bulkImport as any)({ entity: "tenants", rows: [{ code: "T-1" }] }),
    ).rejects.toBeTruthy();

    expect(rpc).not.toHaveBeenCalledWith("bulk_import_phase6", expect.anything());
    expect(rpc).toHaveBeenCalledWith(
      "write_audit",
      expect.objectContaining({
        p_action: "permission.denied",
        // The entity names what was attempted, so the trail says which import
        // was stopped rather than only that some import was.
        p_after: expect.objectContaining({ attempted: "import.tenants" }),
        ...audited,
      }),
    );
  });
});

/**
 * يسجّل رفض دفعة الاستيراد بسبب حد من حدود الشركة (T130).
 *
 * `bulk_import_phase6` imports an entity as one statement, so the trigger that
 * raises `LIMIT_UNITS` aborts the whole batch: the import is all-or-nothing and
 * the operator has to be told which limit refused it, how many rows were
 * refused, and what the file would have added.
 */
describe("bulkImport limit refusal", () => {
  /** يجهّز عميل Supabase مزيَّفاً يسمح بالاستيراد ويسجّل ما يصل إلى التدقيق. */
  function allowImport() {
    const rpc = vi.fn((name: string) =>
      name === "has_permission" ? { data: true, error: null } : { data: null, error: null },
    );
    (bulkImport as any)._context = { supabase: { rpc }, userId: "test-user-id" };
    return rpc;
  }

  /** صفّا وحدة في ملف ينتمي إلى عقار واحد. */
  const UNIT_ROWS = [
    { code: "U-1", name: "A", property_code: "P-1" },
    { code: "U-2", name: "B", property_code: "P-1" },
  ];

  /** يستدعي استيراد الوحدات عبر دالة الخادم الوهمية. */
  function importUnits(
    rows: Array<Record<string, unknown>>,
    rowNumbers?: number[],
  ): Promise<BulkImportResult> {
    const fn = bulkImport as unknown as (input: {
      entity: string;
      rows: Array<Record<string, unknown>>;
      rowNumbers?: number[];
    }) => Promise<BulkImportResult>;
    return fn({ entity: "units", rows, rowNumbers });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.importResult = { data: null, error: { code: "P0001", message: "LIMIT_UNITS" } };
    mocks.rpcCalls = [];
    mocks.tableResults = {
      building_categories: { data: [], error: null },
      buildings: { data: [], error: null },
      // The ceiling is 10 units and 8 are already there, so 2 still fit.
      company_limits: { data: { max_units: 10 }, error: null },
      properties: { data: [{ code: "P-1", id: "prop-1" }], error: null },
      tenants: { data: [], error: null },
      units: { count: 8, data: [], error: null },
    };
  });

  it.each([
    [
      "the units limit",
      { code: "P0001", message: "LIMIT_UNITS" },
      { code: "LIMIT_UNITS", i18nKey: "limits.LIMIT_UNITS", unitsAdded: 2, unitsAvailable: 2 },
    ],
    [
      "the staff limit",
      { code: "P0001", message: "LIMIT_STAFF" },
      {
        code: "LIMIT_STAFF",
        i18nKey: "limits.LIMIT_STAFF",
        unitsAdded: null,
        unitsAvailable: null,
      },
    ],
  ])("reports the whole batch as refused when %s refuses it", async (_limit, error, expected) => {
    mocks.importResult = { data: null, error };
    allowImport();

    const result = await importUnits(UNIT_ROWS);

    expect(result.inserted).toBe(0);
    expect(result.limit).toEqual({
      refusedRows: 2,
      rows: [
        { code: "U-1", row: 2 },
        { code: "U-2", row: 3 },
      ],
      ...expected,
    });
  });

  it("names the refused rows by their line in the file, not by their place in the batch", async () => {
    allowImport();

    const result = await importUnits(UNIT_ROWS, [5, 9]);

    expect(result.limit?.rows).toEqual([
      { code: "U-1", row: 5 },
      { code: "U-2", row: 9 },
    ]);
  });

  it("records the refusal in the audit trail", async () => {
    const rpc = allowImport();

    await importUnits([UNIT_ROWS[0]]);

    expect(rpc).toHaveBeenCalledWith(
      "write_audit",
      expect.objectContaining({ p_error_code: "LIMIT_UNITS", p_result: "failure" }),
    );
  });

  it("still fails the import when the database refuses for another reason", async () => {
    mocks.importResult = { data: null, error: { message: "syntax error at or near insert" } };
    allowImport();

    await expect(importUnits([UNIT_ROWS[0]])).rejects.toThrow("syntax error");
  });

  it("imports the rows the database accepted and reports no limit", async () => {
    mocks.importResult = { data: 2, error: null };
    allowImport();

    const result = await importUnits(UNIT_ROWS);

    expect(result).toEqual({ errors: [], inserted: 2, limit: null });
    // The SQL inserts exactly these rows: the resolved unit, with the ids it
    // resolved its codes into.
    const sent = (mocks.rpcCalls[0].args as { p_rows: Array<Record<string, unknown>> }).p_rows;
    expect(sent).toEqual([
      expect.objectContaining({ code: "U-1", property_id: "prop-1" }),
      expect.objectContaining({ code: "U-2", property_id: "prop-1" }),
    ]);
    expect(sent[0]).not.toHaveProperty("property_code");
  });
});
