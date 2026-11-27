import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resendGeneratedReportRecord } from "@/jobs/handlers/documentsReport";
import { resetDispatchFixtures, restoreDispatchFixtures } from "@/fns/dispatchNotification.testkit";

import {
  DISPATCH_LEASE_MS,
  dispatchNotificationRecord,
  retryFailedNotificationRecord,
} from "./dispatchNotification.server";
import { runNotificationDrainJob } from "./notificationDrainJob";

vi.mock("@tanstack/react-start", async () =>
  (await import("@/fns/dispatchNotification.testkit")).tanstackStartModule(),
);
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));
vi.mock("@/company/requestCompany.server", async () =>
  (await import("@/fns/dispatchNotification.testkit")).requestCompanyModule(),
);
vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => fakeClient(),
  serverCompanyClient: (explicitCompanyId?: string) => ({
    companyId: explicitCompanyId ?? COMPANY_ID,
    client: fakeClient(),
  }),
}));

/**
 * اختبارات حجز إرسال الإشعار (GR-001، GR-004، GR-005): محاولة واحدة تصل
 * للمزوّد، والخطأ بعد الحجز يترك أثره، وخاسر الحجز لا يسجّل فشلاً.
 *
 * Only the system boundaries are faked — the database and the provider's HTTP
 * call. `dispatchNotificationRecord`, `retryFailedNotificationRecord`,
 * `runNotificationDrainJob` and `resendGeneratedReportRecord` all run for
 * real, so "the message went out once" is observed as exactly one outbound
 * provider request. The fake database applies conditional updates the way
 * Postgres does: of two claim updates on one row, the first match wins and
 * the second matches nothing.
 */

type FakeRow = Record<string, unknown>;

/** نتائج الاستعلامات المحقونة كأعطال: اسم الجدول → رسالة الخطأ. */
const tableErrors = new Map<string, string>();

/** جداول وهمية بصفوفها، وسجلّ نداءات RPC والتحديثات. */
const store = {
  tables: new Map<string, FakeRow[]>(),
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; values: FakeRow; matched: number }>,
};

/** يصفّر الجداول ويزرع صفوف كل حالة اختبار. */
function resetFakeDatabase(): void {
  tableErrors.clear();
  store.tables = new Map();
  store.rpcCalls.length = 0;
  store.updates.length = 0;
  seedFixtures();
}

/** صفوف جدول كما هي الآن في المخزون. */
function rowsOf(table: string): FakeRow[] {
  return store.tables.get(table) ?? [];
}

/** نداءات RPC المسجّلة لاسم واحد. */
function rpcCallsOf(name: string): Array<{ name: string; args: Record<string, unknown> }> {
  return store.rpcCalls.filter((call) => call.name === name);
}

/** التحديثات المكتوبة على جدول واحد، بالترتيب. */
function updatesOf(table: string): Array<{ values: FakeRow; matched: number }> {
  return store.updates
    .filter((update) => update.table === table)
    .map(({ values, matched }) => ({ values, matched }));
}

/** شرط واحد على صف في السلسلة. */
type RowPredicate = (row: FakeRow) => boolean;

/**
 * يبني سلسلة PostgREST مصغّرة: ترشيح، ترتيب، تحديث، ثم قراءة النتيجة.
 *
 * The claim's `or(dispatch_claimed_at.is.null, dispatch_claimed_at.lt.<iso>)`
 * lease condition is evaluated for real — that condition is the whole point of
 * these tests, so a pass-through would make them assert nothing. Everything
 * else follows `idempotency.testkit`'s shapes.
 */
function createQuery(table: string) {
  const predicates: RowPredicate[] = [];
  let updated: FakeRow | null = null;
  let inserted: FakeRow | null = null;
  let sorted: { column: string; ascending: boolean } | null = null;
  let rowLimit: number | null = null;

  /** الصفوف المطابقة، بعد تطبيق التحديث إن وُجد. */
  const materialize = (): FakeRow[] => {
    const matched = (store.tables.get(table) ?? []).filter((row) =>
      predicates.every((test) => test(row)),
    );
    if (updated) {
      for (const row of matched) Object.assign(row, updated);
      store.updates.push({ table, values: updated, matched: matched.length });
    }
    if (inserted) {
      const row = { id: `row-${rowsOf(table).length + 1}`, ...inserted };
      store.tables.set(table, [...rowsOf(table), row]);
      return [{ ...row }];
    }
    return matched.map((row) => ({ ...row }));
  };

  /** يرتّب النتيجة ويحدّها كما يفعل `order` و`limit`. */
  const shaped = (rows: FakeRow[]): FakeRow[] => {
    const ordered = sorted
      ? [...rows].sort((left, right) => {
          const a = String(left[sorted!.column] ?? "");
          const b = String(right[sorted!.column] ?? "");
          const order = a === b ? 0 : a > b ? 1 : -1;
          return sorted!.ascending ? order : -order;
        })
      : rows;
    return rowLimit === null ? ordered : ordered.slice(0, rowLimit);
  };

  const addPredicate = (predicate: RowPredicate) => {
    predicates.push(predicate);
    return chain;
  };

  const chain = {
    select: () => chain,
    update: (values: FakeRow) => {
      updated = values;
      return chain;
    },
    insert: (values: FakeRow) => {
      inserted = values;
      return chain;
    },
    upsert: (values: FakeRow) => {
      inserted = values;
      return chain;
    },
    eq: (column: string, value: unknown) => addPredicate((row) => row[column] === value),
    in: (column: string, values: readonly unknown[]) =>
      addPredicate((row) => values.includes(row[column])),
    /**
     * يطبّق شرط `or` بصيغة PostgREST: فروع مفصولة بفواصل من شكل `عمود.عملية.قيمة`.
     *
     * Only the branches the dispatch claim uses are parsed (`is.null` and
     * `lt.<iso>`); anything else fails loudly instead of silently matching.
     */
    or: (filters: string) => {
      const branches = filters.split(",").map((part) => part.trim());
      return addPredicate((row) =>
        branches.some((branch) => {
          const [column, operator, ...rest] = branch.split(".");
          const value = rest.join(".");
          if (operator === "is" && value === "null") return row[column] == null;
          if (operator === "lt") return row[column] != null && String(row[column]) < value;
          throw new Error(`Unsupported or() branch in fake database: ${branch}`);
        }),
      );
    },
    order: (column: string, options?: { ascending?: boolean }) => {
      sorted = { column, ascending: options?.ascending !== false };
      return chain;
    },
    limit: (count: number) => {
      rowLimit = count;
      return chain;
    },
    single: () => Promise.resolve(resolveOne()),
    maybeSingle: () => Promise.resolve(resolveMaybe()),
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(resolveList()).then(onFulfilled, onRejected),
  };

  /** يردّ بخطأ الجدول المحقون، أو ينفّذ الاستعلام. */
  const outcome = <T>(value: T, error: { message: string } | null) => {
    const injected = tableErrors.get(table);
    return injected ? { data: null, error: { message: injected } } : { data: value, error };
  };

  const resolveList = () => {
    const rows = shaped(materialize());
    return outcome(rows, null);
  };
  const resolveOne = () => {
    const rows = shaped(materialize());
    return rows.length === 1
      ? outcome(rows[0], null)
      : outcome(null, {
          message: "JSON object requested, multiple (or no) rows returned",
        });
  };
  const resolveMaybe = () => outcome(shaped(materialize())[0] ?? null, null);

  return chain;
}

/** عميل Supabase وهمي يخدم الجداول ونداءات RPC والتخزين. */
function fakeClient() {
  return {
    from: (table: string) => createQuery(table),
    rpc: (name: string, args: Record<string, unknown>) => {
      store.rpcCalls.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
    storage: {
      from: () => ({
        download: () => Promise.resolve({ data: null, error: { message: "not found" } }),
        upload: (path: string) => Promise.resolve({ data: { path }, error: null }),
      }),
    },
  };
}

const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const NOTIFICATION_ID = "66666666-6666-4666-8666-666666666666";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const JOB_REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const GENERATED_REPORT_ID = "44444444-4444-4444-8444-444444444444";

/** رد المزوّد الذي قبِل الرسالة. */
function acceptedByProvider(): Response {
  return new Response(JSON.stringify({ id: "resend-1" }), { status: 200 });
}

/**
 * يزرع الجداول التي يقرأها كل سيناريو: شركة، مستأجر، مزوّد Resend، وجدول
 * زمني تقرير مع تقرير مولَّد.
 */
function seedFixtures(): void {
  store.tables.set("companies", [
    {
      id: COMPANY_ID,
      name_ar: "دانة",
      name_en: "Danat",
      brand_primary: null,
      brand_accent: null,
      logo_url: null,
      favicon_url: null,
      portal_bg_url: null,
      email_logo_url: null,
    },
  ]);
  store.tables.set("tenants", [
    {
      id: TENANT_ID,
      name: "أحمد",
      email: "tenant@example.test",
      whatsapp: "+96550000000",
      mobile: null,
      preferred_language: "ar",
      reminders_enabled: true,
      notifications_paused: false,
    },
  ]);
  store.tables.set("provider_configs", [
    {
      provider: "resend",
      is_enabled: true,
      is_primary: true,
      config: { secret_env: "RESEND_API_KEY" },
      from_email: "billing@example.test",
      from_whatsapp: null,
    },
  ]);
  store.tables.set("notification_templates", []);
  store.tables.set("gmail_messages", []);
  store.tables.set("job_requests", []);
  store.tables.set("notifications", []);
  store.tables.set("generated_reports", [
    {
      id: GENERATED_REPORT_ID,
      company_id: COMPANY_ID,
      schedule_id: "schedule-1",
      period_start: "2026-09-21",
      period_end: "2026-09-28",
      html_content: "<p>تقرير</p>",
      locale: "ar",
      sent: false,
      sent_at: null,
    },
  ]);
  store.tables.set("report_schedules", [
    {
      id: "schedule-1",
      company_id: COMPANY_ID,
      report_kind: "summary",
      frequency: "weekly",
      locale: "ar",
      name_ar: "تقرير أسبوعي",
      name_en: "Weekly Report",
      recipients: ["owner@example.test"],
    },
  ]);
}

/** يزرع صف إشعار جاهزاً للإرسال، ويسمح بتغيير أي حقائقه. */
function seedNotification(overrides: FakeRow = {}): FakeRow {
  const row: FakeRow = {
    id: NOTIFICATION_ID,
    company_id: COMPANY_ID,
    audience: "tenant",
    body: "Payment received.",
    channel: "email",
    locale: "ar",
    payload: { tenant_name: "أحمد" },
    provider: null,
    recipient_address: "tenant@example.test",
    retry_count: 0,
    sender_address: null,
    state: "queued",
    subject: "Receipt",
    template_code: null,
    tenant_id: TENANT_ID,
    type: "receipt",
    dispatch_claimed_at: null,
    delivery_key: null,
    failure_reason: null,
    error_code: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
  store.tables.set("notifications", [row]);
  return row;
}

/** يزرع صف تسليم تقرير فاشل تحت مفتاح تسليم المهمة — ما تقرأه إعادة الإرسال. */
function seedFailedReportDelivery(): FakeRow {
  return seedNotification({
    type: "scheduled_report",
    audience: "admin",
    state: "failed",
    retry_count: 2,
    delivery_key: `${JOB_REQUEST_ID}:email`,
    subject: "تقرير — 2026-09-21 / 2026-09-28",
    body: "<p>تقرير</p>",
    recipient_address: "owner@example.test",
    payload: { generated_report_id: GENERATED_REPORT_ID, recipients: ["owner@example.test"] },
    tenant_id: null,
    failure_reason: "provider refused",
    error_code: "provider_down",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFakeDatabase();
  resetDispatchFixtures();
});
afterEach(restoreDispatchFixtures);

describe("the dispatch lease hands a row to exactly one sender (GR-001)", () => {
  test("a drain run during the claimer's pending provider call sends nothing", async () => {
    // سيناريو السباق بالضبط: مسار إعادة المحاولة يحجز الصف ويبدأ الإرسال، ثم
    // تعمل مهمة التفريغ قبل أن يردّ المزوّد. الطلب مرة واحدة بالضبط.
    seedNotification({ state: "failed", retry_count: 1 });
    const provider = vi.mocked(globalThis.fetch);
    let releaseSend: ((response: Response) => void) | undefined;
    provider.mockImplementation(() => new Promise<Response>((resolve) => (releaseSend = resolve)));

    const retrying = retryFailedNotificationRecord(NOTIFICATION_ID, 1, COMPANY_ID);
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    // الحجز ظاهر على الصف: إرسال جارٍ يملك المهلة.
    expect(rowsOf("notifications")[0]).toMatchObject({
      state: "queued",
      dispatch_claimed_at: expect.any(String),
    });

    const drain = await runNotificationDrainJob(null, COMPANY_ID);

    expect(provider).toHaveBeenCalledTimes(1);
    expect(drain.dispatched).toEqual([]);
    expect(drain.retried).toEqual([]);
    expect(drain.skippedInFlight).toBe(1);
    expect(drain.count).toBe(0);

    releaseSend?.(acceptedByProvider());
    const row = await retrying;

    expect(provider).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({ state: "sent" });
    expect(rowsOf("notifications")[0]).toMatchObject({
      state: "sent",
      dispatch_claimed_at: null,
    });
  });

  test.each([
    {
      expectation: "another sender holds a fresh lease",
      claimedAt: new Date().toISOString(),
      sends: 0,
    },
    {
      expectation: "the lease expired and the row is reclaimable",
      claimedAt: new Date(Date.now() - DISPATCH_LEASE_MS - 60_000).toISOString(),
      sends: 1,
    },
  ])(
    "dispatching a queued row whose $expectation makes $sends provider call(s)",
    async ({ claimedAt, sends }) => {
      // المهلة هي ما يفرز بين صف ما زال إرساله جارياً (لا مزاعم ثانية) وصف
      // عالق أهمله مُرسِل مات — الثاني يُستعاد ويُرسَل.
      seedNotification({ dispatch_claimed_at: claimedAt });
      const provider = vi.mocked(globalThis.fetch);
      provider.mockImplementation(async () => acceptedByProvider());

      const row = await dispatchNotificationRecord(NOTIFICATION_ID, { companyId: COMPANY_ID });

      expect(provider).toHaveBeenCalledTimes(sends);
      expect(row.state).toBe(sends ? "sent" : "queued");
    },
  );
});

describe("a throw after the claim records a real failed attempt (GR-004)", () => {
  test("the row goes back to failed with retry_count + 1 and the error message", async () => {
    // خطأ بعد الحجز (هنا: قراءة إعدادات المزوّدين) لا يترك الصف طابوراً بلا
    // سبب فشل — يُعاد إلى `failed` بالمحاولة المحسوبة، ثم يُرمى الخطأ.
    seedNotification({ state: "failed", retry_count: 2 });
    tableErrors.set("provider_configs", "provider configs exploded");
    const provider = vi.mocked(globalThis.fetch);

    await expect(retryFailedNotificationRecord(NOTIFICATION_ID, 2, COMPANY_ID)).rejects.toThrow(
      "provider configs exploded",
    );

    expect(provider).not.toHaveBeenCalled();
    expect(rowsOf("notifications")[0]).toMatchObject({
      state: "failed",
      retry_count: 3,
      failure_reason: "provider configs exploded",
      dispatch_claimed_at: null,
    });
  });
});

describe("a lost report re-queue claim is not recorded as a delivery failure (GR-005)", () => {
  test("of two concurrent re-queues only the winner writes the report outcome", async () => {
    // مهمتا تقرير متزامنتان على نفس صف التسليم الفاشل: الفائز يرسل ويسجّل،
    // والخاسر يعود بلا شيء — لا `generated_reports.sent = false` ولا سجل
    // فشل بينما ما زال التقرير في طريقه.
    seedFailedReportDelivery();
    const provider = vi.mocked(globalThis.fetch);
    provider.mockImplementation(async () => acceptedByProvider());

    const [first, second] = await Promise.all([
      resendGeneratedReportRecord(GENERATED_REPORT_ID, COMPANY_ID, JOB_REQUEST_ID),
      resendGeneratedReportRecord(GENERATED_REPORT_ID, COMPANY_ID, JOB_REQUEST_ID),
    ]);

    expect(provider).toHaveBeenCalledTimes(1);
    expect([first, second].filter((row) => row.state === "sent")).toHaveLength(1);
    expect(updatesOf("generated_reports")).toEqual([
      { values: { sent: true, sent_at: expect.any(String) }, matched: 1 },
    ]);
    const audits = rpcCallsOf("write_audit").filter(
      (call) => call.args.p_action === "generated_report.resend",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].args).toMatchObject({ p_result: "success" });
    // الخاسر أعاد صفّه الفاشل كما قرأه، بلا كتابة على الإطلاق.
    const loser = first.state === "sent" ? second : first;
    expect(loser).toMatchObject({ state: "failed", id: NOTIFICATION_ID });
  });
});
