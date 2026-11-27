import { vi } from "vitest";

import { SMTP } from "./dispatchNotification.testkit";

/**
 * مخزن حدودي لمسار بيانات الدخول: جداول وهمية وإدراجات حقيقية الصف.
 *
 * Shared by the credential-boundary tests so `notifyUserCredentials` can run
 * `enqueueNotification` and `dispatchNotificationRecord` for real. Only the
 * database is faked; SMTP is stubbed in the test file at nodemailer.
 */

export interface StoredNotification {
  audience: string;
  body: string | null;
  channel: string;
  failure_reason: string | null;
  id: string;
  locale: string;
  payload: Record<string, unknown>;
  provider: string | null;
  recipient_address: string | null;
  retry_count: number;
  sender_address: string | null;
  state: string;
  subject: string | null;
  template_code: string | null;
  tenant_id: string | null;
  type: string;
}

/**
 * مهمة خلفية سجّلها الصندوق الوهمي عند استدعاء `enqueue_job`.
 *
 * The boundary tests need to see what the request handed to the worker, so
 * the outbox call is recorded rather than answered with a bare stub.
 */
export interface EnqueuedJob {
  dedupeKey: string | null;
  kind: string;
  payload: Record<string, unknown>;
  requestedBy: string | null;
}

interface CredentialBoundaryStore {
  adminProfiles: Array<{ email: string }>;
  adminRoles: Array<{ user_id: string }>;
  company: {
    email: string;
    email_logo_url: string | null;
    favicon_url: string | null;
    logo_url: string | null;
    portal_bg_url: string | null;
  };
  cronJob: { is_active: boolean; recipient_targets: string[] };
  failAdminCopyInsert: boolean;
  /** المهام التي طلبها الصندوق، بالترتيب الذي سُجّلت به. */
  jobs: EnqueuedJob[];
  notifications: StoredNotification[];
  providers: Record<string, unknown>[];
  tenant: {
    email: string;
    id: string;
    mobile: string | null;
    name: string;
    preferred_language: string;
    reminders_enabled: boolean;
    whatsapp: string | null;
  };
}

export const credentialBoundary: CredentialBoundaryStore = emptyStore();

/** يعيد المخزن إلى مستأجر عنوانه يخالف بريد الحساب، ومزوّد SMTP فقط. */
export function resetCredentialBoundary() {
  Object.assign(credentialBoundary, emptyStore());
}

/** مصنع `vi.mock("@/company/companyClient.server")`. */
export function credentialBoundaryCompanyClientModule() {
  const client = {
    from: (table: string) => tableChain(table),
    rpc: vi.fn().mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === "enqueue_job") {
        credentialBoundary.jobs.push({
          dedupeKey: (args?._dedupe_key as string | null) ?? null,
          kind: String(args?._kind),
          payload: (args?._payload as Record<string, unknown> | undefined) ?? {},
          requestedBy: (args?._requested_by as string | null) ?? null,
        });
        return { data: `job-${credentialBoundary.jobs.length}`, error: null };
      }
      return { data: null, error: null };
    }),
    storage: {
      from: () => ({
        download: () => Promise.resolve({ data: null, error: { message: "not found" } }),
        upload: (path: string) => Promise.resolve({ data: { path }, error: null }),
      }),
    },
  };
  return {
    companyClient: () => client,
    serverCompanyClient: (explicitCompanyId?: string) => ({
      companyId: explicitCompanyId ?? "00000000-0000-4000-8000-000000000001",
      client,
    }),
  };
}

/** صف الإشعار بالمعرّف بعد الإدراج والتحديث. */
export function storedNotification(id: string): StoredNotification | undefined {
  return credentialBoundary.notifications.find((row) => row.id === id);
}

/** صف بريد المستأجر، وهو صف التزويد الذي يجب أن يبقى منعزلاً عن الإدارة. */
export function ownerCredentialRow(): StoredNotification | undefined {
  return credentialBoundary.notifications.find(
    (row) => row.audience === "tenant" && row.channel === "email",
  );
}

/** نسخة الإدارة من بيانات الدخول، إن أُدرجت. */
export function adminCredentialCopy(): StoredNotification | undefined {
  return credentialBoundary.notifications.find((row) => row.audience === "admin");
}

/**
 * مهام الإرسال التي سُجّلت لصف إشعار بعينه.
 *
 * The request no longer sends the row — it hands it to the worker — so a test
 * that wants to know whether a row was scheduled reads the outbox here.
 */
export function dispatchJobsFor(notificationId: string | undefined): EnqueuedJob[] {
  if (!notificationId) return [];
  return credentialBoundary.jobs.filter(
    (job) => job.kind === "notification.dispatch" && job.payload.notificationId === notificationId,
  );
}

/** يبدأ المخزن بعنوان مستأجر يخالف بريد الحساب حتى يظهر توسيع المستلمين إن حدث. */
function emptyStore(): CredentialBoundaryStore {
  return {
    adminProfiles: [{ email: "ops@example.test" }],
    adminRoles: [{ user_id: "admin-1" }],
    company: {
      email: "company@example.test",
      email_logo_url: null,
      favicon_url: null,
      logo_url: null,
      portal_bg_url: null,
    },
    cronJob: { is_active: true, recipient_targets: ["admin", "company"] },
    failAdminCopyInsert: false,
    jobs: [],
    notifications: [],
    providers: [SMTP],
    tenant: {
      email: "record@example.test",
      id: "tenant-1",
      mobile: "+96550000000",
      name: "Sara",
      preferred_language: "ar",
      reminders_enabled: true,
      whatsapp: "+96550000000",
    },
  };
}

interface ChainState {
  action: "select" | "insert" | "update";
  filters: Array<{ column: string; value: unknown }>;
  insertRow: Record<string, unknown> | null;
  updateValues: Record<string, unknown> | null;
}

/** يبني سلسلة PostgREST وهمية تحتفظ بالإدراج والتحديث في الحالة لا في الجدول. */
function tableChain(table: string) {
  const state: ChainState = {
    action: "select",
    filters: [],
    insertRow: null,
    updateValues: null,
  };
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self,
    in: self,
    order: self,
    limit: self,
    // Pass-through like `in`: the claim's lease condition is exercised for
    // real in `notificationDispatchLease.test.ts`, where the claim can lose.
    or: self,
    eq(column: string, value: unknown) {
      state.filters.push({ column, value });
      return chain;
    },
    insert(row: Record<string, unknown>) {
      state.action = "insert";
      state.insertRow = row;
      return chain;
    },
    update(values: Record<string, unknown>) {
      state.action = "update";
      state.updateValues = values;
      return chain;
    },
    single: () => Promise.resolve(resolveQuery(table, state)),
    maybeSingle: () => Promise.resolve(resolveQuery(table, state)),
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) =>
      Promise.resolve(resolveList(table)).then(onFulfilled, onRejected),
  });
  return chain;
}

/** القوائم التي تُنتظر بلا maybeSingle: الإعدادات والأدوار والملفات. */
function resolveList(table: string) {
  if (table === "provider_configs") {
    return { data: credentialBoundary.providers, error: null };
  }
  if (table === "user_roles") {
    return { data: credentialBoundary.adminRoles, error: null };
  }
  if (table === "profiles") {
    return { data: credentialBoundary.adminProfiles, error: null };
  }
  throw new Error(`Unexpected list query in credential boundary: ${table}`);
}

/** صف واحد حسب الجدول؛ القوالب تُعاد فارغة ليُستخدم النص المدمج. */
function resolveQuery(table: string, state: ChainState) {
  if (table === "cron_jobs") {
    return { data: credentialBoundary.cronJob, error: null };
  }
  if (table === "companies") {
    return { data: credentialBoundary.company, error: null };
  }
  if (table === "tenants") {
    return { data: credentialBoundary.tenant, error: null };
  }
  if (table === "notification_templates") {
    return { data: null, error: null };
  }
  if (table === "notifications") {
    return resolveNotification(state);
  }
  throw new Error(`Unexpected table in credential boundary: ${table}`);
}

/** يقرأ أو يحدّث صف الإشعار بعد الإدراج، لأن المُرسل يختار بالمعرّف. */
function resolveNotification(state: ChainState) {
  if (state.action === "insert") {
    return insertNotification(state.insertRow ?? {});
  }
  const id = filterValue(state, "id");
  const existing = typeof id === "string" ? storedNotification(id) : undefined;
  if (!existing) {
    return { data: null, error: { message: `notification ${String(id)} not found` } };
  }
  if (state.action === "update") {
    Object.assign(existing, state.updateValues ?? {});
  }
  return { data: existing, error: null };
}

/** يُدرج صف الإشعار أو يرفض نسخة الإدارة عندما يطلب الاختبار ذلك. */
function insertNotification(row: Record<string, unknown>) {
  if (credentialBoundary.failAdminCopyInsert && payloadKind(row) === "tenant_copy") {
    return { data: null, error: { message: "notification insert failed" } };
  }
  const stored: StoredNotification = {
    audience: String(row.audience ?? "tenant"),
    body: (row.body as string | null) ?? null,
    channel: String(row.channel),
    failure_reason: null,
    id: notificationId(credentialBoundary.notifications.length + 1),
    locale: String(row.locale ?? "ar"),
    payload: (row.payload as Record<string, unknown> | undefined) ?? {},
    provider: null,
    recipient_address: (row.recipient_address as string | null) ?? null,
    retry_count: 0,
    sender_address: (row.sender_address as string | null) ?? null,
    state: String(row.state ?? "queued"),
    subject: (row.subject as string | null) ?? null,
    template_code: (row.template_code as string | null) ?? null,
    tenant_id: (row.tenant_id as string | null) ?? null,
    type: String(row.type),
  };
  credentialBoundary.notifications.push(stored);
  return { data: stored, error: null };
}

/** قيمة مُرشِّح عمود، لاختيار صف الإشعار بالمعرّف بعد الإدراج. */
function filterValue(state: ChainState, column: string): unknown {
  return state.filters.find((filter) => filter.column === column)?.value;
}

/**
 * معرّف UUID حقيقي لصف الإشعار.
 *
 * The catalogue's payload schema accepts a uuid only, so a row id like `n-1`
 * cannot travel through `enqueue_job` — the outbox would refuse the very
 * payload the worker needs.
 */
function notificationId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/** نوع الحمولة الذي يميّز نسخة الإدارة عن صف التزويد. */
function payloadKind(row: Record<string, unknown>): string | undefined {
  const payload = row.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const kind = (payload as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}
