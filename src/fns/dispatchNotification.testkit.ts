import { vi } from "vitest";

/**
 * عدّة اختبار مشتركة لمُرسل الإشعارات: قاعدة بيانات وهمية موجَّهة بالجدول،
 * ثوابت المزوّدين، ومساعدات القراءة — تتقاسمها ملفات اختبار المُرسل.
 *
 * Only the database boundary is faked; the provider modules and the HTTP call
 * they make are exercised for real against a stubbed global fetch, so "which
 * provider was selected" is observed from the outbound request rather than
 * asserted on a mock. Lives beside the tests it serves; the `.testkit.ts`
 * suffix keeps it out of the vitest include glob.
 */

export const db = {
  notification: {} as Record<string, unknown>,
  providers: [] as Record<string, unknown>[],
  template: null as Record<string, unknown> | null,
  tenant: null as Record<string, unknown> | null,
  update: null as Record<string, unknown> | null,
  /** evolution_connections singleton row (null = never paired). */
  connection: null as Record<string, unknown> | null,
  /** Attachment bytes served by the storage fake, keyed by object path. */
  attachments: {} as Record<string, { bytes: Uint8Array; type: string }>,
  /** Object paths written by the storage fake, in order. */
  uploads: [] as string[],
  /** evolution_connections updates, in order. */
  connectionUpdates: [] as Record<string, unknown>[],
};

/** Factory for `vi.mock("@tanstack/react-start", …)`. */
export function tanstackStartModule() {
  const fn: any = (data: any) => fn._handler({ data, context: fn._context });
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.inputValidator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((h: any) => {
    fn._handler = h;
    return fn;
  });
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middlewareFn: any) => middlewareFn),
    }),
  };
}

export const TEST_COMPANY = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "danat",
  status: "active" as const,
};

/** مصنع `vi.mock("@/company/requestCompany.server", …)` لاختبارات المُرسل. */
export function requestCompanyModule() {
  return {
    getRequestCompany: () => TEST_COMPANY,
    requireRequestCompany: () => TEST_COMPANY,
    runWithRequestCompany: async (_company: unknown, fn: () => unknown) => fn(),
  };
}

/** مصنع `vi.mock("@/company/companyClient.server", …)` لاختبارات المُرسل. */
export function companyClientModule() {
  function builder(table: string) {
    const chain: any = {
      _update: null,
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      // Pass-through like `eq`: the claim's lease condition
      // (`dispatch_claimed_at is null or … expired`) is exercised for real in
      // `notificationDispatchLease.test.ts`; here the claim always wins.
      or: () => chain,
      update(values: Record<string, unknown>) {
        chain._update = values;
        return chain;
      },
      single: () => Promise.resolve(chain._resolve()),
      maybeSingle: () => Promise.resolve(chain._resolve()),
      then: (onFulfilled: (value: unknown) => unknown) =>
        Promise.resolve(chain._resolve()).then(onFulfilled),
      _resolve() {
        if (table === "notifications") {
          if (chain._update) {
            db.update = chain._update;
            return { data: { ...db.notification, ...chain._update }, error: null };
          }
          return { data: db.notification, error: null };
        }
        if (table === "tenants") return { data: db.tenant, error: null };
        if (table === "provider_configs") return { data: db.providers, error: null };
        if (table === "notification_templates") return { data: db.template, error: null };
        // الهوية العامة للشركة (readPublicBranding): صفاً محايداً بالحقائق التي
        // تقرأها، لأن قراءتها ترمي على الخطأ منذ أن صارت تفشل بصوت عالٍ بدل
        // أن تعود بهوية فارغة.
        if (table === "companies") {
          return {
            data: {
              name_ar: "دانة",
              name_en: "Danat",
              brand_primary: null,
              brand_accent: null,
              logo_url: null,
              favicon_url: null,
              portal_bg_url: null,
              email_logo_url: null,
            },
            error: null,
          };
        }
        if (table === "evolution_connections") {
          if (chain._update) db.connectionUpdates.push(chain._update);
          return { data: db.connection, error: null };
        }
        throw new Error(`Unexpected table in test: ${table}`);
      },
    };
    return chain;
  }
  const client = {
    from: (table: string) => builder(table),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    storage: {
      from: () => ({
        download: (path: string) => {
          const file = db.attachments[path];
          if (!file) return Promise.resolve({ data: null, error: { message: "not found" } });
          return Promise.resolve({
            data: {
              type: file.type,
              arrayBuffer: () => Promise.resolve(file.bytes.buffer),
            },
            error: null,
          });
        },
        upload: (path: string) => {
          db.uploads.push(path);
          return Promise.resolve({ data: { path }, error: null });
        },
      }),
    },
  };
  return {
    companyClient: () => client,
    serverCompanyClient: (explicitCompanyId?: string) => ({
      companyId: explicitCompanyId ?? TEST_COMPANY.id,
      client,
    }),
  };
}

export const RESEND = {
  provider: "resend",
  is_enabled: true,
  is_primary: false,
  config: { secret_env: "RESEND_API_KEY" },
  from_email: "billing@danat-future.com",
  from_whatsapp: null,
};
export const SMTP = {
  provider: "smtp",
  is_enabled: true,
  is_primary: false,
  config: { host_env: "SMTP_HOST", secret_env: "SMTP_PASS" },
  from_email: "smtp@danat-future.com",
  from_whatsapp: null,
};
export const CLOUD = {
  provider: "whatsapp_cloud_api",
  is_enabled: true,
  config: { secret_env: "WHATSAPP_ACCESS_TOKEN", phone_number_id_env: "WHATSAPP_PHONE_NUMBER_ID" },
  from_email: null,
  from_whatsapp: "+96522220000",
};
export const TWILIO = {
  provider: "twilio",
  is_enabled: true,
  config: {
    account_sid_env: "TWILIO_ACCOUNT_SID",
    secret_env: "TWILIO_AUTH_TOKEN",
    from_whatsapp_env: "TWILIO_WHATSAPP_FROM",
  },
  from_email: null,
  from_whatsapp: "whatsapp:+14155238886",
};
export const POSTORA = {
  provider: "postora",
  is_enabled: true,
  config: {
    api_base: "https://api.postora.cloud/functions/v1/partner-api",
    api_key_env: "POSTORA_API_KEY",
  },
  from_email: null,
  from_whatsapp: null,
};
export const EVOLUTION = {
  provider: "evolution_api",
  is_enabled: true,
  config: { api_base: "http://evolution:8080", api_key_env: "EVOLUTION_API_KEY" },
  from_email: null,
  from_whatsapp: null,
};

export const MAPPING = {
  allow_freeform: false,
  provider_language_code: null,
  provider_param_keys: ["tenant_name"],
  provider_template_name: "danat_receipt_ar",
  twilio_content_sid: "HXabc",
  twilio_variable_keys: ["tenant_name"],
};

export function notification(overrides: Record<string, unknown> = {}) {
  return {
    id: "n-1",
    audience: "tenant",
    body: "Payment received.",
    channel: "email",
    locale: "ar",
    payload: { tenant_name: "أحمد" },
    provider: null,
    recipient_address: null,
    retry_count: 0,
    sender_address: null,
    state: "queued",
    subject: "Receipt",
    template_code: "receipt-ar",
    tenant_id: "t-1",
    type: "receipt",
    ...overrides,
  };
}

/** URLs the dispatch caused, in order. */
export function requestedUrls() {
  return vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url));
}

/** Fresh fetch stub, provider secrets, and a paired tenant with no providers. */
export function resetDispatchFixtures() {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("RESEND_API_KEY", "re_key");
  vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "meta-token");
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "999");
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "auth-token");
  vi.stubEnv("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886");
  vi.stubEnv("POSTORA_API_KEY", "pk_live_test");
  vi.stubEnv("EVOLUTION_API_KEY", "evo-global-key");

  db.notification = notification();
  db.connection = { instance_name: "danat", last_connection_state: "open" };
  db.attachments = {};
  db.uploads = [];
  db.connectionUpdates = [];
  db.tenant = {
    id: "t-1",
    email: "tenant@example.com",
    mobile: "+96550123456",
    name: "أحمد",
    reminders_enabled: true,
    whatsapp: "+96550123456",
  };
  db.providers = [];
  db.template = MAPPING;
  db.update = null;
}

export function restoreDispatchFixtures() {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
}
