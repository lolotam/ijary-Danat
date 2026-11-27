import { vi } from "vitest";

/**
 * عدّة اختبار إعادة تعيين كلمة المرور: حدود Supabase وGoTrue الوهمية، وحالة
 * الحسابات والرموز.
 *
 * Only system boundaries are faked here: the Supabase client (its `profiles`,
 * `password_reset_tokens`, `notifications` and `notification_templates` reads
 * stand for what RLS lets one company's client see), the GoTrue admin call
 * that sets the password, and the audit writer that carries the sign-in
 * throttle. The token minting, the digest, the expiry rules and the flag
 * clearing are the real code.
 *
 * The `.testkit.ts` suffix keeps this out of the vitest include glob.
 */

/** حساب مستخدم داخل شركة واحدة. */
export interface ProfileRow {
  id: string;
  company_id: string;
  email: string | null;
  display_name: string | null;
  username: string | null;
  phone: string | null;
  is_active: boolean;
  preferred_locale: "ar" | "en";
  tenant_id: string | null;
  must_change_password: boolean;
}

/** رمز إعادة تعيين مخزَّن (بصمة فقط، لا رمز صريح). */
export interface TokenRow {
  id: string;
  company_id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

/** صف إشعار كما تكتبه `enqueueNotification`. */
export interface NotificationRow {
  id: string;
  company_id: string;
  body: string | null;
  subject: string | null;
  recipient_address: string | null;
  template_code: string | null;
  payload: unknown;
  type: string;
  state: string;
}

/** صف قالب رسالة كما تقرأه `loadTemplateCopy`. */
export interface TemplateRow {
  id: string;
  company_id: string;
  code: string;
  is_active: boolean;
  subject_ar: string | null;
  subject_en: string | null;
  body_ar: string | null;
  body_en: string | null;
  channel: string;
}

/** شركة الطلب: المُضيف الذي يجري الطلب منه. */
export const RESET_COMPANY = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "danat",
  status: "active" as const,
  host: "danat.localhost",
};

/** الشركة الأخرى: الرمز الذي يصدر منها لا يعمل على مضيف الطلب. */
export const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";

/** حساب داخل شركة الطلب. */
export const RESET_USER = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "owner@example.test",
};

/** الحالة التي تراها حدود النظام. */
export const resetState = {
  profiles: [] as ProfileRow[],
  tokens: [] as TokenRow[],
  notifications: [] as NotificationRow[],
  templates: [] as TemplateRow[],
  jobs: [] as Array<{ kind: string; payload: unknown; dedupe_key: string | null }>,
  audits: [] as Array<{ action: string; entity_id: string | null; result: string | null }>,
};

/** الوظائف الوهمية عند الحدود. */
export const resetBoundary = {
  updateAuthUserById: vi.fn(),
  recordFailedLoginAttempt: vi.fn(),
};

/** معرّف الاعتماد على جدول ما داخل العميل الوهمي. */
type Row = Record<string, unknown>;

/** شرط مُجمَّع على صف. */
interface Filter {
  op: "eq" | "neq" | "is" | "gt";
  column: string;
  value: unknown;
}

/**
 * يطابق صفاً مع شرط واحد.
 */
function matches(row: Row, filter: Filter): boolean {
  const actual = row[filter.column];
  switch (filter.op) {
    case "eq":
      return actual === filter.value;
    case "neq":
      return actual !== filter.value;
    case "is":
      return actual === filter.value;
    case "gt":
      return typeof actual === "string" && actual > String(filter.value);
    default:
      return true;
  }
}

/**
 * صفوف الجدول كما هي في الحالة، قبل تقييدها بالشركة.
 */
function rawRows(table: string): Row[] {
  switch (table) {
    case "profiles":
      return resetState.profiles as unknown as Row[];
    case "password_reset_tokens":
      return resetState.tokens as unknown as Row[];
    case "notifications":
      return resetState.notifications as unknown as Row[];
    case "notification_templates":
      return resetState.templates as unknown as Row[];
    default:
      return [];
  }
}

/**
 * صفوف الجدول كما يراها عميل الشركة: صف شركة أخرى غير مرئي، كما تنص RLS.
 */
function rowsFor(table: string, companyId: string): Row[] {
  return rawRows(table).filter((row) => row.company_id === companyId);
}

/**
 * يبني مستعلاماً وهمياً على جدول، ويحلّ نفسه إلى `{ data, error }` كما يفعل
 * عميل Supabase.
 */
function fakeTable(table: string, companyId: string) {
  const filters: Filter[] = [];
  let mode: "select" | "insert" | "update" = "select";
  let payload: Row = {};
  let limit = 0;
  let wantsRows = false;
  let wantsCount = false;
  let headOnly = false;

  /**
   * الصفوف التي يطابقها الاستعلام.
   */
  function affectedRows(): Row[] {
    const rows = rowsFor(table, companyId).filter((row) =>
      filters.every((filter) => matches(row, filter)),
    );
    return limit > 0 ? rows.slice(0, limit) : rows;
  }

  /**
   * ينفّذ الكتابة: الإدراج يضيف صفاً، والتحديث يعدّل الصفوف المطابقة.
   */
  function writeResult(): Row[] {
    if (mode === "insert") {
      const defaults =
        table === "password_reset_tokens" ? { created_at: new Date().toISOString() } : {};
      const row: Row = { id: crypto.randomUUID(), ...defaults, ...payload };
      rawRows(table).push(row);
      return [row];
    }
    const rows = affectedRows();
    for (const row of rows) Object.assign(row, payload);
    return rows;
  }

  /**
   * نتيجة الاستعلام كما يعيدها PostgREST.
   */
  function result(): { data: unknown; count?: number; error: { message: string } | null } {
    if (mode === "select") {
      const rows = affectedRows();
      return {
        data: headOnly ? null : rows,
        ...(wantsCount ? { count: rows.length } : {}),
        error: null,
      };
    }
    const written = writeResult();
    return { data: wantsRows ? written : null, error: null };
  }

  const builder = {
    select: (_columns?: string, options?: { count?: "exact"; head?: boolean }) => {
      wantsRows = true;
      wantsCount = options?.count === "exact";
      headOnly = Boolean(options?.head);
      return builder;
    },
    insert: (row: Row) => {
      mode = "insert";
      payload = row;
      return builder;
    },
    update: (row: Row) => {
      mode = "update";
      payload = row;
      return builder;
    },
    eq: (column: string, value: unknown) => {
      filters.push({ op: "eq", column, value });
      return builder;
    },
    neq: (column: string, value: unknown) => {
      filters.push({ op: "neq", column, value });
      return builder;
    },
    is: (column: string, value: unknown) => {
      filters.push({ op: "is", column, value });
      return builder;
    },
    gt: (column: string, value: unknown) => {
      filters.push({ op: "gt", column, value });
      return builder;
    },
    limit: (count: number) => {
      limit = count;
      return builder;
    },
    single: () => {
      const rows = writeOrSelect();
      if (rows.length !== 1) {
        return Promise.resolve({ data: null, error: { message: "exactly one row is required" } });
      }
      return Promise.resolve({ data: rows[0], error: null });
    },
    maybeSingle: () => {
      const rows = writeOrSelect();
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    },
    then: (
      resolve: (value: { data: unknown; error: { message: string } | null }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(result()).then(resolve, reject),
  };

  /**
   * الصفوف التي يعيدها الاستعلام، ويكتب أولَها إن كان الاستعلام كتابة.
   */
  function writeOrSelect(): Row[] {
    if (mode === "select") return affectedRows();
    return writeResult();
  }

  return builder;
}

/**
 * عميل Supabase وهمي مقيّد بشركة واحدة.
 */
function fakeClient(companyId: string) {
  return {
    from: (table: string) => fakeTable(table, companyId),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "find_profiles_by_phone_digits") {
        const digits = String(args._digits ?? "");
        const rows = resetState.profiles
          .filter((profile) => profile.company_id === companyId)
          .filter((profile) => {
            const phone = profile.phone?.replace(/\D/g, "") ?? "";
            return phone.length >= 8 && phone.endsWith(digits.slice(-8));
          })
          .map((profile) => ({ id: profile.id, email: profile.email }));
        return { data: rows, error: null };
      }
      if (name === "enqueue_job") {
        resetState.jobs.push({
          kind: String(args._kind),
          payload: args._payload,
          dedupe_key: (args._dedupe_key as string | null) ?? null,
        });
        return { data: crypto.randomUUID(), error: null };
      }
      if (name === "write_audit") {
        resetState.audits.push({
          action: String(args.p_action),
          entity_id: (args.p_entity_id as string | null) ?? null,
          result: (args.p_result as string | null) ?? null,
        });
        return { data: crypto.randomUUID(), error: null };
      }
      return { data: null, error: { message: `unknown rpc ${name}` } };
    },
  };
}

/**
 * مصنع `vi.mock("@tanstack/react-start", …)`.
 *
 * Every `createServerFn` call gets its own holder, because one module may
 * export more than one server function — this one exports the reset request,
 * the reset confirmation and the forced change.
 */
export function serverFnModule() {
  return {
    createServerFn: () => {
      const fn = Object.assign((data: unknown) => fn.handler({ data, context: fn.context }), {
        context: null as unknown,
        handler: null as unknown as (input: {
          data: unknown;
          context: unknown;
        }) => Promise<unknown>,
      });
      // The chain mirrors the real builder: `middleware`, `inputValidator`
      // and `handler` can be chained in any order, and the validator runs on
      // the input before the handler sees it.
      const chain = (validator?: (data: unknown) => unknown) => ({
        middleware: () => chain(validator),
        inputValidator: (next: (data: unknown) => unknown) => chain(next),
        validator: (next: (data: unknown) => unknown) => chain(next),
        handler: (handler: typeof fn.handler) => {
          fn.handler = validator
            ? async (input: { data: unknown; context: unknown }) =>
                handler({ ...input, data: validator(input.data) })
            : handler;
          return fn;
        },
      });
      return chain();
    },
    createMiddleware: () => ({ server: (handler: unknown) => handler }),
  };
}

/**
 * مصنع `vi.mock("@/company/companyClient.server", …)`.
 */
export function companyClientModule() {
  return { companyClient: (companyId: string) => fakeClient(companyId) };
}

/**
 * مصنع `vi.mock("@/company/requestCompany.server", …)`.
 */
export function requestCompanyModule() {
  return { requireRequestCompany: () => RESET_COMPANY };
}

/**
 * مصنع `vi.mock("@/platform/authAdmin.server", …)`.
 */
export function authAdminModule() {
  return { updateAuthUserById: resetBoundary.updateAuthUserById };
}

/**
 * مصنع `vi.mock("@/fns/loginAudit", …)`.
 *
 * The audit writer reaches Postgres through its own service-role client; it is
 * the boundary that carries the sign-in throttle, so it is the one piece the
 * test replaces to observe the request joining that ladder.
 */
export function loginAuditModule() {
  return { recordFailedLoginAttempt: resetBoundary.recordFailedLoginAttempt };
}

/**
 * يعيد الحدود والحالة إلى وضع افتراضي واحد: حساب نشط بلا كلمة مرور مؤقتة.
 */
export function resetFixtures() {
  resetState.profiles = [
    {
      id: RESET_USER.id,
      company_id: RESET_COMPANY.id,
      email: RESET_USER.email,
      display_name: "Waleed",
      username: "waleed",
      phone: "51234567",
      is_active: true,
      preferred_locale: "en",
      tenant_id: null,
      must_change_password: false,
    },
  ];
  resetState.tokens = [];
  resetState.notifications = [];
  resetState.templates = [];
  resetState.jobs = [];
  resetState.audits = [];
  resetBoundary.updateAuthUserById.mockReset().mockResolvedValue({
    data: { user: {} },
    error: null,
  });
  resetBoundary.recordFailedLoginAttempt.mockReset().mockResolvedValue(undefined);
}
