/**
 * نص البريد البديل في SMTP يُبنى بـ stripMarkup: فواصل أسطر وكيانات مفكوكة.
 *
 * The crude `replace(/<[^>]+>/g, " ")` this replaced collapsed every line into
 * one and left `&amp;` in the text part tenants' clients show when HTML is off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const createTransport = vi.fn(() => ({ sendMail }));
vi.mock("nodemailer", () => ({
  default: { createTransport },
}));

const { sendWithSmtp } = await import("@/lib/providers/smtp");
const { DELIVERY_INDETERMINATE, PROVIDER_TIMEOUT_MS } = await import("@/lib/providers/types");

beforeEach(() => {
  sendMail.mockReset().mockResolvedValue({ messageId: "m1" });
  createTransport.mockClear();
  process.env.TEST_SMTP_HOST = "smtp.test";
});

describe("sendWithSmtp text alternative", () => {
  it("keeps line breaks and decodes entities rather than flattening the HTML", async () => {
    await sendWithSmtp({
      config: { host_env: "TEST_SMTP_HOST" },
      from: "no-reply@test",
      to: ["tenant@test"],
      subject: "s",
      body: "<p>Rent &amp; service</p><p>Due: 100 KWD</p>",
    } as never);

    const text = sendMail.mock.calls[0][0].text as string;
    expect(text).toContain("Rent & service");
    expect(text).not.toContain("&amp;");
    expect(text).toMatch(/Rent & service\s*\n+\s*Due: 100 KWD/);
  });
});

describe("sendWithSmtp timeouts", () => {
  it("bounds connect, greeting and idle time instead of nodemailer's 2 and 10 minute defaults", async () => {
    await sendWithSmtp({
      config: { host_env: "TEST_SMTP_HOST" },
      from: "no-reply@test",
      to: ["tenant@test"],
      subject: "s",
      body: "<p>x</p>",
    } as never);

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeout: PROVIDER_TIMEOUT_MS,
        greetingTimeout: PROVIDER_TIMEOUT_MS,
        socketTimeout: PROVIDER_TIMEOUT_MS * 3,
      }),
    );
  });
});

describe("sendWithSmtp Message-ID", () => {
  it.each([
    { from: "Danat <no-reply@danat-future.com>", key: "n-1", expected: "<n-1@danat-future.com>" },
    { from: "no-reply@danat-future.com", key: "n-1", expected: "<n-1@danat-future.com>" },
    { from: "no-reply@danat-future.com", key: undefined, expected: undefined },
    { from: "Danat", key: "n-1", expected: undefined },
  ])(
    "derives a retry-stable Message-ID from the key and sender ($from, $key)",
    async ({ from, key, expected }) => {
      // SMTP has no idempotency key; a retry that repeats the Message-ID lets
      // the recipient's mail store collapse the duplicate copy.
      await sendWithSmtp({
        config: { host_env: "TEST_SMTP_HOST" },
        from,
        to: ["tenant@test"],
        subject: "s",
        body: "<p>x</p>",
        idempotencyKey: key,
      } as never);

      expect(sendMail.mock.calls[0][0].messageId).toBe(expected);
    },
  );
});

describe("sendWithSmtp ambiguous timeouts", () => {
  /** يبني خطأ nodemailer بالكود والرسالة كما يرميهما عند انتهاء المهلة. */
  function smtpError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
  }

  it.each([
    { error: smtpError("Timeout", "ETIMEDOUT"), parked: true },
    { error: smtpError("Connection timeout", "ETIMEDOUT"), parked: false },
    { error: smtpError("Greeting never received", "ETIMEDOUT"), parked: false },
    { error: smtpError("connect ECONNREFUSED", "ESOCKET"), parked: false },
  ])(
    "parks only a timeout that may follow acceptance ($error.message)",
    async ({ error, parked }) => {
      // A socket-idle timeout can fire after the server accepted the message;
      // retrying it could deliver twice. Pre-send failures stay retryable.
      sendMail.mockRejectedValue(error);

      const failure = await sendWithSmtp({
        config: { host_env: "TEST_SMTP_HOST" },
        from: "no-reply@test",
        to: ["tenant@test"],
        subject: "s",
        body: "<p>x</p>",
      } as never).catch((caught: unknown) => caught);

      if (parked) expect(failure).toMatchObject({ code: DELIVERY_INDETERMINATE });
      else expect(failure).toBe(error);
    },
  );
});
