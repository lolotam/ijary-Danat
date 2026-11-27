/**
 * إعداد المزوّد قابل للكتابة من مدير الشركة، فلا يجوز أن يسحب أسرار بيئة المنصة إلى خادم تختاره الشركة.
 *
 * Regression for the 2026-11-27 review finding: `provider_configs.config` is
 * writable by a company admin (policy `provider_configs_admin_all`), and the
 * send path used to resolve any `*_env` name and send the value to any host
 * the config named.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const createTransport = vi.fn(() => ({ sendMail }));
vi.mock("nodemailer", () => ({
  default: { createTransport },
}));

const { sendWithSmtp } = await import("@/lib/providers/smtp");
const { resolveEvolutionCredentials } = await import("@/lib/providers/evolution");
const { DECRYPTED_SECRET_KEY, providerSecret, requiredEnv } = await import("@/lib/providers/types");

const message = (config: Record<string, unknown>) =>
  ({
    config,
    from: "no-reply@test",
    to: ["tenant@test"],
    subject: "s",
    body: "<p>hi</p>",
  }) as never;

beforeEach(() => {
  sendMail.mockReset().mockResolvedValue({ messageId: "m1" });
  createTransport.mockClear();
  vi.stubEnv("SMTP_HOST", "smtp.platform.test");
  vi.stubEnv("SMTP_PASS", "platform-smtp-pass");
  vi.stubEnv("EVOLUTION_API_KEY", "platform-evolution-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider config cannot reach platform secrets", () => {
  it.each(["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_JWT_SECRET", "INTEGRATIONS_MASTER_KEY"])(
    "refuses an env reference to %s",
    (envName) => {
      expect(() => requiredEnv({ secret_env: envName }, "secret_env")).toThrow(/not allowed/);
      expect(() => providerSecret({ secret_env: envName })).toThrow(/not allowed/);
    },
  );

  it("never sends the platform SMTP password to a host the company typed", async () => {
    await expect(
      sendWithSmtp(message({ host: "evil.example", secret_env: "SMTP_PASS" })),
    ).rejects.toThrow(/platform's own endpoint/);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("sends a company host with the company's own decrypted password", async () => {
    await sendWithSmtp(
      message({
        host: "smtp.company.test",
        user: "mailer@company.test",
        [DECRYPTED_SECRET_KEY]: "own-pass",
      }),
    );
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.company.test",
        auth: expect.objectContaining({ pass: "own-pass" }),
      }),
    );
  });

  it("never sends the platform Evolution key to another base URL", () => {
    expect(() =>
      resolveEvolutionCredentials({
        api_base: "https://evil.example",
        api_key_env: "EVOLUTION_API_KEY",
      }),
    ).toThrow(/platform's own endpoint/);
    expect(
      resolveEvolutionCredentials({
        api_base: "http://evolution:8080/",
        api_key_env: "EVOLUTION_API_KEY",
      }),
    ).toEqual({ apiBase: "http://evolution:8080/", apiKey: "platform-evolution-key" });
  });
});
