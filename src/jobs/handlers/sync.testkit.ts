/**
 * عدّة اختبار معالجات المزامنة والنسخ: عميل Supabase وهمي يحاكي حدود النظام
 * فقط — الجداول والتخزين ونداءات RPC — مع تطبيق المُرشِّحات التي يعتمد عليها
 * كل معالج (نطاق الشركة، مفتاح المهمة الطبيعي، حالة الجلسة).
 *
 * Nothing internal is mocked: the handlers and the moved work functions run
 * untouched against this boundary — including the real archive build, hashing
 * and manifest reads. Unique constraints are not emulated; the markers under
 * test are the application-level ones (the job-keyed backup row), which is
 * exactly what a second run of the same job must read.
 */

/** صف في جدول وهمي. */
export type SyncFakeRow = Record<string, unknown>;

/** الجداول والتخزين ونداءات RPC وطلبات المهام التي تحاكيها العدّة. */
export interface SyncFake {
  tables: Map<string, SyncFakeRow[]>;
  objects: Map<string, Uint8Array>;
  rpcs: Array<{ name: string; args: Record<string, unknown> }>;
  /** طلبات المهام المسجَّلة عبر `enqueue_job`. */
  jobs: Array<{ id: string; kind: string; payload: Record<string, unknown> }>;
  /** نداءات `backup_restore` المرصودة — الاستعادة التدميرية نفسها. */
  restoreCalls: Array<Record<string, unknown>>;
  /** ما تعيده `has_role` عند إعادة التحقق من صلاحية صاحب الطلب. */
  holdsAdminRole: boolean;
  /** ما تعيده `backup_restore` كتقرير. */
  restoreReport: unknown;
  /** message_id → chat_number: سجلات الرسائل المستوردة، لنمذجة تفرد ingest. */
  ingested: Map<string, string>;
  nextId: number;
}

/** يبني قاعدة وهمية جاهزة لاختبارات المزامنة. */
export function createSyncFake(): SyncFake {
  return {
    tables: new Map(),
    objects: new Map(),
    rpcs: [],
    jobs: [],
    restoreCalls: [],
    holdsAdminRole: true,
    restoreReport: { tables: [], skipped_by_table: {} },
    ingested: new Map(),
    nextId: 0,
  };
}

/** يضبط صفوف جدول واحد في القاعدة الوهمية. */
export function seedSyncTable(fake: SyncFake, table: string, rows: SyncFakeRow[]): void {
  fake.tables.set(table, [...rows]);
}

/** معرّف UUID صالح لمخططات الحمولات، مولَّد من عدّاد. */
export function syncUuid(fake: SyncFake): string {
  fake.nextId += 1;
  return `77777777-7777-4777-8777-${String(fake.nextId).padStart(12, "0")}`;
}

/** شرط واحد على صف. */
type RowPredicate = (row: SyncFakeRow) => boolean;

/**
 * يبني سلسلة استعلام PostgREST مصغّرة: ترشيح وترتيب وإدراج وتحديث.
 *
 * The chain is awaitable like the real builder: awaiting it resolves to
 * `{ data, error }`, and `single()` / `maybeSingle()` resolve with one row or
 * none. Filters compose, and every read is scoped to the client's company the
 * way RLS scopes `companyClient` — rows carrying another company's id are
 * invisible, which is what makes "another company's ids find nothing"
 * observable at this boundary.
 */
function createSyncQuery(fake: SyncFake, table: string, companyId?: string) {
  const predicates: RowPredicate[] = [];
  if (companyId) {
    predicates.push((row) => row.company_id === undefined || row.company_id === companyId);
  }
  let inserted: SyncFakeRow | null = null;
  let upserted: { values: SyncFakeRow[]; onConflict?: string; ignoreDuplicates?: boolean } | null =
    null;
  let updated: SyncFakeRow | null = null;
  let deleted = false;
  let sorted: { column: string; ascending: boolean } | null = null;
  let rowLimit: number | null = null;
  let affected: SyncFakeRow[] | null = null;

  const matched = (): SyncFakeRow[] =>
    (fake.tables.get(table) ?? []).filter((row) => predicates.every((test) => test(row)));

  /** يطبّق الإدراج أو التحديث أو الحذف مرة واحدة، ثم يعيد الصفوف المتأثرة. */
  const materialize = (): SyncFakeRow[] => {
    if (affected) return affected;
    if (upserted) {
      // `ignoreDuplicates` upserts insert the rows whose conflict key is new
      // and return only those — the shape `importContacts` counts.
      const insertedRows: SyncFakeRow[] = [];
      for (const values of upserted.values) {
        const key = upserted.onConflict;
        const exists =
          upserted.ignoreDuplicates &&
          key !== undefined &&
          (fake.tables.get(table) ?? []).some((row) => row[key] === values[key]);
        if (exists) continue;
        const row = { id: syncUuid(fake), created_at: new Date().toISOString(), ...values };
        fake.tables.set(table, [...(fake.tables.get(table) ?? []), row]);
        insertedRows.push(row);
      }
      affected = insertedRows;
    } else if (inserted) {
      const row = { id: syncUuid(fake), created_at: new Date().toISOString(), ...inserted };
      fake.tables.set(table, [...(fake.tables.get(table) ?? []), row]);
      affected = [row];
    } else if (updated) {
      affected = matched();
      for (const row of affected) Object.assign(row, updated);
    } else if (deleted) {
      affected = matched();
      fake.tables.set(
        table,
        (fake.tables.get(table) ?? []).filter((row) => !affected!.includes(row)),
      );
    } else {
      affected = matched();
    }
    return affected;
  };

  const sortedRows = (rows: SyncFakeRow[]): SyncFakeRow[] => {
    const ordered = sorted
      ? [...rows].sort((left, right) => {
          const a = left[sorted!.column];
          const b = right[sorted!.column];
          const order = a === b ? 0 : String(a) > String(b) ? 1 : -1;
          return sorted!.ascending ? order : -order;
        })
      : rows;
    return rowLimit === null ? ordered : ordered.slice(0, rowLimit);
  };

  const chain: Record<string, unknown> = {};
  const addPredicate = (predicate: RowPredicate) => {
    predicates.push(predicate);
    return chain;
  };
  chain.select = () => chain;
  chain.insert = (values: SyncFakeRow) => {
    inserted = values;
    return chain;
  };
  chain.upsert = (
    values: SyncFakeRow[],
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ) => {
    upserted = {
      values,
      onConflict: options?.onConflict,
      ignoreDuplicates: options?.ignoreDuplicates,
    };
    return chain;
  };
  chain.update = (values: SyncFakeRow) => {
    updated = values;
    return chain;
  };
  chain.delete = () => {
    deleted = true;
    return chain;
  };
  chain.eq = (column: string, value: unknown) => addPredicate((row) => row[column] === value);
  chain.neq = (column: string, value: unknown) => addPredicate((row) => row[column] !== value);
  chain.in = (column: string, values: readonly unknown[]) =>
    addPredicate((row) => values.includes(row[column]));
  chain.is = (column: string, value: unknown) => addPredicate((row) => row[column] === value);
  chain.order = (column: string, options?: { ascending?: boolean }) => {
    sorted = { column, ascending: options?.ascending !== false };
    return chain;
  };
  chain.limit = (count: number) => {
    rowLimit = count;
    return chain;
  };
  chain.single = async () => {
    const rows = sortedRows(materialize());
    if (rows.length !== 1) {
      return {
        data: null,
        error: { message: "JSON object requested, multiple (or no) rows returned" },
      };
    }
    return { data: rows[0], error: null };
  };
  chain.maybeSingle = async () => ({ data: sortedRows(materialize())[0] ?? null, error: null });
  chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data: sortedRows(materialize()), error: null }).then(resolve, reject);
  return chain;
}

/** تخزين وهمي: رفع وتنزيل وحذف كائنات. */
function createSyncStorage(fake: SyncFake, bucket: string) {
  return {
    upload: async (path: string, body: unknown) => {
      const bytes =
        body instanceof Uint8Array
          ? body
          : body instanceof ArrayBuffer
            ? new Uint8Array(body)
            : new Uint8Array(Buffer.from(String(body)));
      fake.objects.set(`${bucket}/${path}`, bytes);
      return { data: { path }, error: null };
    },
    download: async (path: string) => {
      const bytes = fake.objects.get(`${bucket}/${path}`);
      if (!bytes) return { data: null, error: { message: "Object not found" } };
      return {
        data: {
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        },
        error: null,
      };
    },
    remove: async (paths: string[]) => {
      for (const path of paths) fake.objects.delete(`${bucket}/${path}`);
      return { data: null, error: null };
    },
  };
}

/** ينفّذ نداء RPC ويسجّله، بردود الأسماء التي تلمسها عمال المزامنة. */
export function runSyncRpc(
  fake: SyncFake,
  name: string,
  args: Record<string, unknown>,
): { data: unknown; error: { message: string } | null } {
  fake.rpcs.push({ name, args });
  switch (name) {
    case "backup_dump_all":
      return {
        data: { format_version: 1, schema_fingerprint: "test-fingerprint", tables: [] },
        error: null,
      };
    case "write_audit":
      return { data: syncUuid(fake), error: null };
    case "has_role":
      return { data: fake.holdsAdminRole, error: null };
    case "has_permission":
      return { data: true, error: null };
    case "record_cron_run":
      return { data: null, error: null };
    case "backup_restore":
      fake.restoreCalls.push(args);
      return { data: fake.restoreReport, error: null };
    case "enqueue_job": {
      const job = {
        id: syncUuid(fake),
        kind: String(args._kind),
        payload: (args._payload ?? {}) as Record<string, unknown>,
      };
      fake.jobs.push(job);
      return { data: job.id, error: null };
    }
    case "ingest_whatsapp_messages": {
      // The real RPC upserts on message_id; modelling that boundary is what
      // makes "a retry imports nothing twice" observable.
      const rows = (args.p_rows ?? []) as Array<{ message_id?: string; chat_number?: string }>;
      let imported = 0;
      for (const row of rows) {
        const messageId = String(row.message_id ?? "");
        if (!messageId || fake.ingested.has(messageId)) continue;
        fake.ingested.set(messageId, String(row.chat_number ?? ""));
        imported += 1;
      }
      return { data: imported, error: null };
    }
    default:
      return { data: null, error: null };
  }
}

/**
 * يبني عميل Supabase وهمياً للشركة: الجداول والتخزين ونداءات RPC.
 *
 * `companyClient` and `serverCompanyClient` both return a client scoped to the
 * company they name: the moved work resolves its own client through the
 * latter, and the handlers through the former.
 */
export function createSyncClient(fake: SyncFake, companyId?: string) {
  return {
    from: (table: string) => createSyncQuery(fake, table, companyId),
    storage: { from: (bucket: string) => createSyncStorage(fake, bucket) },
    rpc: (name: string, args: Record<string, unknown>) => runSyncRpc(fake, name, args),
  };
}

/** مصنع `vi.mock("@/company/companyClient.server", …)` لاختبارات العائلة. */
export function syncCompanyClientModule(fake: SyncFake) {
  return {
    companyClient: (companyId: string) => createSyncClient(fake, companyId),
    serverCompanyClient: (companyId?: string) => ({
      companyId: companyId ?? "11111111-1111-4111-8111-111111111111",
      client: createSyncClient(fake, companyId),
    }),
  };
}

/** مصنع `vi.mock("@/company/requestCompany.server", …)` لاختبارات العائلة. */
export function syncRequestCompanyModule() {
  const company = {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "danat",
    status: "active" as const,
    host: "danat.localhost",
  };
  return {
    getRequestCompany: () => company,
    requireRequestCompany: () => company,
    runWithRequestCompany: async (_company: unknown, run: () => unknown) => run(),
  };
}

/** صفّ اتصال واتساب النشط وصف إعدادات المزوّد لاختبارات مزامنة واتساب. */
export function seedEvolution(fake: SyncFake, companyId: string, connectionId: string): void {
  seedSyncTable(fake, "whatsapp_connections", [
    {
      id: connectionId,
      company_id: companyId,
      method: "evolution_qr",
      is_active: true,
      status: "connected",
      instance_name: "danat",
    },
  ]);
  seedSyncTable(fake, "provider_configs", [
    {
      provider: "evolution_api",
      is_enabled: true,
      config: { api_base: "http://evolution:8080", api_key_env: "EVOLUTION_API_KEY" },
    },
  ]);
}
