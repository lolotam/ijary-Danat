/**
 * عدّة اختبار مشتركة لاختبارات تكرار تنفيذ معالجات المهام: جداول وهمية تحفظ
 * صفوفها بين النداءات، وتخزين وهمي، وسجلّ نداءات RPC.
 *
 * Only the database and the storage are faked — the handlers, the notification
 * sender and the provider HTTP call all run untouched, so "the message went out
 * once" is observed from the outbound request and from the rows the handler
 * wrote. The rows survive between calls on purpose: the whole question is what
 * a second run reads after the first one wrote.
 *
 * Unique constraints are NOT emulated. The markers under test are the
 * application-level ones (the receipt scan, the notification state), and a fake
 * constraint would hide them behind a database error instead of showing which
 * marker did the work.
 *
 * The seed holds one company's rows, so the fake needs no company filter:
 * every query a handler makes returns that company, and a row that names
 * another company would have to be seeded to show up.
 */

/** صف في جدول وهمي: خريطة قيم كما يخزّنها Postgres. */
export type FakeRow = Record<string, unknown>;

/** نتيجة نداء RPC كما يعيدها PostgREST. */
export interface FakeRpcResult {
  data: unknown;
  error: { message: string } | null;
}

/** الجداول والتخزين وسجلّ نداءات RPC التي تحاكيها العدّة. */
interface FakeDatabase {
  tables: Map<string, FakeRow[]>;
  objects: Map<string, { bytes: Uint8Array; type: string }>;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

/** الحالة المشتركة بين عدّة الاختبار وملف الاختبار: نفس النسخة في الاثنين. */
const database: FakeDatabase = {
  tables: new Map(),
  objects: new Map(),
  rpcCalls: [],
};

export const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
export const TENANT_ID = "22222222-2222-4222-8222-222222222222";
export const INVOICE_ID = "33333333-3333-4333-8333-333333333333";
export const PAYMENT_ID = "44444444-4444-4444-8444-444444444444";
export const SCHEDULE_ID = "55555555-5555-4555-8555-555555555555";
export const NOTIFICATION_ID = "66666666-6666-4666-8666-666666666666";

/** التاريخ الذي يُنشئ له التقرير جدولاً زمنياً — تاريخ الحمولة نفسه. */
export const REPORT_DATE = "2026-08-31";

/** الشركة التي تعمل ضمنها كل اختبارات التكرار. */
const TEST_COMPANY = { id: COMPANY_ID, slug: "danat", status: "active" as const };

/** القيم التي يضعها Postgres على صف إشعار لم يذكرها المُدخل. */
const ROW_DEFAULTS: Record<string, FakeRow> = {
  notifications: { state: "queued", retry_count: 0, provider: null, sender_address: null },
};

/** شرط واحد على صف: كل مُرشِّح في السلسلة يُضاف إلى هذه القائمة. */
type RowPredicate = (row: FakeRow) => boolean;

/** عدّاد المعرّفات المولَّدة: كل معرّف جديد يختلف عن سابقه. */
let rowCounter = 0;

/** يبني معرّف UUID للصفوف التي يولّدها العدّة. */
function nextRowId(): string {
  rowCounter += 1;
  return `77777777-7777-4777-8777-${String(rowCounter).padStart(12, "0")}`;
}

/** مقارنة قيم، والمصفوفات تُقارن عنصراً:elementاً لا بالمرجع. */
function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => sameValue(item, right[index]))
    );
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left);
    return (
      leftKeys.length === Object.keys(right).length &&
      leftKeys.every((key) => sameValue((left as FakeRow)[key], (right as FakeRow)[key]))
    );
  }
  return left === right;
}

/** `contains` في PostgREST: كل مفتاح في الإبرة يجب أن يطابق قيمة الصف. */
function containsValue(column: string, needle: Record<string, unknown>): RowPredicate {
  return (row) => {
    const value = row[column];
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.entries(needle).every(([key, expected]) =>
      sameValue((value as FakeRow)[key], expected),
    );
  };
}

/** `not(column, "is", null)` يعني «العمود ليس فارغاً». */
function isNot(column: string, operator: string, value: unknown): RowPredicate {
  if (operator !== "is") return (row) => row[column] !== value;
  return (row) => (value === null ? row[column] !== null : row[column] === null);
}

/**
 * يقارن قيم عمودين للترتيب، كما يفعل Postgres.
 *
 * The values are compared as text: the only column the handlers order by is
 * `created_at`, and a text comparison of two ISO timestamps is the same
 * ordering a timestamp comparison gives.
 */
function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  return String(left) > String(right) ? 1 : -1;
}

/**
 * يكتب صفاً جديداً في جدول ويضع القيم الافتراضية التي يضعها Postgres.
 *
 * The id is generated in UUID shape because the catalogue validates every
 * payload with `z.string().uuid()`.
 */
function insertRow(table: string, values: FakeRow): FakeRow {
  const row: FakeRow = {
    ...(ROW_DEFAULTS[table] ?? {}),
    ...values,
    id: values.id ?? nextRowId(),
    created_at: new Date().toISOString(),
  };
  database.tables.set(table, [...(database.tables.get(table) ?? []), row]);
  return row;
}

/**
 * يعدّل الصفوف المطابقة في مكانها، كما يفعل Postgres.
 *
 * The row objects are updated in place so a reference a caller already holds
 * sees the new values — the notification row is read once and written back by
 * the dispatcher.
 */
function updateRows(rows: FakeRow[], values: FakeRow): FakeRow[] {
  for (const row of rows) Object.assign(row, values);
  return rows;
}

/**
 * يبني سلسلة استعلام PostgREST مصغّرة: ترشّح صفوف جدول أو تضيف إليها أو تعدّلها.
 *
 * The chain is awaitable like the real builder: awaiting it resolves to
 * `{ data, error }`, and `single()` / `maybeSingle()` resolve to the same
 * shape with one row or none.
 */
function createQuery(table: string): any {
  const predicates: RowPredicate[] = [];
  let inserted: FakeRow | null = null;
  let updated: FakeRow | null = null;
  let sorted: { column: string; ascending: boolean } | null = null;
  let rowLimit: number | null = null;
  let affected: FakeRow[] | null = null;

  const matched = (): FakeRow[] =>
    (database.tables.get(table) ?? []).filter((row) => predicates.every((test) => test(row)));

  /** يطبّق الإدراج أو التحديث مرة واحدة، ثم يعيد الصفوف المتأثرة. */
  const materialize = (): FakeRow[] => {
    if (affected) return affected;
    if (inserted) affected = [insertRow(table, inserted)];
    else if (updated) affected = updateRows(matched(), updated);
    else affected = matched();
    return affected;
  };

  /** يرتّب الصفوف ويحدّها كما يفعل `order` و`limit` في PostgREST. */
  const sortedRows = (rows: FakeRow[]): FakeRow[] => {
    const ordered = sorted
      ? [...rows].sort((left, right) => {
          const order = compareValues(left[sorted!.column], right[sorted!.column]);
          return sorted!.ascending ? order : -order;
        })
      : rows;
    return rowLimit === null ? ordered : ordered.slice(0, rowLimit);
  };

  /** يضيف مُرشِّحاً إلى السلسلة ويعيدها، كما تفعل PostgREST. */
  const addPredicate = (predicate: RowPredicate): unknown => {
    predicates.push(predicate);
    return chain;
  };

  const chain: any = {
    select: () => chain,
    insert: (values: FakeRow) => {
      inserted = values;
      return chain;
    },
    update: (values: FakeRow) => {
      updated = values;
      return chain;
    },
    upsert: (values: FakeRow) => {
      inserted = values;
      return chain;
    },
    eq: (column: string, value: unknown) => addPredicate((row) => row[column] === value),
    neq: (column: string, value: unknown) => addPredicate((row) => row[column] !== value),
    in: (column: string, values: readonly unknown[]) =>
      addPredicate((row) => values.includes(row[column])),
    not: (column: string, operator: string, value: unknown) =>
      addPredicate(isNot(column, operator, value)),
    contains: (column: string, needle: Record<string, unknown>) =>
      addPredicate(containsValue(column, needle)),
    order: (column: string, options?: { ascending?: boolean }) => {
      sorted = { column, ascending: options?.ascending !== false };
      return chain;
    },
    limit: (count: number) => {
      rowLimit = count;
      return chain;
    },
    single: async () => {
      const rows = sortedRows(materialize());
      if (rows.length !== 1) {
        return {
          data: null,
          error: { message: "JSON object requested, multiple (or no) rows returned" },
        };
      }
      return { data: rows[0], error: null };
    },
    maybeSingle: async () => ({ data: sortedRows(materialize())[0] ?? null, error: null }),
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve({ data: sortedRows(materialize()), error: null }).then(resolve, reject),
  };
  return chain;
}

/** لقطة التقرير التي يعيدها مولّد التقرير: تاريخ الفترة هو تاريخ الحمولة. */
function reportSnapshot(args: Record<string, unknown>): FakeRow {
  const periodEnd = typeof args.p_as_of === "string" ? args.p_as_of : REPORT_DATE;
  return { period_start: "2026-08-01", period_end: periodEnd, html: "<p>تقرير</p>" };
}

/** نداءات RPC التي لها رد افتراضي؛ ما لم يرد هنا يعيد `null` بلا خطأ. */
const RPC_HANDLERS: Record<string, (args: Record<string, unknown>) => FakeRpcResult> = {
  enqueue_job: () => ({ data: `job-${database.rpcCalls.length}`, error: null }),
  write_audit: () => ({ data: null, error: null }),
  record_cron_run: () => ({ data: null, error: null }),
  build_scheduled_report_html: (args) => ({ data: [reportSnapshot(args)], error: null }),
  build_overdue_contracts_report_html: (args) => ({ data: [reportSnapshot(args)], error: null }),
};

/** ينفّذ نداء RPC ويسجّله، فتصبح نداءات `enqueue_job` قابلة للعدّ. */
function runRpc(name: string, args: Record<string, unknown>): FakeRpcResult {
  database.rpcCalls.push({ name, args });
  const handler = RPC_HANDLERS[name];
  return handler ? handler(args) : { data: null, error: null };
}

/** يحوّل جسماً مخزَّناً إلى بايتات، كما يتوقعه محمّل التخزين. */
function toBytes(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(Buffer.from(String(body)));
}

/**
 * يخزّن كائناً في_bucket التخزين الوهمي.
 *
 * The report handler attaches the stored PDF to its mail, so the object has to
 * be there for the dispatcher's download to succeed — a missing object would
 * only produce a log line about a missing attachment.
 */
export function storeObject(bucket: string, path: string, bytes?: Uint8Array): void {
  database.objects.set(`${bucket}/${path}`, {
    bytes: bytes ?? new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    type: "application/pdf",
  });
}

/** تخزين وهمي: رفع كائن وتنزيله. */
function createStorage(bucket: string) {
  return {
    upload: async (path: string, body: unknown) => {
      storeObject(bucket, path, toBytes(body));
      return { data: { path }, error: null };
    },
    download: async (path: string) => {
      const object = database.objects.get(`${bucket}/${path}`);
      if (!object) return { data: null, error: { message: "Object not found" } };
      return {
        data: { type: object.type, arrayBuffer: async () => object.bytes.buffer },
        error: null,
      };
    },
  };
}

/** عميل Supabase وهمي يخدم الجداول والتخزين ونداءات RPC. */
function createClient() {
  return {
    from: (table: string) => createQuery(table),
    rpc: (name: string, args: Record<string, unknown>) => runRpc(name, args),
    storage: { from: (bucket: string) => createStorage(bucket) },
  };
}

/** مصنع `vi.mock("@/company/companyClient.server", …)`. */
export function companyClientModule() {
  return {
    companyClient: (_companyId: string) => createClient(),
    serverCompanyClient: (companyId?: string) => ({
      companyId: companyId ?? COMPANY_ID,
      client: createClient(),
    }),
  };
}

/** مصنع `vi.mock("@/company/requestCompany.server", …)`. */
export function requestCompanyModule() {
  return {
    getRequestCompany: () => TEST_COMPANY,
    requireRequestCompany: () => TEST_COMPANY,
    runWithRequestCompany: async (_company: unknown, run: () => unknown) => run(),
  };
}

/** صف الشركة: عنوانها هو ما يوجّه تنبيه الإدارة. */
function companyRow(): FakeRow {
  return {
    id: COMPANY_ID,
    slug: "danat",
    status: "active",
    name_ar: "دانة",
    name_en: "Danat",
    email: "company@example.test",
    invoice_footer_ar: "شكراً",
    invoice_footer_en: "Thanks",
  };
}

/** صف المستأجر: بريده ورقم واتساباه يجعلان القاترتين قابلتين للإرسال. */
function tenantRow(): FakeRow {
  return {
    id: TENANT_ID,
    name: "أحمد",
    name_en: "Ahmed",
    email: "tenant@example.test",
    whatsapp: "+96550000000",
    mobile: null,
    preferred_language: "ar",
    reminders_enabled: true,
    notifications_paused: false,
  };
}

/** صف الفاتورة الذي يقرأه مرسل الفاتورة. */
function invoiceRow(): FakeRow {
  return {
    id: INVOICE_ID,
    company_id: COMPANY_ID,
    tenant_id: TENANT_ID,
    unit_id: null,
    contract_id: null,
    code: "INV-1",
    period_month: 8,
    period_year: 2026,
    issue_date: "2026-08-01",
    due_date: "2026-08-10",
    subtotal: 250,
    discount: 0,
    paid: 0,
    total: 250,
  };
}

/** صف الدفعة المؤكَّدة الذي يقرأه مرسل الإيصال. */
function paymentRow(): FakeRow {
  return {
    id: PAYMENT_ID,
    tenant_id: TENANT_ID,
    status: "confirmed",
    amount: "250.000",
    code: "PAY-1",
    reference: "REF-1",
    payment_date: "2026-08-01",
    method: "cash",
  };
}

/** الجدول الزمني الذي يولّد التقرير: مستلموه بريد صالح واحد. */
function scheduleRow(): FakeRow {
  return {
    id: SCHEDULE_ID,
    report_kind: "summary",
    frequency: "weekly",
    locale: "ar",
    name_ar: "تقرير أسبوعي",
    name_en: "Weekly Report",
    recipients: ["owner@example.test"],
  };
}

/**
 * مزوّد البريد الذي يخدمه الاختبار: Resend بمفتاح بيئة وهمي.
 *
 * The secret is read from the environment at send time, so the row alone is
 * not enough — `resetDispatchFixtures` stubs the variable.
 */
function providerConfigRow(): FakeRow {
  return {
    provider: "resend",
    is_enabled: true,
    is_primary: true,
    config: { secret_env: "TEST_RESEND_KEY" },
    from_email: "billing@example.test",
  };
}

/** الجداول التي تبدأ بها كل حالة اختبار، بأصفارها الحقيقية. */
function seedTables(): void {
  const seeded: Record<string, FakeRow[]> = {
    companies: [companyRow()],
    tenants: [tenantRow()],
    invoices: [invoiceRow()],
    invoice_items: [],
    units: [],
    properties: [],
    contracts: [],
    payments: [paymentRow()],
    payment_allocations: [],
    payment_requests: [],
    receipts: [],
    notification_templates: [],
    provider_configs: [providerConfigRow()],
    cron_jobs: [],
    user_roles: [],
    profiles: [],
    gmail_messages: [],
    option_list_items: [],
    evolution_connections: [],
    report_schedules: [scheduleRow()],
    generated_reports: [],
    notifications: [],
  };
  database.tables = new Map(Object.entries(seeded));
}

/** يصفّر العدّة ويزرع جداولها من جديد. */
export function resetDatabase(): void {
  rowCounter = 0;
  database.objects.clear();
  database.rpcCalls.length = 0;
  seedTables();
}

/** صفوف جدول كما هي الآن. */
export function rowsOf(table: string): FakeRow[] {
  return database.tables.get(table) ?? [];
}

/** نداءات `enqueue_job`: مهمةDispatch واحدة لكل صف إشعار. */
export function enqueuedJobCalls(): Array<Record<string, unknown>> {
  return database.rpcCalls.filter((call) => call.name === "enqueue_job").map((call) => call.args);
}

/**
 * يزرع صف إشعار جاهز للإرسال، كما يخزّنه المرسِل.
 *
 * The row is the marker the `notification.dispatch` handler relies on: its
 * state is what a second run reads before deciding to send again.
 */
export function seedNotification(overrides: FakeRow = {}): FakeRow {
  const row: FakeRow = {
    id: NOTIFICATION_ID,
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
    template_code: "receipt",
    tenant_id: TENANT_ID,
    type: "receipt",
    created_at: new Date().toISOString(),
    ...overrides,
  };
  database.tables.set("notifications", [row]);
  return row;
}
