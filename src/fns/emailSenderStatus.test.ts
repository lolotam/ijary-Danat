import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * حالة مُرسِل البريد كما تُعرض في إعدادات الإشعارات (قصة المستخدم 10).
 *
 * The status answers one question — which sender is in use — and it must
 * answer it without ever carrying a credential: it is shown on a screen.
 */

const { db, COMPANY_ID } = vi.hoisted(() => ({
  COMPANY_ID: "00000000-0000-4000-8000-000000000003",
  db: {
    company: {
      id: "00000000-0000-4000-8000-000000000003",
      name_ar: "شركة البيت",
      name_en: "Bayt Real Estate",
      email: "hello@bayt.test",
    },
    providerConfigs: [] as Record<string, unknown>[],
    secrets: [] as Record<string, unknown>[],
  },
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const fn: any = (data: any) => fn._handler({ data, context: fn._context });
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.validator = vi.fn().mockReturnValue(fn);
    fn.handler = vi.fn().mockImplementation((h: any) => {
      fn._handler = h;
      return fn;
    });
    return fn;
  },
  createMiddleware: vi
    .fn()
    .mockReturnValue({ server: vi.fn().mockImplementation((fn: any) => fn) }),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));

vi.mock("@/company/companyClient.server", () => {
  function resultFor(table: string, filters: Array<[string, unknown]>) {
    const rows =
      table === "companies"
        ? [db.company]
        : table === "provider_configs"
          ? db.providerConfigs
          : table === "company_secrets"
            ? db.secrets
            : [];
    return rows.filter((row) => filters.every(([column, value]) => row[column] === value));
  }

  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return chain;
      },
      in: () => chain,
      maybeSingle: () =>
        Promise.resolve({ data: resultFor(table, filters)[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: resultFor(table, filters)[0] ?? null, error: null }),
      then: (onFulfilled: (value: unknown) => unknown) =>
        Promise.resolve({ data: resultFor(table, filters), error: null }).then(onFulfilled),
    };
    return chain;
  }

  const client = { from: (table: string) => builder(table) };
  return {
    companyClient: () => client,
    serverCompanyClient: (companyId?: string) => ({
      companyId: companyId ?? COMPANY_ID,
      client,
    }),
  };
});

const { getEmailSenderStatus } = await import("./emailSender.server");

describe("emailSenderStatus", () => {
  beforeEach(() => {
    db.providerConfigs = [];
    db.secrets = [];
    vi.stubEnv("PLATFORM_EMAIL_PROVIDER", "");
    vi.stubEnv("PLATFORM_EMAIL_FROM", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reports the company's own sender when it configured one", async () => {
    db.providerConfigs = [
      {
        id: "pc-1",
        company_id: COMPANY_ID,
        provider: "resend",
        is_enabled: true,
        is_primary: true,
        from_email: "billing@bayt.test",
        config: {},
        secrets_version: 1,
      },
    ];

    const status = await getEmailSenderStatus(COMPANY_ID, "ar");

    expect(status.mode).toBe("own");
    expect(status.from).toBe("billing@bayt.test");
    expect(status.replyTo).toBe("hello@bayt.test");
  });

  it("reports the platform sender, showing the company's name, when it has none", async () => {
    vi.stubEnv("PLATFORM_EMAIL_PROVIDER", "resend");
    vi.stubEnv("PLATFORM_EMAIL_FROM", "notifications@ijary.app");

    const status = await getEmailSenderStatus(COMPANY_ID, "en");

    expect(status.mode).toBe("platform");
    expect(status.from).toBe('"Bayt Real Estate" <notifications@ijary.app>');
    expect(status.replyTo).toBe("hello@bayt.test");
  });

  it("reports no sender when neither the company nor the platform has one", async () => {
    const status = await getEmailSenderStatus(COMPANY_ID, "ar");

    expect(status.mode).toBe("none");
    expect(status.from).toBeNull();
  });

  it("never carries a credential", async () => {
    db.providerConfigs = [
      {
        id: "pc-1",
        company_id: COMPANY_ID,
        provider: "resend",
        is_enabled: true,
        is_primary: true,
        from_email: "billing@bayt.test",
        config: {},
        secrets_version: 1,
      },
    ];
    db.secrets = [
      {
        owner_kind: "email",
        owner_id: "pc-1",
        name: "api_key",
        version: 1,
        ciphertext: "\\x00",
        iv: "\\x00",
        auth_tag: "\\x00",
        key_version: 1,
      },
    ];

    const status = await getEmailSenderStatus(COMPANY_ID, "ar");

    expect(Object.keys(status).sort()).toEqual(["from", "mode", "replyTo"]);
    expect(JSON.stringify(status)).not.toMatch(/api_key|ciphertext/i);
  });
});
