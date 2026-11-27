import { beforeEach, describe, expect, test, vi } from "vitest";

// The ports reach Postgres through the service-role client. The unit tests
// drive them with an in-memory database, so the real client must never be built.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => fakeFrom(table) },
}));

import { runJobPorts } from "@/worker/runJobPorts";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const STAFF_ID = "44444444-4444-4444-8444-444444444444";

/** الجداول التي تحتفظ بها قاعدة البيانات الوهمية. */
interface FakeTables {
  job_requests: Array<Record<string, unknown>>;
  companies: Array<Record<string, unknown>>;
  company_modules: Array<Record<string, unknown>>;
}

/** ما سجّلته قاعدة البيانات الوهمية من كتابات. */
interface FakeWrites {
  updates: Array<{
    table: string;
    filters: Record<string, unknown>;
    patch: Record<string, unknown>;
  }>;
  upserts: Array<{ table: string; values: Record<string, unknown>; options: unknown }>;
}

/** قاعدة البيانات الوهمية: صفوفها وكتاباتها وأخطاؤها. */
interface FakeDatabase {
  tables: FakeTables;
  writes: FakeWrites;
  /** خطأ تعيده جدول معيّن بدل صفوفه. */
  failures: Record<string, { message: string; code?: string }>;
}

/** قاعدة البيانات الوهمية التي يقرأ منها العامل في هذا الملف. */
const fakeDb = vi.hoisted(() => ({
  tables: {
    job_requests: [],
    companies: [],
    company_modules: [],
  } as FakeTables,
  writes: {
    updates: [],
    upserts: [],
  } as FakeWrites,
  failures: {} as Record<string, { message: string; code?: string }>,
}));

/**
 * يختار الصف الذي يطابق مرشّحات الاستعلام، ويسجّل الكتابة إن وُجدت.
 */
function resolveRow(
  table: string,
  filters: Record<string, unknown>,
  patch: Record<string, unknown> | null,
): { data: Record<string, unknown> | null; error: { message: string; code?: string } | null } {
  const failure = fakeDb.failures[table];
  if (failure) return { data: null, error: failure };

  const rows = fakeDb.tables[table as keyof FakeTables] ?? [];
  const matched = rows.filter((row) =>
    Object.entries(filters).every(([column, value]) => row[column] === value),
  );
  const row = matched[0] ?? null;
  if (patch) {
    fakeDb.writes.updates.push({ table, filters, patch });
    if (row) Object.assign(row, patch);
  }
  return { data: row, error: null };
}

/**
 * يبني سلسلة استعلام PostgREST وهمية: تصفية، تحديث، إدراج، ثم قراءة صف واحد.
 */
function fakeFrom(table: string) {
  const filters: Record<string, unknown> = {};
  let patch: Record<string, unknown> | null = null;
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => {
      filters[column] = value;
      return chain;
    },
    update: (values: Record<string, unknown>) => {
      patch = values;
      return chain;
    },
    upsert: (values: Record<string, unknown>, options: unknown) => {
      fakeDb.writes.upserts.push({ table, values, options });
      return Promise.resolve({ data: null, error: null });
    },
    maybeSingle: () => Promise.resolve(resolveRow(table, filters, patch)),
  };
  return chain;
}

/**
 * يعيد الصفوف التي يحتاجها كل اختبار، ويصفّر ما سُجّل.
 */
function seedTables(): void {
  fakeDb.tables.job_requests = [
    {
      id: REQUEST_ID,
      company_id: COMPANY_ID,
      kind: "notification.bulk",
      payload: { requestId: REQUEST_ID },
      status: "published",
      requested_by: STAFF_ID,
    },
  ];
  fakeDb.tables.companies = [{ id: COMPANY_ID, status: "active" }];
  fakeDb.tables.company_modules = [
    { company_id: COMPANY_ID, module_key: "invoices", enabled: true },
  ];
  fakeDb.writes.updates = [];
  fakeDb.writes.upserts = [];
  fakeDb.failures = {};
}

describe("the runJob ports (T064)", () => {
  beforeEach(() => {
    seedTables();
  });

  test("the row of another company is invisible to the worker", async () => {
    const row = await runJobPorts.loadRequest({
      id: REQUEST_ID,
      companyId: OTHER_COMPANY_ID,
    });

    expect(row).toBeNull();
  });

  test("the row is read with its payload and its requester", async () => {
    const row = await runJobPorts.loadRequest({ id: REQUEST_ID, companyId: COMPANY_ID });

    expect(row).toEqual({
      id: REQUEST_ID,
      companyId: COMPANY_ID,
      kind: "notification.bulk",
      payload: { requestId: REQUEST_ID },
      status: "published",
      requestedBy: STAFF_ID,
    });
  });

  test("a status write names the row and its company together", async () => {
    await runJobPorts.markSucceeded({ id: REQUEST_ID, companyId: COMPANY_ID }, { sent: 3 });

    expect(fakeDb.writes.updates).toHaveLength(1);
    expect(fakeDb.writes.updates[0].filters).toEqual({ id: REQUEST_ID, company_id: COMPANY_ID });
    expect(fakeDb.writes.updates[0].patch).toMatchObject({
      status: "succeeded",
      result: { sent: 3 },
    });
    expect(fakeDb.tables.job_requests[0].status).toBe("succeeded");
  });

  test("a row that matches neither filter is a defect, not a silent success", async () => {
    await expect(
      runJobPorts.markFailed({ id: REQUEST_ID, companyId: OTHER_COMPANY_ID }, "boom"),
    ).rejects.toThrow(REQUEST_ID);
  });

  test("the company of the job is read as active or suspended", async () => {
    fakeDb.tables.companies = [{ id: COMPANY_ID, status: "suspended" }];

    expect(await runJobPorts.companyStatus(COMPANY_ID)).toBe("suspended");
  });

  test("a company that is not there is a defect, not an active company", async () => {
    await expect(runJobPorts.companyStatus(OTHER_COMPANY_ID)).rejects.toThrow(OTHER_COMPANY_ID);
  });

  test("a section that is on reads as on, and a section with no row reads as off", async () => {
    expect(await runJobPorts.sectionEnabled(COMPANY_ID, "invoices")).toBe(true);
    expect(await runJobPorts.sectionEnabled(COMPANY_ID, "reports")).toBe(false);
  });

  test("the section table that migration 290 adds reads as on until it exists", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeDb.failures.company_modules = { message: "table not found", code: "PGRST205" };

    expect(await runJobPorts.sectionEnabled(COMPANY_ID, "invoices")).toBe(true);
    expect(consoleWarn).toHaveBeenCalled();
  });

  test("a section that fails to read is an error, not an open section", async () => {
    fakeDb.failures.company_modules = { message: "connection refused", code: "08006" };

    await expect(runJobPorts.sectionEnabled(COMPANY_ID, "invoices")).rejects.toThrow(
      "sectionEnabled",
    );
  });

  test("the notice is written once per job request, with its title key", async () => {
    await runJobPorts.writeNotice({
      companyId: COMPANY_ID,
      userId: STAFF_ID,
      jobRequestId: REQUEST_ID,
      kind: "notification.bulk",
      level: "success",
    });

    expect(fakeDb.writes.upserts).toHaveLength(1);
    expect(fakeDb.writes.upserts[0].values).toMatchObject({
      company_id: COMPANY_ID,
      user_id: STAFF_ID,
      job_request_id: REQUEST_ID,
      kind: "notification.bulk",
      title_key: "notices.notification.bulk.success",
      level: "success",
    });
    // The write names the unique index on the job request, so a retry of the
    // job writes one notice and not two.
    expect(fakeDb.writes.upserts[0].options).toEqual({
      onConflict: "job_request_id",
      ignoreDuplicates: true,
    });
  });

  test("the notice body carries the result counts when the notice has them", async () => {
    await runJobPorts.writeNotice({
      companyId: COMPANY_ID,
      userId: STAFF_ID,
      jobRequestId: REQUEST_ID,
      kind: "notification.bulk",
      level: "success",
      body: { created: 2, skipped: 1, failed: 0 },
    });

    expect(fakeDb.writes.upserts).toHaveLength(1);
    expect(fakeDb.writes.upserts[0].values).toMatchObject({
      body: { created: 2, skipped: 1, failed: 0 },
    });
    expect(fakeDb.writes.upserts[0].options).toEqual({
      onConflict: "job_request_id",
      ignoreDuplicates: true,
    });
  });

  test("a notice with no counts writes no body", async () => {
    await runJobPorts.writeNotice({
      companyId: COMPANY_ID,
      userId: STAFF_ID,
      jobRequestId: REQUEST_ID,
      kind: "notification.bulk",
      level: "success",
    });

    expect(fakeDb.writes.upserts).toHaveLength(1);
    expect(fakeDb.writes.upserts[0].values).not.toHaveProperty("body");
  });
});
