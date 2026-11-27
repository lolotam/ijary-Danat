import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ImportBatchRow } from "@/fns/importBatches.server";
import type { JobHandlerContext } from "@/worker/runJob";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";
const REQUESTED_BY = "33333333-3333-4333-8333-333333333333";

/**
 * حالة قاعدة البيانات الوهمية لحدود النظام (PostgREST + RPC) في اختبارات `import.run`.
 */
const mocks = vi.hoisted(() => ({
  batchRow: null as ImportBatchRow | null,
  deletedBatchIds: [] as string[],
  auditResult: { data: null, error: null } as { data: unknown; error: unknown },
  importResult: { data: 2, error: null } as { data: unknown; error: unknown },
  jobRequest: null as { company_id: string; requested_by: string | null } | null,
  permitted: true,
  rpcCalls: [] as Array<{ args: unknown; name: string }>,
  tableResults: {} as Record<string, unknown>,
}));

vi.mock("@/company/requestCompany.server", () => ({
  runWithRequestCompany: async (_company: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({
    from: (table: string) => {
      if (table === "import_batches") {
        return {
          delete: () => ({
            eq: (_col: string, id: string) => ({
              select: () => ({
                maybeSingle: async () => {
                  const claimed = mocks.batchRow?.id === id ? mocks.batchRow : null;
                  if (claimed) {
                    mocks.deletedBatchIds.push(id);
                    mocks.batchRow = null;
                  }
                  return { data: claimed, error: null };
                },
              }),
            }),
          }),
        };
      }
      if (table === "job_requests") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: mocks.jobRequest, error: null }) }),
          }),
        };
      }
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "maybeSingle"]) {
        builder[method] = () => builder;
      }
      builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(mocks.tableResults[table]).then(resolve);
      return builder;
    },
    rpc: async (name: string, args: unknown) => {
      mocks.rpcCalls.push({ args, name });
      if (name === "bulk_import_phase6") return mocks.importResult;
      if (name === "write_audit") return mocks.auditResult;
      if (name === "has_permission") return { data: mocks.permitted, error: null };
      return { data: null, error: null };
    },
  }),
}));

import { createBulkImportRunHandler } from "@/jobs/handlers/bulkImportRun";

/** يبني سياق مهمة `import.run` كما يمرّره العامل للمعالج. */
function makeContext(uploadId = UPLOAD_ID): JobHandlerContext {
  return {
    jobRequestId: "44444444-4444-4444-8444-444444444444",
    companyId: COMPANY_ID,
    payload: { uploadId },
    attempt: 1,
  };
}

/** يهيّئ دفعة وحدات مرحَّلة صالحة. */
function seedUnitBatch(overrides: Partial<ImportBatchRow> = {}): ImportBatchRow {
  return {
    id: UPLOAD_ID,
    company_id: COMPANY_ID,
    entity: "units",
    rows: [
      { code: "U-1", name: "Unit 1", property_code: "P-1" },
      { code: "U-2", name: "Unit 2", property_code: "P-1" },
    ],
    row_numbers: [2, 3],
    requested_by: REQUESTED_BY,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.batchRow = seedUnitBatch();
  mocks.deletedBatchIds = [];
  mocks.auditResult = { data: null, error: null };
  mocks.importResult = { data: 2, error: null };
  mocks.jobRequest = { company_id: COMPANY_ID, requested_by: REQUESTED_BY };
  mocks.permitted = true;
  mocks.rpcCalls = [];
  mocks.tableResults = {
    building_categories: { data: [], error: null },
    buildings: { data: [], error: null },
    company_limits: { data: { max_units: 10 }, error: null },
    properties: { data: [{ code: "P-1", id: "prop-1" }], error: null },
    tenants: { data: [], error: null },
    units: { count: 8, data: [], error: null },
  };
});

describe("import.run bulk handler", () => {
  it("claims the batch, imports with p_created_by = requested_by, audits, and reports notice counts", async () => {
    const handler = createBulkImportRunHandler();

    const result = await handler(makeContext());

    expect(result).toEqual({ inserted: 2, errors: [], limit: null, created: 2, failed: 0 });
    expect(mocks.deletedBatchIds).toEqual([UPLOAD_ID]);
    const importCall = mocks.rpcCalls.find((call) => call.name === "bulk_import_phase6");
    expect(importCall?.args).toEqual({
      p_created_by: REQUESTED_BY,
      p_entity: "units",
      p_rows: [
        expect.objectContaining({ code: "U-1", property_id: "prop-1" }),
        expect.objectContaining({ code: "U-2", property_id: "prop-1" }),
      ],
    });
    expect(mocks.rpcCalls).toContainEqual({
      name: "write_audit",
      args: expect.objectContaining({
        p_action: "units.bulk_import",
        p_result: "success",
        p_after: { error_count: 0, inserted: 2, upload_id: UPLOAD_ID, requested_by: REQUESTED_BY },
      }),
    });
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
  ])(
    "returns the limit refusal, audits it, and leaves no batch when %s refuses it",
    async (_scenario, dbError, expectedLimit) => {
      mocks.importResult = { data: null, error: dbError };
      mocks.batchRow = seedUnitBatch({ row_numbers: [5, 9] });
      const handler = createBulkImportRunHandler();

      const result = await handler(makeContext());

      expect(result).toEqual({
        inserted: 0,
        created: 0,
        failed: 2,
        errors: [],
        limit: {
          refusedRows: 2,
          rows: [
            { code: "U-1", row: 5 },
            { code: "U-2", row: 9 },
          ],
          ...expectedLimit,
        },
      });
      expect(mocks.deletedBatchIds).toEqual([UPLOAD_ID]);
      expect(mocks.rpcCalls).toContainEqual({
        name: "write_audit",
        args: expect.objectContaining({
          p_error_code: expectedLimit.code,
          p_result: "failure",
        }),
      });
    },
  );

  it("fails with a clear error when the staged batch is missing", async () => {
    mocks.batchRow = null;
    const handler = createBulkImportRunHandler();

    await expect(handler(makeContext())).rejects.toThrow(
      `import batch ${UPLOAD_ID} not found or already claimed`,
    );
    expect(mocks.deletedBatchIds).toEqual([]);
  });

  it("never inserts twice: a retry after a failed import finds the batch already claimed", async () => {
    mocks.importResult = { data: null, error: { message: "connection reset" } };
    const handler = createBulkImportRunHandler();

    await expect(handler(makeContext())).rejects.toThrow("connection reset");
    mocks.importResult = { data: 2, error: null };
    await expect(handler(makeContext())).rejects.toThrow("already claimed");

    const inserts = mocks.rpcCalls.filter((call) => call.name === "bulk_import_phase6");
    expect(inserts).toHaveLength(1);
  });

  it.each([
    [
      "the requester lost the create permission",
      () => (mocks.permitted = false),
      "no longer import",
    ],
    [
      "the job was requested by someone other than the batch owner",
      () => (mocks.jobRequest = { company_id: COMPANY_ID, requested_by: "someone-else" }),
      "not requested by the batch's owner",
    ],
  ])("refuses without inserting when %s", async (_scenario, arrange, message) => {
    arrange();
    const handler = createBulkImportRunHandler();

    await expect(handler(makeContext())).rejects.toThrow(message);
    expect(mocks.rpcCalls.filter((call) => call.name === "bulk_import_phase6")).toHaveLength(0);
    expect(mocks.deletedBatchIds).toEqual([UPLOAD_ID]);
  });

  it("does not fail the job when the success audit cannot be written after the rows committed", async () => {
    mocks.auditResult = { data: null, error: { message: "audit down" } };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createBulkImportRunHandler();

    const result = await handler(makeContext());

    expect(result).toMatchObject({ inserted: 2, created: 2 });
  });
});
