import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationProvider, Tables } from "@/integrations/supabase/database.types";
import { DELIVERY_INDETERMINATE } from "@/lib/providers/types";

import { sendEmailChannel } from "./dispatchEmailChannel";
import type { ChannelInput } from "./notificationChannel";

/**
 * مُرسِل البريد لكل شركة (قصة المستخدم 10).
 *
 * The three cases that matter: a company with no sender of its own sends
 * through the platform's default sender and shows its name and reply address;
 * a company that configured its own sender sends through it; and a failure
 * that may have delivered the message is never sent a second time.
 *
 * Only the database is faked — the provider modules and the HTTP request they
 * make run for real against a stubbed fetch, so "which sender was used" is
 * observed from the outbound request rather than asserted on a mock.
 */

const { db, sendMail, createTransport, fetchMock, COMPANY_ID } = vi.hoisted(() => {
  const companyId = "00000000-0000-4000-8000-000000000001";
  return {
    COMPANY_ID: companyId,
    db: {
      company: {
        id: companyId,
        name_ar: "شركة البيت",
        name_en: "Bayt Real Estate",
        email: "hello@bayt.test",
      },
      providerConfigs: [] as Record<string, unknown>[],
      secrets: [] as Record<string, unknown>[],
      gmailMessages: [] as Record<string, unknown>[],
    },
    sendMail: vi.fn(),
    createTransport: vi.fn(),
    fetchMock: vi.fn(),
  };
});

vi.mock("nodemailer", () => ({
  default: {
    createTransport: (...args: unknown[]) => {
      createTransport(...args);
      return { sendMail };
    },
  },
}));

vi.mock("@/company/companyClient.server", () => {
  function resultFor(table: string, filters: Array<[string, unknown]>) {
    const rows =
      table === "companies"
        ? [db.company]
        : table === "provider_configs"
          ? db.providerConfigs
          : table === "company_secrets"
            ? db.secrets
            : table === "gmail_messages"
              ? db.gmailMessages
              : [];
    return rows.filter((row) => filters.every(([column, value]) => row[column] === value));
  }

  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      upsert: (row: Record<string, unknown>) => {
        db.gmailMessages.push(row);
        return chain;
      },
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

const { encodeByteaHex } = await import("@/gateways/connectionStore.server");
const { encryptSecret } = await import("@/lib/secrets.server");

/**
 * يبني صفّ سرّ مشفّر كما يخزّنه التطبيق في `company_secrets`.
 */
function secretRow(ownerId: string, name: string, plain: string) {
  const encrypted = encryptSecret(plain);
  return {
    owner_kind: "email",
    owner_id: ownerId,
    name,
    version: 1,
    ciphertext: encodeByteaHex(encrypted.ciphertext),
    iv: encodeByteaHex(encrypted.iv),
    auth_tag: encodeByteaHex(encrypted.authTag),
    key_version: encrypted.keyVersion,
  };
}

/** يبني صف مُرسِل شركة كما تقرأه قناة البريد. */
function providerRow(
  overrides: Partial<Tables<"provider_configs">> = {},
): Tables<"provider_configs"> {
  return {
    id: "pc-1",
    company_id: COMPANY_ID,
    provider: "resend",
    is_enabled: true,
    is_primary: true,
    from_email: "billing@bayt.test",
    from_whatsapp: null,
    config: {},
    secrets_version: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * يبني حمولة القناة كما يسلّمها المُرسِل.
 */
function channelInput(overrides: Partial<ChannelInput> = {}): ChannelInput {
  return {
    notification: {
      id: "n-1",
      company_id: COMPANY_ID,
      audience: "tenant",
      body: "<p>Receipt</p>",
      channel: "email",
      locale: "ar",
      payload: {},
      provider: null,
      recipient_address: "tenant@example.com",
      retry_count: 0,
      sender_address: null,
      state: "queued",
      subject: "Receipt",
      template_code: "receipt-ar",
      tenant_id: "t-1",
      type: "receipt",
    } as unknown as Tables<"notifications">,
    tenant: null,
    configs: new Map(),
    attachments: [],
    senderAddress: null,
    ...overrides,
  };
}

/** يقرأ جسم الطلب الذي أُرسل إلى Resend. */
function resendRequest() {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return {
    url,
    init,
    body: JSON.parse(String(init.body)),
    authorization: (init.headers as Record<string, string>).Authorization,
  };
}

describe("email sender per company (US10)", () => {
  beforeEach(() => {
    db.providerConfigs = [];
    db.secrets = [];
    db.gmailMessages = [];
    sendMail.mockReset().mockResolvedValue({ messageId: "smtp-1" });
    createTransport.mockClear();
    fetchMock
      .mockReset()
      .mockResolvedValue(new Response(JSON.stringify({ id: "resend-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("INTEGRATIONS_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("PLATFORM_EMAIL_PROVIDER", "");
    vi.stubEnv("PLATFORM_EMAIL_FROM", "");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("SMTP_PASS", "smtp-pass");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends from the platform sender, showing the company's name and reply address", async () => {
    // No sender of its own: the platform's default sender carries the
    // company's name as the display name and its address as the reply-to.
    vi.stubEnv("PLATFORM_EMAIL_PROVIDER", "resend");
    vi.stubEnv("PLATFORM_EMAIL_FROM", "notifications@ijary.app");
    vi.stubEnv("RESEND_API_KEY", "re_platform_key");

    const outcome = await sendEmailChannel(channelInput());

    const request = resendRequest();
    expect(request.url).toBe("https://api.resend.com/emails");
    expect(request.body.from).toBe('"شركة البيت" <notifications@ijary.app>');
    expect(request.body.reply_to).toBe("hello@bayt.test");
    expect(request.authorization).toBe("Bearer re_platform_key");
    expect(outcome.provider).toBe("resend");
    expect(outcome.senderAddress).toBe('"شركة البيت" <notifications@ijary.app>');
  });

  it("uses the company's own sender before the platform's", async () => {
    // The company stored its own key: it signs the request, and its own
    // sender address is the one the renter sees.
    vi.stubEnv("PLATFORM_EMAIL_PROVIDER", "resend");
    vi.stubEnv("PLATFORM_EMAIL_FROM", "notifications@ijary.app");
    vi.stubEnv("RESEND_API_KEY", "re_platform_key");
    db.secrets = [secretRow("pc-1", "api_key", "re_company_key")];

    const outcome = await sendEmailChannel(
      channelInput({
        configs: new Map<NotificationProvider, Tables<"provider_configs">>([
          ["resend", providerRow({ secrets_version: 1 })],
        ]),
      }),
    );

    const request = resendRequest();
    expect(request.body.from).toBe("billing@bayt.test");
    expect(request.body.reply_to).toBe("hello@bayt.test");
    expect(request.authorization).toBe("Bearer re_company_key");
    expect(outcome.senderAddress).toBe("billing@bayt.test");
  });

  it("does not send the message a second time when the provider may have delivered it", async () => {
    // The default provider stopped answering mid-send: the message may be on
    // its way, so the fallback must stay unused — a second attempt would
    // deliver it twice.
    // The company's own sender carries its own stored password; the
    // platform's SMTP_PASS is never sent to a host the company typed.
    db.secrets = [secretRow("pc-smtp", "password", "company-smtp-password")];
    sendMail.mockRejectedValue(Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" }));

    const smtp = providerRow({
      id: "pc-smtp",
      provider: "smtp",
      is_primary: true,
      from_email: "billing@bayt.test",
      secrets_version: 1,
      config: { host: "smtp.bayt.test", port: "587", user: "mailer@bayt.test" },
    });
    const resend = providerRow({
      id: "pc-resend",
      provider: "resend",
      is_primary: false,
      config: { secret_env: "RESEND_API_KEY" },
    });

    const failure = await sendEmailChannel(
      channelInput({
        configs: new Map<NotificationProvider, Tables<"provider_configs">>([
          ["smtp", smtp],
          ["resend", resend],
        ]),
      }),
    ).catch((error: unknown) => error);

    // The code the drain job reads to park the row for a human instead of
    // sending it again.
    expect(failure).toMatchObject({ code: DELIVERY_INDETERMINATE });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing and says why when neither the company nor the platform has a sender", async () => {
    const outcome = await sendEmailChannel(channelInput());

    expect(outcome.issues).toEqual([{ kind: "skip", message: "No email provider is enabled." }]);
    expect(outcome.provider).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("refuses a company's sender that has no credential at all", async () => {
    // Nothing can authenticate the request, and no retry gives the row a key:
    // the company has to store one, or go back to the platform's sender.
    const failure = await sendEmailChannel(
      channelInput({
        configs: new Map<NotificationProvider, Tables<"provider_configs">>([
          ["resend", providerRow({ config: {} })],
        ]),
      }),
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: "EmailSenderNotConfiguredError" });
    expect((failure as Error).message).toMatch(/no credential/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
