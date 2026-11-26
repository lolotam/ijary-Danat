import { afterEach, describe, expect, it, vi } from "vitest";

import { parseServerEnv, resetEnvValidationForTest, validateEnv } from "./env.server";

const VALID_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * يبني خريطة متغيرات بيئة صالحة للخادم لاستخدامها كأساس في اختبارات التحقق.
 */
function baseValidEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    SUPABASE_URL: "https://supabase.example.com",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-placeholder",
    SUPABASE_PUBLISHABLE_KEY: "publishable-key-placeholder",
    SUPABASE_JWT_SECRET: "a".repeat(32),
    INTEGRATIONS_MASTER_KEY: VALID_MASTER_KEY,
    REDIS_URL: "redis://localhost:6379",
    PLATFORM_ROOT_HOST: "ijary.app",
    PLATFORM_ADMIN_HOST: "admin.ijary.app",
    CRON_SECRET: "1234567890abcdef",
    ...overrides,
  };
}

describe("parseServerEnv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetEnvValidationForTest();
  });

  it("accepts a valid minimal multi-company server environment", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const parsed = parseServerEnv(baseValidEnv());

    expect(parsed.PLATFORM_ROOT_HOST).toBe("ijary.app");
    expect(parsed.PLATFORM_ADMIN_HOST).toBe("admin.ijary.app");
    expect(parsed.REDIS_URL).toBe("redis://localhost:6379");
    expect(parsed.MYFATOORAH_BASE_URL).toBe("https://api.myfatoorah.com");
  });

  it("treats empty string optional variables as unset", () => {
    const parsed = parseServerEnv(
      baseValidEnv({
        MYFATOORAH_BASE_URL: "",
        APP_BASE_URL: "",
        PLATFORM_EMAIL_PROVIDER: "",
        PLATFORM_EMAIL_FROM: "",
        META_APP_ID: "",
        META_APP_SECRET: "",
        EVOLUTION_API_URL: "",
        EVOLUTION_API_KEY: "",
      }),
    );

    expect(parsed.MYFATOORAH_BASE_URL).toBe("https://api.myfatoorah.com");
    expect(parsed.APP_BASE_URL).toBeUndefined();
    expect(parsed.PLATFORM_EMAIL_PROVIDER).toBeUndefined();
    expect(parsed.META_APP_ID).toBeUndefined();
    expect(parsed.EVOLUTION_API_URL).toBeUndefined();
  });

  it("normalizes SELF_SUPABASE_* aliases including SELF_SUPABASE_JWT_SECRET", () => {
    const parsed = parseServerEnv({
      SELF_SUPABASE_URL: "https://self.supabase.example.com",
      SELF_SUPABASE_SERVICE_ROLE_KEY: "self-service-role",
      SELF_SUPABASE_PUBLISHABLE_KEY: "self-publishable",
      SELF_SUPABASE_JWT_SECRET: "b".repeat(32),
      INTEGRATIONS_MASTER_KEY: VALID_MASTER_KEY,
      REDIS_URL: "rediss://redis.example.com:6380",
      PLATFORM_ROOT_HOST: "localhost:3000",
      PLATFORM_ADMIN_HOST: "admin.localhost:3000",
      CRON_SECRET: "1234567890abcdef",
    });

    expect(parsed.SUPABASE_URL).toBe("https://self.supabase.example.com");
    expect(parsed.SUPABASE_JWT_SECRET).toBe("b".repeat(32));
    expect(parsed.PLATFORM_ROOT_HOST).toBe("localhost:3000");
  });

  it("rejects short SUPABASE_JWT_SECRET", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => parseServerEnv(baseValidEnv({ SUPABASE_JWT_SECRET: "too-short" }))).toThrow(
      /SUPABASE_JWT_SECRET/,
    );
  });

  it.each([
    { label: "empty", value: "" },
    { label: "non-base64", value: "not-base64-at-all!" },
    { label: "16-byte key", value: Buffer.alloc(16, 1).toString("base64") },
    { label: "64-byte key", value: Buffer.alloc(64, 1).toString("base64") },
  ])("rejects invalid INTEGRATIONS_MASTER_KEY ($label)", ({ value }) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => parseServerEnv(baseValidEnv({ INTEGRATIONS_MASTER_KEY: value }))).toThrow(
      /INTEGRATIONS_MASTER_KEY/,
    );
  });

  it.each(["http://localhost:6379", "not-a-url", "redis://"])(
    "rejects invalid REDIS_URL (%s)",
    (value) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() => parseServerEnv(baseValidEnv({ REDIS_URL: value }))).toThrow(/REDIS_URL/);
    },
  );

  it.each(["https://ijary.app", "ijary.app/admin", "*.ijary.app", "bad host", "localhost:99999"])(
    "rejects invalid PLATFORM_ROOT_HOST (%s)",
    (value) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() => parseServerEnv(baseValidEnv({ PLATFORM_ROOT_HOST: value }))).toThrow(
        /PLATFORM_ROOT_HOST/,
      );
    },
  );

  it("rejects identical PLATFORM_ROOT_HOST and PLATFORM_ADMIN_HOST (case-insensitive)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      parseServerEnv(
        baseValidEnv({
          PLATFORM_ROOT_HOST: "ijary.app",
          PLATFORM_ADMIN_HOST: "IJARY.APP",
        }),
      ),
    ).toThrow(/PLATFORM_ADMIN_HOST/);
  });

  it("validates platform default email sender fields and required pairs", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const validResend = parseServerEnv(
      baseValidEnv({
        PLATFORM_EMAIL_PROVIDER: "resend",
        PLATFORM_EMAIL_FROM: "no-reply@ijary.app",
        RESEND_API_KEY: "re_test_123",
        PLATFORM_RESEND_WEBHOOK_SECRET: "whsec_test",
      }),
    );
    expect(validResend.PLATFORM_EMAIL_PROVIDER).toBe("resend");

    expect(() =>
      parseServerEnv(
        baseValidEnv({
          PLATFORM_EMAIL_PROVIDER: "resend",
          PLATFORM_EMAIL_FROM: "no-reply@ijary.app",
        }),
      ),
    ).toThrow(/RESEND_API_KEY/);

    expect(() =>
      parseServerEnv(
        baseValidEnv({
          PLATFORM_EMAIL_PROVIDER: "smtp",
          PLATFORM_EMAIL_FROM: "no-reply@ijary.app",
        }),
      ),
    ).toThrow(/SMTP_HOST/);

    expect(() =>
      parseServerEnv(
        baseValidEnv({
          PLATFORM_EMAIL_PROVIDER: "resend",
          PLATFORM_EMAIL_FROM: "not-an-email",
          RESEND_API_KEY: "re_test_123",
        }),
      ),
    ).toThrow(/PLATFORM_EMAIL_FROM/);
  });

  it("validates Meta app fields and requires secret when app id is set", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const validMeta = parseServerEnv(
      baseValidEnv({
        META_APP_ID: "1234567890",
        META_APP_SECRET: "meta-secret",
        META_EMBEDDED_SIGNUP_CONFIG_ID: "config-123",
        META_WEBHOOK_VERIFY_TOKEN: "verify-token",
        META_GRAPH_API_VERSION: "v23.0",
      }),
    );
    expect(validMeta.META_GRAPH_API_VERSION).toBe("v23.0");

    expect(() => parseServerEnv(baseValidEnv({ META_APP_ID: "1234567890" }))).toThrow(
      /META_APP_SECRET/,
    );

    expect(() =>
      parseServerEnv(
        baseValidEnv({
          META_APP_ID: "1234567890",
          META_APP_SECRET: "meta-secret",
          META_GRAPH_API_VERSION: "23.0",
        }),
      ),
    ).toThrow(/META_GRAPH_API_VERSION/);
  });

  it("validates Evolution server URL and requires EVOLUTION_API_KEY with EVOLUTION_API_URL", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const validEvo = parseServerEnv(
      baseValidEnv({
        EVOLUTION_API_URL: "https://wa.ijary.app",
        EVOLUTION_API_KEY: "evo-global-key",
      }),
    );
    expect(validEvo.EVOLUTION_API_URL).toBe("https://wa.ijary.app");

    expect(() =>
      parseServerEnv(baseValidEnv({ EVOLUTION_API_URL: "https://wa.ijary.app" })),
    ).toThrow(/EVOLUTION_API_KEY/);

    expect(() =>
      parseServerEnv(
        baseValidEnv({
          EVOLUTION_API_URL: "ftp://wa.ijary.app",
          EVOLUTION_API_KEY: "evo-global-key",
        }),
      ),
    ).toThrow(/EVOLUTION_API_URL/);
  });
});

describe("validateEnv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetEnvValidationForTest();
  });

  it("skips validation when VITEST=true or SKIP_ENV_VALIDATION=true", () => {
    vi.stubEnv("VITEST", "true");
    vi.stubEnv("SUPABASE_JWT_SECRET", "");
    expect(() => validateEnv()).not.toThrow();

    resetEnvValidationForTest();
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("SKIP_ENV_VALIDATION", "true");
    expect(() => validateEnv()).not.toThrow();
  });

  it("throws on startup when VITEST is disabled and required variables are missing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("SKIP_ENV_VALIDATION", "false");
    vi.stubEnv("SUPABASE_JWT_SECRET", "");

    expect(() => validateEnv()).toThrow(/Server environment variables are misconfigured/);
  });
});
