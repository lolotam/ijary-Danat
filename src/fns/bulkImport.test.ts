import { beforeEach, describe, expect, it, vi } from "vitest";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const BATCH_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";

/**
 * عميل Supabase الذي يمرّر companyClient — الحدّ الفاصل الذي يُحاكى هنا.
 */
const mocks = vi.hoisted(() => ({
  stagedBatches: [] as Array<Record<string, unknown>>,
  stageError: null as { message: string } | null,
  enqueueError: null as { message: string } | null,
  rpcCalls: [] as Array<{ args: unknown; name: string }>,
}));

vi.mock("@tanstack/react-start", () => {
  const fn: Record<string, unknown> & ((data: unknown) => unknown) = ((data: unknown) =>
    (fn._handler as (input: { data: unknown; context: unknown }) => unknown)({
      data,
      context: fn._context,
    })) as Record<string, unknown> & ((data: unknown) => unknown);
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((handler: unknown) => {
    fn._handler = handler;
    return fn;
  });
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middleware: unknown) => middleware),
    }),
  };
});

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => ({
        select: () => ({
          single: async () => {
            if (mocks.stageError) return { data: null, error: mocks.stageError };
            if (table === "import_batches") mocks.stagedBatches.push(row);
            return { data: { id: BATCH_ID }, error: null };
          },
        }),
      }),
    }),
    rpc: async (name: string, args: unknown) => {
      mocks.rpcCalls.push({ args, name });
      if (mocks.enqueueError) return { data: null, error: mocks.enqueueError };
      return { data: JOB_ID, error: null };
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
  type BulkImportInput,
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

  it.each<Array<[string, Array<Record<string, unknown>>]>[number]>([
    ["blank code", [{ code: "" }, { code: "" }]],
    ["whitespace-only code", [{ code: "  " }, { code: "  " }]],
    ["missing code", [{ name: "A" }, { name: "B" }]],
  ])("leaves rows with %s alone — the importer generates one per row", (_scenario, rows) => {
    expect(dedupeRowsByCode(rows)).toHaveLength(2);
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
    expect([...ENTITIES_DEDUPED_BY_CODE]).toEqual(["tenants", "contracts"]);
  });
});

describe("bulkImport permission refusal", () => {
  /** يجهّز عميل Supabase مزيَّفاً بنتيجة تحقق صلاحية محدَّدة. */
  function arrange(permission: { data: unknown; error: unknown }) {
    const rpc = vi.fn((name: string) =>
      name === "has_permission" ? permission : { data: null, error: null },
    );
    (bulkImport as unknown as { _context: unknown })._context = {
      supabase: { rpc },
      userId: "test-user-id",
    };
    return rpc;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stagedBatches = [];
    mocks.stageError = null;
    mocks.enqueueError = null;
    mocks.rpcCalls = [];
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
  ])("refuses, stages nothing and records why when %s", async (_scenario, permission, audited) => {
    const rpc = arrange(permission);

    await expect(
      (bulkImport as unknown as (input: BulkImportInput) => Promise<BulkImportResult>)({
        entity: "tenants",
        rows: [{ code: "T-1", name: "A" }],
      }),
    ).rejects.toBeTruthy();

    expect(mocks.stagedBatches).toHaveLength(0);
    expect(mocks.rpcCalls).toHaveLength(0);
    expect(rpc).toHaveBeenCalledWith(
      "write_audit",
      expect.objectContaining({
        p_action: "permission.denied",
        p_after: expect.objectContaining({ attempted: "import.tenants" }),
        ...audited,
      }),
    );
  });
});

describe("bulkImport staging and queuing", () => {
  /** يسمح بالصلاحية ويهيّئ سياق الموظف لإرسال الاستيراد، مع نتيجة كتابة التدقيق. */
  function allowImport(
    auditResult: { data: unknown; error: unknown } = { data: "a1", error: null },
  ) {
    const rpc = vi.fn((name: string) => {
      if (name === "has_permission") return { data: true, error: null };
      if (name === "write_audit") return auditResult;
      return { data: null, error: null };
    });
    (bulkImport as unknown as { _context: unknown })._context = {
      supabase: { rpc },
      userId: "staff-user-1",
    };
    return rpc;
  }

  /** يستدعي دالة الخادم عبر الموك. */
  function callImport(input: BulkImportInput): Promise<BulkImportResult> {
    return (bulkImport as unknown as (data: BulkImportInput) => Promise<BulkImportResult>)(input);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stagedBatches = [];
    mocks.stageError = null;
    mocks.enqueueError = null;
    mocks.rpcCalls = [];
  });

  it("stages valid rows, audits the request as the caller, enqueues import.run, and returns validation errors", async () => {
    const callerRpc = allowImport();

    const result = await callImport({
      entity: "units",
      rows: [
        { code: "U-1", name: "Unit 1", property_code: "P-1" },
        { code: "U-2", name: "", property_code: "P-1" },
      ],
      rowNumbers: [2, 3],
    });

    expect(result).toEqual({
      queued: true,
      jobRequestId: JOB_ID,
      errors: [expect.objectContaining({ row: 3 })],
    });
    expect(mocks.stagedBatches).toEqual([
      {
        company_id: COMPANY_ID,
        entity: "units",
        rows: [expect.objectContaining({ code: "U-1", name: "Unit 1", property_code: "P-1" })],
        row_numbers: [2, 3],
        requested_by: "staff-user-1",
      },
    ]);
    expect(mocks.rpcCalls).toEqual([
      {
        name: "enqueue_job",
        args: {
          _kind: "import.run",
          _payload: { uploadId: BATCH_ID },
          _dedupe_key: `import.run:${BATCH_ID}`,
          _requested_by: "staff-user-1",
        },
      },
    ]);
    expect(callerRpc).toHaveBeenCalledWith("write_audit", {
      p_action: "units.bulk_import_requested",
      p_after: { error_count: 1, staged_rows: 1, upload_id: BATCH_ID },
      p_before: null,
      p_entity_id: null,
      p_entity_type: "units",
      p_error_code: null,
      p_result: "success",
    });
  });

  it("enqueues nothing when the request audit cannot be written", async () => {
    allowImport({ data: null, error: { message: "audit down" } });

    await expect(
      callImport({
        entity: "units",
        rows: [{ code: "U-1", name: "Unit 1", property_code: "P-1" }],
      }),
    ).rejects.toThrow("audit down");
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("stages nothing and enqueues no job when no valid row remains", async () => {
    allowImport();

    const result = await callImport({
      entity: "units",
      rows: [{ code: "U-1", name: "", property_code: "P-1" }],
    });

    expect(result).toEqual({
      queued: false,
      inserted: 0,
      errors: [expect.objectContaining({ row: 2 })],
      limit: null,
    });
    expect(mocks.stagedBatches).toHaveLength(0);
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("propagates staging failure without enqueueing a job", async () => {
    allowImport();
    mocks.stageError = { message: "disk full" };

    await expect(
      callImport({
        entity: "units",
        rows: [{ code: "U-1", name: "Unit 1", property_code: "P-1" }],
      }),
    ).rejects.toThrow("disk full");
    expect(mocks.rpcCalls).toHaveLength(0);
  });
});
