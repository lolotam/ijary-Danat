import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-start", async () =>
  (await import("./dispatchNotification.testkit")).tanstackStartModule(),
);
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));
vi.mock("@/company/requestCompany.server", async () =>
  (await import("./dispatchNotification.testkit")).requestCompanyModule(),
);
vi.mock("@/company/companyClient.server", async () =>
  (await import("./dispatchNotification.testkit")).companyClientModule(),
);
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail }) } }));

import { DELIVERY_INDETERMINATE } from "@/lib/providers/types";

import { dispatchNotificationRecord } from "./dispatchNotification";
import {
  db,
  RESEND,
  resetDispatchFixtures,
  restoreDispatchFixtures,
  SMTP,
} from "./dispatchNotification.testkit";

const RESEND_REFUSES = () =>
  new Response(JSON.stringify({ name: "validation_error", message: "domain not verified" }), {
    status: 403,
  });

/** The SMTP error nodemailer raises when the server stops answering mid-send. */
function smtpMidSendTimeout(): Error {
  return Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" });
}

/**
 * Migration 225: SMTP and Resend may both be enabled; `is_primary` picks the
 * default and the other is tried only after a refusal that proves the default
 * did not deliver.
 */
describe("email default and fallback provider", () => {
  beforeEach(() => {
    resetDispatchFixtures();
    vi.stubEnv("SMTP_HOST", "smtp.test");
    vi.stubEnv("SMTP_PASS", "smtp-pass");
    sendMail.mockReset();
    sendMail.mockResolvedValue({ messageId: "smtp-1" });
  });
  afterEach(restoreDispatchFixtures);

  it("sends through SMTP alone when SMTP is the default and succeeds", async () => {
    db.providers = [
      { ...RESEND, is_primary: false },
      { ...SMTP, is_primary: true },
    ];

    const result = await dispatchNotificationRecord("n-1");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.state).toBe("sent");
    expect(result.provider).toBe("smtp");
    expect(result.sender_address).toBe(SMTP.from_email);
  });

  it("falls back to SMTP when the default Resend refuses the send", async () => {
    db.providers = [
      { ...RESEND, is_primary: true },
      { ...SMTP, is_primary: false },
    ];
    vi.mocked(globalThis.fetch).mockResolvedValue(RESEND_REFUSES());

    const result = await dispatchNotificationRecord("n-1");

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(result.state).toBe("sent");
    expect(result.provider).toBe("smtp");
    expect(result.provider_message_id).toBe("smtp-1");
    expect(result.sender_address).toBe(SMTP.from_email);
    expect(result.failure_reason).toMatch(/resend: .*domain not verified.*smtp fallback/);
  });

  it("does not fall back when the default Resend times out, since it may have delivered", async () => {
    db.providers = [
      { ...RESEND, is_primary: true },
      { ...SMTP, is_primary: false },
    ];
    vi.mocked(globalThis.fetch).mockRejectedValue(
      new DOMException("The operation timed out.", "TimeoutError"),
    );

    const result = await dispatchNotificationRecord("n-1");

    expect(sendMail).not.toHaveBeenCalled();
    expect(result.state).toBe("failed");
  });

  it("does not fall back when the default SMTP stops answering mid-send", async () => {
    db.providers = [
      { ...RESEND, is_primary: false },
      { ...SMTP, is_primary: true },
    ];
    sendMail.mockRejectedValue(smtpMidSendTimeout());

    const result = await dispatchNotificationRecord("n-1");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.state).toBe("failed");
    expect(result.error_code).toBe(DELIVERY_INDETERMINATE);
  });

  it("names both providers and keeps the fallback's code when both fail", async () => {
    db.providers = [
      { ...RESEND, is_primary: true },
      { ...SMTP, is_primary: false },
    ];
    vi.mocked(globalThis.fetch).mockResolvedValue(RESEND_REFUSES());
    sendMail.mockRejectedValue(smtpMidSendTimeout());

    const result = await dispatchNotificationRecord("n-1");

    expect(result.state).toBe("failed");
    expect(result.failure_reason).toMatch(/resend: .*domain not verified.*smtp fallback: /);
    expect(result.error_code).toBe(DELIVERY_INDETERMINATE);
  });

  it("falls back when the default has no sender address configured", async () => {
    vi.stubEnv("RESEND_FROM", "");
    db.providers = [
      { ...RESEND, from_email: null, is_primary: true },
      { ...SMTP, is_primary: false },
    ];

    const result = await dispatchNotificationRecord("n-1");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.state).toBe("sent");
    expect(result.provider).toBe("smtp");
  });
});
