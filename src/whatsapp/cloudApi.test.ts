import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeByteaHex } from "@/gateways/connectionStore.server";
import { encryptSecret } from "@/lib/secrets.server";
import {
  CloudApiSendError,
  META_GRAPH_API_VERSION,
  sendCloudApiMessage,
} from "@/whatsapp/cloudApi";

const MASTER_KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const PHONE_NUMBER_ID = "109876543210";
const ACCESS_TOKEN = "EAAG_test_company_access_token";

interface FakeDbOptions {
  connection?: {
    id: string;
    company_id: string;
    method: "cloud_api" | "cloud_coexistence";
    status: string;
    phone_number_id: string | null;
    waba_id: string | null;
  } | null;
  accessToken?: string | null;
  latestInboundSentAt?: string | null;
  approvedTemplates?: string[];
}

/** يبني عميل Supabase وهمياً على حدود قاعدة البيانات لصف الاتصال والأسرار والرسائل والقوالب. */
function createFakeSupabaseDb(opts: FakeDbOptions = {}) {
  const connection =
    opts.connection === undefined
      ? {
          id: CONNECTION_ID,
          company_id: COMPANY_ID,
          method: "cloud_api" as const,
          status: "connected",
          phone_number_id: PHONE_NUMBER_ID,
          waba_id: "waba-1",
        }
      : opts.connection;

  const encrypted =
    opts.accessToken === null ? null : encryptSecret(opts.accessToken ?? ACCESS_TOKEN);
  const approvedSet = new Set(opts.approvedTemplates ?? ["danat_receipt_ar"]);

  return {
    from: vi.fn((table: string) => {
      if (table === "whatsapp_connections") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          maybeSingle: async () => ({ data: connection, error: null }),
        };
        return chain;
      }
      if (table === "company_secrets") {
        const row = encrypted
          ? {
              ciphertext: encodeByteaHex(encrypted.ciphertext),
              iv: encodeByteaHex(encrypted.iv),
              auth_tag: encodeByteaHex(encrypted.authTag),
              key_version: encrypted.keyVersion,
            }
          : null;
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({ data: row, error: null }),
        };
        return chain;
      }
      if (table === "whatsapp_messages") {
        const row = opts.latestInboundSentAt ? { sent_at: opts.latestInboundSentAt } : null;
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({ data: row, error: null }),
        };
        return chain;
      }
      if (table === "notification_templates") {
        let requestedName: string | null = null;
        const chain = {
          select: () => chain,
          eq: (_col: string, val: string) => {
            requestedName = val;
            return chain;
          },
          limit: () => chain,
          maybeSingle: async () => ({
            data:
              requestedName && approvedSet.has(requestedName)
                ? { provider_template_name: requestedName }
                : null,
            error: null,
          }),
        };
        return chain;
      }
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
}

describe("WhatsApp Cloud API sender (T165)", () => {
  const fixedNow = new Date("2026-11-27T12:00:00.000Z");

  beforeEach(() => {
    vi.stubEnv("INTEGRATIONS_MASTER_KEY", MASTER_KEY_B64);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends an approved template via the company's active cloud connection", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid.out.1" }] }), { status: 200 }),
    );
    const db = createFakeSupabaseDb({ approvedTemplates: ["danat_receipt_ar"] });

    const result = await sendCloudApiMessage(
      {
        companyId: COMPANY_ID,
        to: "+96550123456",
        template: {
          templateName: "danat_receipt_ar",
          languageCode: "ar",
          params: ["أحمد", "150.000 KWD"],
        },
      },
      { db: db as never, now: () => fixedNow },
    );

    expect(result).toEqual({ messageId: "wamid.out.1", connectionId: CONNECTION_ID });
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      messaging_product: "whatsapp",
      to: "96550123456",
      type: "template",
      template: {
        name: "danat_receipt_ar",
        language: { code: "ar" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "أحمد" },
              { type: "text", text: "150.000 KWD" },
            ],
          },
        ],
      },
    });
  });

  it("allows free-form text inside the 24-hour customer service window", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid.out.2" }] }), { status: 200 }),
    );
    const twoHoursAgo = new Date(fixedNow.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const db = createFakeSupabaseDb({ latestInboundSentAt: twoHoursAgo });

    const result = await sendCloudApiMessage(
      {
        companyId: COMPANY_ID,
        to: "+96550123456",
        text: "شكراً لتواصلك معنا",
      },
      { db: db as never, now: () => fixedNow },
    );

    expect(result.messageId).toBe("wamid.out.2");
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      messaging_product: "whatsapp",
      to: "96550123456",
      type: "text",
      text: { body: "شكراً لتواصلك معنا" },
    });
  });

  it.each([
    {
      name: "no prior inbound message",
      latestInboundSentAt: null,
    },
    {
      name: "inbound message older than 24 hours",
      latestInboundSentAt: new Date(fixedNow.getTime() - 25 * 60 * 60 * 1000).toISOString(),
    },
  ])(
    "refuses free-form text outside the 24-hour window ($name) with non-retryable error",
    async ({ latestInboundSentAt }) => {
      const db = createFakeSupabaseDb({ latestInboundSentAt });

      const promise = sendCloudApiMessage(
        { companyId: COMPANY_ID, to: "+96550123456", text: "مرحبا" },
        { db: db as never, now: () => fixedNow },
      );

      await expect(promise).rejects.toBeInstanceOf(CloudApiSendError);
      await expect(promise).rejects.toMatchObject({
        code: "OUTSIDE_CUSTOMER_WINDOW",
        retryable: false,
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "unapproved template name",
      templateName: "unapproved_custom_template",
    },
    {
      name: "placeholder *_REQUIRED sentinel",
      templateName: "META_TEMPLATE_NAME_REQUIRED",
    },
  ])("refuses $name with a clear non-retryable error", async ({ templateName }) => {
    const db = createFakeSupabaseDb({ approvedTemplates: ["danat_receipt_ar"] });

    const promise = sendCloudApiMessage(
      {
        companyId: COMPANY_ID,
        to: "+96550123456",
        template: { templateName, languageCode: "ar", params: [] },
      },
      { db: db as never, now: () => fixedNow },
    );

    await expect(promise).rejects.toMatchObject({
      code: "TEMPLATE_NOT_APPROVED",
      retryable: false,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "no active cloud connection",
      dbOpts: { connection: null },
      expectedCode: "CLOUD_CONNECTION_NOT_ACTIVE",
    },
    {
      name: "missing access_token secret",
      dbOpts: { accessToken: null },
      expectedCode: "ACCESS_TOKEN_MISSING",
    },
  ])("fails with non-retryable $expectedCode when $name", async ({ dbOpts, expectedCode }) => {
    const db = createFakeSupabaseDb(dbOpts);

    const promise = sendCloudApiMessage(
      {
        companyId: COMPANY_ID,
        to: "+96550123456",
        template: { templateName: "danat_receipt_ar", languageCode: "ar", params: [] },
      },
      { db: db as never, now: () => fixedNow },
    );

    await expect(promise).rejects.toMatchObject({
      code: expectedCode,
      retryable: false,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("surfaces Meta Graph API rejection details", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 132001, message: "Template name does not exist in the translation" },
        }),
        { status: 400 },
      ),
    );
    const db = createFakeSupabaseDb({ approvedTemplates: ["danat_receipt_ar"] });

    await expect(
      sendCloudApiMessage(
        {
          companyId: COMPANY_ID,
          to: "+96550123456",
          template: { templateName: "danat_receipt_ar", languageCode: "ar", params: [] },
        },
        { db: db as never, now: () => fixedNow },
      ),
    ).rejects.toThrow(/\[code 132001\].*Template name does not exist/);
  });
});
