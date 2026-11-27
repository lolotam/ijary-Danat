import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  handleMetaWebhookGet,
  handleMetaWebhookPost,
  verifyMetaSignature,
  type ActiveMetaConnection,
  type MetaWebhookDeps,
} from "@/whatsapp/routing";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const CONNECTION_A = "22222222-2222-4222-8222-222222222222";
const PHONE_NUMBER_ID_A = "109876543210";
const APP_SECRET_A = "meta_app_secret_company_a";
const VERIFY_TOKEN = "ijary_meta_verify_token";

/** يحسب توقيع X-Hub-Signature-256 الصحيح لجسم الطلب باستخدام سر التطبيق. */
function signMetaBody(rawBody: string, secret: string): string {
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${digest}`;
}

/** يبني طلب POST وارد من Meta Cloud API مع ترويسة التوقيع الاختيارية. */
function makeMetaPostRequest(body: unknown, signature?: string): Request {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== undefined) {
    headers["x-hub-signature-256"] = signature;
  }
  return new Request("https://ijary.app/api/public/webhooks/meta", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

/** يبني حمولة Meta القياسية لرسالة واردة على معرف رقم هاتف محدد. */
function makeInboundMessagePayload(phoneNumberId: string, messageId = "wamid.inbound.1") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "96550123456",
                phone_number_id: phoneNumberId,
              },
              contacts: [{ profile: { name: "Ahmed" }, wa_id: "96550999888" }],
              messages: [
                {
                  from: "96550999888",
                  id: messageId,
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: "مرحبا" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** يبني عميل Supabase وهمي يلتقط الصفوف المدرجة في جداول واتساب للتحقق من العزل. */
function createFakeCompanyDb() {
  const upserts: Array<{ table: string; rows: unknown }> = [];
  const db = {
    from: vi.fn((table: string) => ({
      upsert: vi.fn(async (rows: unknown) => {
        upserts.push({ table, rows });
        return { data: null, error: null };
      }),
    })),
  };
  return { db, upserts };
}

describe("Meta Cloud API webhook routing (T157 / T166)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("routes a valid Meta event by phone_number_id to its active connection's company", async () => {
    const payload = makeInboundMessagePayload(PHONE_NUMBER_ID_A);
    const rawBody = JSON.stringify(payload);
    const { db, upserts } = createFakeCompanyDb();

    const activeConnection: ActiveMetaConnection = {
      id: CONNECTION_A,
      companyId: COMPANY_A,
      phoneNumberId: PHONE_NUMBER_ID_A,
      method: "cloud_api",
    };

    const deps: MetaWebhookDeps = {
      lookupConnection: vi.fn(async (id) => (id === PHONE_NUMBER_ID_A ? activeConnection : null)),
      loadAppSecret: vi.fn(async () => APP_SECRET_A),
      createDb: vi.fn(() => db as never),
    };

    const response = await handleMetaWebhookPost(
      makeMetaPostRequest(rawBody, signMetaBody(rawBody, APP_SECRET_A)),
      deps,
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ ok: true });
    expect(deps.createDb).toHaveBeenCalledWith(COMPANY_A);
    expect(upserts).toHaveLength(2);
    expect(upserts[0]).toMatchObject({
      table: "whatsapp_chats",
      rows: [
        expect.objectContaining({
          company_id: COMPANY_A,
          connection_id: CONNECTION_A,
          chat_number: "96550999888",
          display_name: "Ahmed",
          last_message_preview: "مرحبا",
        }),
      ],
    });
    expect(upserts[1]).toMatchObject({
      table: "whatsapp_messages",
      rows: [
        expect.objectContaining({
          company_id: COMPANY_A,
          connection_id: CONNECTION_A,
          message_id: "wamid.inbound.1",
          chat_number: "96550999888",
          direction: "inbound",
          body: "مرحبا",
        }),
      ],
    });
  });

  it("drops an unknown phone_number_id with 200, logs it, and writes nothing", async () => {
    const payload = makeInboundMessagePayload("999999999999");
    const warn = vi.fn();
    const createDb = vi.fn();
    const loadAppSecret = vi.fn();

    const response = await handleMetaWebhookPost(makeMetaPostRequest(payload, "sha256=00"), {
      lookupConnection: async () => null,
      loadAppSecret,
      createDb,
      logger: { warn },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("999999999999"));
    expect(loadAppSecret).not.toHaveBeenCalled();
    expect(createDb).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing signature header", signature: undefined },
    { name: "wrong signature prefix", signature: "md5=deadbeef" },
    {
      name: "invalid hex length",
      signature: "sha256=abcd",
    },
    {
      name: "valid hex signed with wrong secret",
      signature: signMetaBody(
        JSON.stringify(makeInboundMessagePayload(PHONE_NUMBER_ID_A)),
        "wrong_secret",
      ),
    },
  ])(
    "drops a bad signature ($name) with the same 200 and writes nothing",
    async ({ signature }) => {
      const payload = makeInboundMessagePayload(PHONE_NUMBER_ID_A);
      const { db, upserts } = createFakeCompanyDb();
      const warn = vi.fn();

      const response = await handleMetaWebhookPost(makeMetaPostRequest(payload, signature), {
        lookupConnection: async () => ({
          id: CONNECTION_A,
          companyId: COMPANY_A,
          phoneNumberId: PHONE_NUMBER_ID_A,
          method: "cloud_api",
        }),
        loadAppSecret: async () => APP_SECRET_A,
        createDb: () => db as never,
        logger: { warn },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad signature"));
      expect(upserts).toHaveLength(0);
    },
  );

  it("drops a known number whose app secret is missing with the same 200", async () => {
    const payload = makeInboundMessagePayload(PHONE_NUMBER_ID_A);
    const { db, upserts } = createFakeCompanyDb();
    const warn = vi.fn();

    const response = await handleMetaWebhookPost(
      makeMetaPostRequest(payload, signMetaBody(JSON.stringify(payload), APP_SECRET_A)),
      {
        lookupConnection: async () => ({
          id: CONNECTION_A,
          companyId: COMPANY_A,
          phoneNumberId: PHONE_NUMBER_ID_A,
          method: "cloud_api",
        }),
        loadAppSecret: async () => null,
        createDb: () => db as never,
        logger: { warn },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no app secret"));
    expect(upserts).toHaveLength(0);
  });

  it("verifies X-Hub-Signature-256 in constant time", () => {
    const raw = '{"hello":"world"}';
    const valid = signMetaBody(raw, APP_SECRET_A);
    expect(verifyMetaSignature(raw, valid, APP_SECRET_A)).toBe(true);
    expect(verifyMetaSignature(raw, valid.toUpperCase(), APP_SECRET_A)).toBe(false);
    expect(verifyMetaSignature(raw, "sha256=" + "0".repeat(64), APP_SECRET_A)).toBe(false);
  });

  it.each([
    {
      name: "valid verify token echoes challenge with 200",
      url: `https://ijary.app/api/public/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=challenge-123`,
      tokenEnv: VERIFY_TOKEN,
      expectedStatus: 200,
      expectedBody: "challenge-123",
    },
    {
      name: "mismatched verify token returns 403",
      url: "https://ijary.app/api/public/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123",
      tokenEnv: VERIFY_TOKEN,
      expectedStatus: 403,
    },
    {
      name: "missing verify token env returns 503",
      url: `https://ijary.app/api/public/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=challenge-123`,
      tokenEnv: "",
      expectedStatus: 503,
    },
  ])("GET handshake: $name", async ({ url, tokenEnv, expectedStatus, expectedBody }) => {
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", tokenEnv);

    const response = await handleMetaWebhookGet(new Request(url, { method: "GET" }));

    expect(response.status).toBe(expectedStatus);
    if (expectedBody !== undefined) {
      expect(await response.text()).toBe(expectedBody);
    }
  });
});
