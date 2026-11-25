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

/** مصنع `vi.mock("@/integrations/supabase/client.server")`. */
export function credentialBoundarySupabaseModule() {
  return {
    supabaseAdmin: {
      from: (table: string) => tableChain(table),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      storage: {
        from: () => ({
          download: () => Promise.resolve({ data: null, error: { message: "not found" } }),
          upload: (path: string) => Promise.resolve({ data: { path }, error: null }),
        }),
      },
    },
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
    id: `n-${credentialBoundary.notifications.length + 1}`,
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

/** نوع الحمولة الذي يميّز نسخة الإدارة عن صف التزويد. */
function payloadKind(row: Record<string, unknown>): string | undefined {
  const payload = row.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const kind = (payload as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}
