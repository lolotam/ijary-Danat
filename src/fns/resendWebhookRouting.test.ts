import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * توجيه ويب هوك البريد: الشركة من المسار، لا من الحمولة (قصة المستخدم 10).
 *
 * Two endpoints, two secrets: a company that configured its own sender has an
 * endpoint of its own, and the platform's default sender has the other one.
 * The company a delivery belongs to comes from the route — a payload is the
 * sender's to write, and one company must never be able to move another
 * company's notification by naming it in the body.
 */

const { db, COMPANY_ID } = vi.hoisted(() => ({
  COMPANY_ID: "00000000-0000-4000-8000-000000000002",
  db: {
    company: {
      id: "00000000-0000-4000-8000-000000000002",
      name_ar: "شركة البيت",
      name_en: "Bayt Real Estate",
      email: "hello@bayt.test",
    },
    providerConfigs: [] as Record<string, unknown>[],
    secrets: [] as Record<string, unknown>[],
    notifications: [] as Record<string, unknown>[],
    webhookEvents: [] as Record<string, unknown>[],
    platformOwners: [] as Record<string, unknown>[],
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
            : table === "notifications"
              ? db.notifications
              : table === "email_webhook_events"
                ? db.webhookEvents
                : [];
    return rows.filter((row) => filters.every(([column, value]) => row[column] === value));
  }

  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    let update: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {
      select: () => chain,
      insert: (row: Record<string, unknown>) => {
        db.webhookEvents.push(row);
        return chain;
      },
      update: (row: Record<string, unknown>) => {
        update = row;
        return chain;
      },
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return chain;
      },
      like: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve({ data: resolve()[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: resolve()[0] ?? null, error: null }),
      then: (onFulfilled: (value: unknown) => unknown) =>
        Promise.resolve({ data: resolve(), error: null }).then(onFulfilled),
    };
    // The write happens when the chain resolves, so the filters the caller
    // added after the update are the ones that decide which rows change.
    function resolve() {
      const matched = resultFor(table, filters);
      if (update) for (const row of matched) Object.assign(row, update);
      return matched;
    }
    return chain;
  }

  const client = {
    from: (table: string) => builder(table),
    rpc: (name: string) => {
      if (name === "platform_email_notification_owner") {
        return Promise.resolve({ data: db.platformOwners, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
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
const { handleCompanyResendWebhook } =
  await import("@/routes/api/public/webhooks/resend.$companyId");
const { handlePlatformResendWebhook } =
  await import("@/routes/api/public/webhooks/resend-platform");

/** سرّ اختباري صالح الترميز؛ الجسم بعد `whsec_` يجب أن يكون base64 سليمًا. */
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const PLATFORM_SECRET = "whsec_ZzKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const EMAIL_ID = "56761188-7520-42d8-8898-ff6fc54ce618";
const NOW = 1_760_000_000_000;

/**
 * يوقّع الطلب كما يوقّعه Svix تمامًا، عبر WebCrypto مباشرة.
 */
async function svixSignature(id: string, timestamp: string, body: string, secret: string) {
  const keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (character) =>
    character.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(signed)))}`;
}

/**
 * يبني حمولة ارتدادٍ دائمة referrer إلى رسالة بمعرّف معروف.
 */
function bouncePayload(emailId: string = EMAIL_ID) {
  return {
    type: "email.bounced",
    created_at: new Date(NOW - 10 * 60 * 1000).toISOString(),
    data: {
      email_id: emailId,
      to: ["tenant@example.com"],
      subject: "فاتورة الإيجار",
      bounce: { type: "Permanent", subType: "General", message: "Mailbox does not exist." },
    },
  };
}

/**
 * يبني طلبًا موقّعًا توقيعًا صحيحًا.
 *
 * The signature timestamp is the real clock: the route hands the handler no
 * timestamp of its own, and a stale one is refused before the body is read.
 */
async function signedRequest(payload: unknown, secret: string, id = "msg_1") {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return new Request("https://ijary.app/api/public/webhooks/resend", {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": await svixSignature(id, timestamp, body, secret),
    },
    body,
  });
}

/**
 * يبني صفّ سرّ مشفّر كما يخزّنه التطبيق في `company_secrets`.
 */
function secretRow(name: string, plain: string) {
  const encrypted = encryptSecret(plain);
  return {
    owner_kind: "email",
    owner_id: "pc-1",
    name,
    version: 1,
    ciphertext: encodeByteaHex(encrypted.ciphertext),
    iv: encodeByteaHex(encrypted.iv),
    auth_tag: encodeByteaHex(encrypted.authTag),
    key_version: encrypted.keyVersion,
  };
}

/**
 * ينفّذ مسار الشركة مع معرّفها.
 */
function postCompanyRoute(request: Request, companyId: string = COMPANY_ID) {
  return handleCompanyResendWebhook(request, companyId);
}

/**
 * ينفّذ مسار المنصة.
 */
function postPlatformRoute(request: Request) {
  return handlePlatformResendWebhook(request);
}

describe("resend webhook routing (US10)", () => {
  beforeEach(() => {
    db.providerConfigs = [];
    db.secrets = [];
    db.notifications = [];
    db.webhookEvents = [];
    db.platformOwners = [];
    vi.stubEnv("INTEGRATIONS_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("PLATFORM_RESEND_WEBHOOK_SECRET", PLATFORM_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("verifies a company's own delivery with that company's secret", async () => {
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
    db.secrets = [secretRow("webhook_secret", SECRET)];
    db.notifications = [
      {
        id: "notif-1",
        company_id: COMPANY_ID,
        state: "sent",
        provider_message_id: EMAIL_ID,
        failure_reason: null,
      },
    ];

    const response = await postCompanyRoute(await signedRequest(bouncePayload(), SECRET));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, applied: true });
    // The bounce parked the notification for a human instead of failing it,
    // which the drain job would have sent again.
    expect(db.notifications[0].state).toBe("needs_review");
  });

  it("refuses a delivery signed with another company's secret", async () => {
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
    db.secrets = [secretRow("webhook_secret", SECRET)];
    db.notifications = [
      {
        id: "notif-1",
        company_id: COMPANY_ID,
        state: "sent",
        provider_message_id: EMAIL_ID,
        failure_reason: null,
      },
    ];

    const response = await postCompanyRoute(await signedRequest(bouncePayload(), PLATFORM_SECRET));

    expect(response.status).toBe(401);
    expect(db.notifications[0].state).toBe("sent");
  });

  it("answers 503 for a company that has no sender of its own", async () => {
    const response = await postCompanyRoute(await signedRequest(bouncePayload(), SECRET));

    expect(response.status).toBe(503);
    expect(db.notifications).toHaveLength(0);
  });

  it("takes the company of a platform delivery from the message, not from the payload", async () => {
    db.platformOwners = [{ company_id: COMPANY_ID, notification_id: "notif-9" }];
    db.notifications = [
      {
        id: "notif-9",
        company_id: COMPANY_ID,
        state: "sent",
        provider_message_id: EMAIL_ID,
        failure_reason: null,
      },
    ];

    const response = await postPlatformRoute(await signedRequest(bouncePayload(), PLATFORM_SECRET));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, applied: true });
    expect(db.notifications[0].state).toBe("needs_review");
    // The archive row belongs to the company the message belonged to.
    expect(db.webhookEvents[0]).toMatchObject({ company_id: COMPANY_ID });
  });

  it("refuses a platform delivery signed with the wrong secret", async () => {
    db.platformOwners = [{ company_id: COMPANY_ID, notification_id: "notif-9" }];

    const response = await postPlatformRoute(await signedRequest(bouncePayload(), SECRET));

    expect(response.status).toBe(401);
  });

  it("acknowledges a platform delivery whose company cannot be found", async () => {
    const response = await postPlatformRoute(await signedRequest(bouncePayload(), PLATFORM_SECRET));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, unmatched: true });
    expect(db.notifications).toHaveLength(0);
  });
});
