import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobKind } from "@/jobs/catalog";
import type { JobHandlerContext } from "@/worker/runJob";

import {
  createFakeDb,
  fakeClient,
  makeRows,
  makeUuidRows,
  requestCompanyModule,
  resetFakeDb,
  seedTable,
  type FakeDb,
} from "./bulkHandlers.testkit";

vi.mock("@/company/requestCompany.server", () => requestCompanyModule());
vi.mock("@/company/companyClient.server", () => ({ companyClient: () => fakeClient(fake) }));

// The module mock above runs lazily on the first import of the mocked module,
// which happens at the dynamic `./bulk` import below — after `fake` exists.
const fake: FakeDb = createFakeDb();
const { createBulkHandlers } = await import("./bulk");

/** معرّف دفعة الإرسال الجماعي الذي تحمله صفوف الدفعة المُرحَّلة. */
const BATCH_ID = "55555555-5555-4555-8555-555555555555";

/** عدد صفوف المدخلات الذي يبني عليه كل اختبار الدفعات. */
const INPUT_ROWS = 450;

/** أنواع المهام الضخمة التي يغطيها هذا الاختبار. */
type BulkKind =
  | "notification.bulk"
  | "invoices.generate"
  | "invoices.regenerate"
  | "electricity.generate";

/** استدعاء RPC الذي يولّد أثر كل نوع — هدف انهيار الدفعة الثانية. */
const workRpc: Record<BulkKind, string> = {
  "notification.bulk": "enqueue_job",
  "invoices.generate": "generate_invoices",
  "invoices.regenerate": "regenerate_contract_invoices",
  "electricity.generate": "generate_electricity_charges",
};

/** الجدول الذي تقرأ منه حمّالة دفعات كل نوع. */
const loaderTable: Record<BulkKind, string> = {
  "notification.bulk": "notifications",
  "invoices.generate": "contracts",
  "invoices.regenerate": "contracts",
  "electricity.generate": "units",
};

/** يبني سياق مهمة كما يسلّمه العامل إلى المعالج. */
function jobContext(payload: unknown): JobHandlerContext {
  return {
    jobRequestId: "44444444-4444-4444-8444-444444444444",
    companyId: "00000000-0000-4000-8000-000000000001",
    payload,
    attempt: 1,
  };
}

/**
 * يزرع مدخلات نوع واحد ويجهّز سياق مهمته.
 *
 * The fake returns the seeded rows regardless of the loader's id filter, so
 * the `invoices.regenerate` fixture stands for a request naming many
 * contracts — the work is row-generic; today's catalogue payload names one,
 * which is one chunk of one row in production.
 */
function arrange(kind: JobKind): JobHandlerContext {
  if (kind === "notification.bulk") {
    seedTable(
      fake,
      "notifications",
      makeUuidRows(INPUT_ROWS, { state: "queued", payload: { batch_id: BATCH_ID } }),
    );
    return jobContext({ requestId: BATCH_ID });
  }
  if (kind === "electricity.generate") {
    seedTable(fake, "units", makeRows(INPUT_ROWS, "unit", { electricity_meters: [{ id: "m" }] }));
    return jobContext({ period: "2026-03" });
  }
  seedTable(fake, "contracts", makeRows(INPUT_ROWS, "contract", { archived_at: null }));
  return kind === "invoices.generate"
    ? jobContext({ year: 2026 })
    : jobContext({
        contractId: "22222222-2222-4222-8222-222222222222",
        requestId: "33333333-3333-4333-8333-333333333333",
      });
}

/** أثر السجلات التي أُنشئت فعلاً: مفاتيح الإدراج النظيفة وطلبات الإرسال. */
function createdEffects(): number {
  return fake.createdKeys.size + fake.jobs.length;
}

const kinds: BulkKind[] = Object.keys(workRpc) as BulkKind[];

beforeEach(() => {
  resetFakeDb(fake);
});

describe.each(kinds)("the %s bulk handler", (kind) => {
  it("processes 450 input rows in 3 chunks of 200, 200 and 50", async () => {
    const ctx = arrange(kind);
    const handler = createBulkHandlers()[kind];

    const result = (await handler!(ctx)) as {
      created: number;
      skipped: number;
      failed: number;
    };

    // The chunk boundary is the per-chunk input read: 450 rows read at
    // offsets 0, 200 and 400 are exactly three chunks of 200 / 200 / 50.
    const chunkReads = fake.reads.filter((read) => read.table === loaderTable[kind]);
    expect(chunkReads.map((read) => read.from)).toEqual([0, 200, 400]);
    expect(result).toMatchObject({ created: 450, skipped: 0, failed: 0 });
    expect(createdEffects()).toBe(450);
  });

  it("creates no duplicates and counts correctly when a crash in chunk 2 is retried", async () => {
    const ctx = arrange(kind);
    const handler = createBulkHandlers()[kind];
    fake.crashAt = { name: workRpc[kind], at: 250 };

    // The crash lands on row 250 — the 50th row of chunk 2 — after rows 1-249
    // committed. The attempt fails as a whole, exactly as BullMQ sees it.
    await expect(handler!(ctx)).rejects.toThrow("simulated crash");
    expect(createdEffects()).toBe(249);

    fake.crashAt = null;
    const rerun = (await handler!(ctx)) as {
      created: number;
      skipped: number;
      failed: number;
    };

    // Rows 1-249 were done by the crashed attempt and are counted skipped,
    // never created twice; rows 250-450 are created now. 249 + 201 = 450.
    expect(rerun).toMatchObject({ created: 201, skipped: 249, failed: 0 });
    expect(createdEffects()).toBe(450);
  });
});

describe("per-item refusals", () => {
  it("counts a SQLSTATE refusal as a failed item and keeps processing the chunk", async () => {
    // One contract's data problem must not block the other 449: the refusal
    // carries a SQLSTATE, so it is counted and named in `errors` instead of
    // crashing the whole job.
    const ctx = arrange("invoices.generate");
    const handler = createBulkHandlers()["invoices.generate"]!;
    fake.refusal = {
      name: "generate_invoices",
      match: (args) => args.p_contract_id === "contract-0250",
      error: { message: "contract refused", code: "P0001" },
    };

    const result = (await handler(ctx)) as {
      created: number;
      skipped: number;
      failed: number;
      errors: string[];
    };

    expect(result).toMatchObject({ created: 449, skipped: 0, failed: 1 });
    expect(result.errors).toEqual(["generate_invoices(contract-0250) failed: contract refused"]);
  });

  it("throws an error with no SQLSTATE instead of counting it as one item", async () => {
    const ctx = arrange("electricity.generate");
    const handler = createBulkHandlers()["electricity.generate"]!;
    fake.refusal = {
      name: "generate_electricity_charges",
      match: (args) => args.p_unit_id === "unit-0100",
      error: { message: "fetch failed", code: "" },
    };

    await expect(handler(ctx)).rejects.toThrow("generate_electricity_charges(unit-0100) failed");
  });
});
