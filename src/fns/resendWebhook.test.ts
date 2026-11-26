import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * قاعدة بيانات وهمية تطبّق مرشّحات `eq` و`like` فعليًّا.
 *
 * A `mockReturnThis` chain would make every assertion here vacuous: the
 * conditional update `.eq("state", "sent")` IS the idempotency mechanism, so a
 * fake that ignores filters would report success for a replay and prove
 * nothing. This one stores rows and filters them, which is the minimum needed
 * for the guard to be genuinely exercised. It deliberately does not encode any
 * of the handler's decisions — which events are terminal, which state to write —
 * so the tests still test the handler and not the fake.
 */
const { fake } = vi.hoisted(() => {
  interface Row {
    [key: string]: unknown;
  }

  const store = {
    tables: { notifications: [] as Row[], email_webhook_events: [] as Row[] },
    tablesTouched: [] as string[],
    nextId: 1,
  };

  function matchesFilters(row: Row, filters: Array<[string, unknown]>) {
    return filters.every(([column, value]) => row[column] === value);
  }

  function matchesLikes(row: Row, likes: Array<[string, string]>) {
    return likes.every(([column, pattern]) => {
      const literal = pattern.replace(/^%|%$/g, "").replace(/\\([\\%_])/g, "$1");
      return String(row[column] ?? "").includes(literal);
    });
  }

  function builder(table: string) {
    store.tablesTouched.push(table);
    const filters: Array<[string, unknown]> = [];
    const likes: Array<[string, string]> = [];
    let operation: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    let wantsOne = false;

    function execute() {
      const rows = store.tables[table as keyof typeof store.tables];

      if (operation === "insert") {
        const duplicate = rows.some(
          (row) =>
            row.provider_event_id != null &&
            row.provider === payload.provider &&
            row.provider_event_id === payload.provider_event_id,
        );
        if (duplicate) {
          return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        const inserted = { ...payload, id: `evt-${store.nextId++}` };
        rows.push(inserted);
        return { data: inserted, error: null };
      }

      const matched = rows.filter(
        (row) => matchesFilters(row, filters) && matchesLikes(row, likes),
      );

      if (operation === "update") {
        for (const row of matched) Object.assign(row, payload);
        return { data: wantsOne ? (matched[0] ?? null) : matched, error: null };
      }

      return { data: wantsOne ? (matched[0] ?? null) : matched, error: null };
    }

    const api = {
      select: () => api,
      limit: () => api,
      insert: (row: Row) => {
        operation = "insert";
        payload = row;
        return api;
      },
      update: (row: Row) => {
        operation = "update";
        payload = row;
        return api;
      },
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return api;
      },
      like: (column: string, pattern: string) => {
        likes.push([column, pattern]);
        return api;
      },
      single: () => {
        wantsOne = true;
        return api;
      },
      maybeSingle: () => {
        wantsOne = true;
        return api;
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(execute()).then(resolve, reject),
    };
    return api;
  }

  return {
    fake: {
      store,
      client: { from: (table: string) => builder(table) },
      reset() {
        store.tables.notifications = [];
        store.tables.email_webhook_events = [];
        store.tablesTouched = [];
        store.nextId = 1;
      },
    },
  };
});

const TEST_COMPANY = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "danat",
  status: "active" as const,
};

vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => TEST_COMPANY,
  requireRequestCompany: () => TEST_COMPANY,
  runWithRequestCompany: async (_company: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/company/companyClient.server", () => ({ companyClient: () => fake.client }));

import { resendEventDetails, respondToResendWebhook, verifySvixSignature } from "./resendWebhook";

/** سرّ اختباري صالح الترميز؛ الجسم بعد `whsec_` يجب أن يكون base64 سليمًا. */
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const EMAIL_ID = "56761188-7520-42d8-8898-ff6fc54ce618";

/**
 * يوقّع الطلب كما يوقّعه Svix تمامًا، عبر WebCrypto مباشرة.
 *
 * Signed here with the raw platform API rather than by calling the project's
 * own `hmacBase64`: a test that signs with the code under test would pass even
 * if that code implemented the wrong algorithm entirely.
 */
async function svixSignature(id: string, timestamp: string, body: string, secret = SECRET) {
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

const NOW = 1_760_000_000_000;

/**
 * يبني حمولة ارتداد بنوع محدّد، أو بلا كتلة `bounce` إطلاقًا عند تمرير null.
 *
 * `created_at` defaults to the tests' NOW and is overridable, because the
 * handler ages an unmatched event from the payload — never from `svix-timestamp`,
 * which Svix re-signs on every retry.
 */
function bouncePayload(
  bounceType: string | null,
  emailId: string = EMAIL_ID,
  createdAtMs: number = NOW,
) {
  return {
    type: "email.bounced",
    created_at: new Date(createdAtMs).toISOString(),
    data: {
      email_id: emailId,
      to: ["tenant@example.com"],
      subject: "فاتورة الإيجار",
      ...(bounceType === null
        ? {}
        : {
            bounce: {
              type: bounceType,
              subType: "General",
              message: "The recipient's mailbox does not exist.",
            },
          }),
    },
  };
}

/**
 * يبني طلبًا موقّعًا توقيعًا صحيحًا، مع إتاحة تثبيت المعرّف والختم الزمني للاختبار.
 */
async function signedRequest(
  payload: unknown,
  options: { id?: string; timestampMs?: number } = {},
) {
  const body = JSON.stringify(payload);
  const id = options.id ?? "msg_2abc";
  const timestamp = Math.floor((options.timestampMs ?? NOW) / 1000).toString();
  return new Request("https://danat-future.com/api/public/resend-webhook", {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": await svixSignature(id, timestamp, body),
    },
    body,
  });
}

/**
 * يزرع إشعارًا في حالة `sent` بمعرّف الرسالة المعطى، وهي الحالة الوحيدة التي يعدّلها المعالج.
 */
function seedSentNotification(providerMessageId: string, id = "notif-1") {
  fake.store.tables.notifications.push({
    id,
    state: "sent",
    provider_message_id: providerMessageId,
    failure_reason: null,
  });
  return id;
}

/**
 * يقرأ صف الإشعار من المخزن الوهمي للتحقق مما كتبه المعالج فعليًّا.
 */
function notificationById(id: string) {
  return fake.store.tables.notifications.find((row) => row.id === id);
}

describe("resendWebhook signature verification", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    fake.reset();
    process.env = { ...originalEnv, RESEND_WEBHOOK_SECRET: SECRET };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("fails closed and says so when RESEND_WEBHOOK_SECRET is unset", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedSentNotification(EMAIL_ID);

    const response = await respondToResendWebhook(
      await signedRequest(bouncePayload("Permanent")),
      NOW,
    );

    expect(response.status).toBe(503);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("RESEND_WEBHOOK_SECRET"));
    // The point of failing closed: nothing was read, nothing was written.
    expect(fake.store.tablesTouched).toEqual([]);
    expect(notificationById("notif-1")?.state).toBe("sent");
  });

  it("rejects a forged signature and leaves the notification untouched", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    seedSentNotification(EMAIL_ID);
    const body = JSON.stringify(bouncePayload("Permanent"));
    const request = new Request("https://danat-future.com/api/public/resend-webhook", {
      method: "POST",
      headers: {
        "svix-id": "msg_forged",
        "svix-timestamp": Math.floor(NOW / 1000).toString(),
        "svix-signature": "v1,Zm9yZ2VkIHNpZ25hdHVyZSB2YWx1ZSBoZXJlAAAAAAAAAAA=",
      },
      body,
    });

    const response = await respondToResendWebhook(request, NOW);

    expect(response.status).toBe(401);
    // The half that makes this non-vacuous: a 401 that still mutated would pass
    // a status-only assertion.
    expect(notificationById("notif-1")?.state).toBe("sent");
    expect(fake.store.tables.email_webhook_events).toHaveLength(1);
    expect(fake.store.tables.email_webhook_events[0]).toMatchObject({
      signature_valid: false,
      result: "unverified",
      error: "signature_mismatch",
      // A rejected delivery was recorded, not handled. Marking it processed
      // would hide it from "what did this endpoint fail to process?".
      processed: false,
    });
  });

  it("does not archive an unsigned request that carries no svix-id", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = new Request("https://danat-future.com/api/public/resend-webhook", {
      method: "POST",
      headers: { "svix-timestamp": Math.floor(NOW / 1000).toString(), "svix-signature": "v1,x" },
      body: JSON.stringify(bouncePayload("Permanent")),
    });

    const response = await respondToResendWebhook(request, NOW);

    expect(response.status).toBe(401);
    // Without a svix-id the partial unique index cannot dedupe, so archiving
    // would let anyone POST in a loop and grow the table without bound.
    expect(fake.store.tables.email_webhook_events).toHaveLength(0);
  });

  it("collapses repeated unsigned deliveries of one svix-id onto a single row", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    /** يبني طلبًا غير موقّع بالمعرّف نفسه في كل مرة، لمحاكاة التكرار. */
    const build = () =>
      new Request("https://danat-future.com/api/public/resend-webhook", {
        method: "POST",
        headers: {
          "svix-id": "msg_flood",
          "svix-timestamp": Math.floor(NOW / 1000).toString(),
          "svix-signature": "v1,Zm9yZ2VkIHNpZ25hdHVyZSB2YWx1ZSBoZXJlAAAAAAAAAAA=",
        },
        body: JSON.stringify(bouncePayload("Permanent")),
      });

    await respondToResendWebhook(build(), NOW);
    await respondToResendWebhook(build(), NOW);

    expect(fake.store.tables.email_webhook_events).toHaveLength(1);
  });

  it("refuses an oversized body before parsing or storing it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = new Request("https://danat-future.com/api/public/resend-webhook", {
      method: "POST",
      headers: {
        "svix-id": "msg_big",
        "svix-timestamp": Math.floor(NOW / 1000).toString(),
        "svix-signature": "v1,x",
      },
      body: JSON.stringify({ type: "email.bounced", padding: "x".repeat(300 * 1024) }),
    });

    const response = await respondToResendWebhook(request, NOW);

    expect(response.status).toBe(413);
    expect(fake.store.tables.email_webhook_events).toHaveLength(0);
  });

  it("refuses an oversized declared length without reading a single byte", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The point of the Content-Length pre-check is that the body is never
    // consumed at all. Asserting only on the 413 cannot tell that apart from
    // buffering 500 MB first and rejecting afterwards, which is the failure
    // mode. `bodyUsed` is the probe that discriminates: it flips on `.text()`
    // and on `.getReader()`, and stays false only if the handler touched
    // neither. (A stream's `pull` is not usable here — the runtime starts
    // draining a stream body on its own, before the handler is ever called.)
    const request = new Request("https://danat-future.com/api/public/resend-webhook", {
      method: "POST",
      headers: {
        "content-length": String(256 * 1024 + 1),
        "svix-id": "msg_declared",
        "svix-timestamp": Math.floor(NOW / 1000).toString(),
        "svix-signature": "v1,x",
      },
      body: "small body, large declared length",
    });

    const response = await respondToResendWebhook(request, NOW);

    expect(response.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
    expect(fake.store.tables.email_webhook_events).toHaveLength(0);
  });

  it("caps a chunked body that declares no length at all", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // No Content-Length to trust, so the limit has to be enforced while the
    // stream is consumed. Emits 8 chunks of 64 KB: the cap must trip partway.
    let emitted = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (emitted >= 8) return controller.close();
        emitted += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const request = new Request("https://danat-future.com/api/public/resend-webhook", {
      method: "POST",
      headers: {
        "svix-id": "msg_chunked",
        "svix-timestamp": Math.floor(NOW / 1000).toString(),
        "svix-signature": "v1,x",
      },
      body,
      duplex: "half",
    } as unknown as RequestInit);

    const response = await respondToResendWebhook(request, NOW);

    expect(response.status).toBe(413);
    // Cut off rather than drained: stopping only at the end would mean the cap
    // never bounded anything.
    expect(emitted).toBeLessThan(8);
    expect(fake.store.tables.email_webhook_events).toHaveLength(0);
  });

  it("measures the body cap in bytes, not UTF-16 units", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // 200k Arabic characters: under the 256k cap by `String.length`, but two
    // UTF-8 bytes each puts it at ~400 KB. A length-based check would let this
    // through while the docs promise a 256 KB ceiling.
    const request = new Request("https://danat-future.com/api/public/resend-webhook", {
      method: "POST",
      headers: {
        "svix-id": "msg_arabic",
        "svix-timestamp": Math.floor(NOW / 1000).toString(),
        "svix-signature": "v1,x",
      },
      body: "ف".repeat(200 * 1024),
    });

    const response = await respondToResendWebhook(request, NOW);

    expect(response.status).toBe(413);
    expect(fake.store.tables.email_webhook_events).toHaveLength(0);
  });

  it("rejects a correctly signed request whose timestamp is outside the window", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    seedSentNotification(EMAIL_ID);
    const stale = NOW - 10 * 60 * 1000;

    const response = await respondToResendWebhook(
      await signedRequest(bouncePayload("Permanent"), { timestampMs: stale }),
      NOW,
    );

    expect(response.status).toBe(401);
    expect(notificationById("notif-1")?.state).toBe("sent");
    expect(fake.store.tables.email_webhook_events[0]).toMatchObject({
      error: "stale_timestamp",
    });
  });

  it("rejects a request with no signature headers at all", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = new Request("https://danat-future.com/api/public/resend-webhook", {
      method: "POST",
      body: JSON.stringify(bouncePayload("Permanent")),
    });

    const response = await respondToResendWebhook(request, NOW);

    expect(response.status).toBe(401);
    // No svix-id, so nothing is archived — see the flood test above.
    expect(fake.store.tables.email_webhook_events).toHaveLength(0);
  });

  it("accepts the vendor-neutral webhook-* header aliases", async () => {
    seedSentNotification(EMAIL_ID);
    const body = JSON.stringify(bouncePayload("Permanent"));
    const timestamp = Math.floor(NOW / 1000).toString();
    const request = new Request("https://danat-future.com/api/public/resend-webhook", {
      method: "POST",
      headers: {
        "webhook-id": "msg_alias",
        "webhook-timestamp": timestamp,
        "webhook-signature": await svixSignature("msg_alias", timestamp, body),
      },
      body,
    });

    const response = await respondToResendWebhook(request, NOW);

    expect(response.status).toBe(200);
    expect(notificationById("notif-1")?.state).toBe("needs_review");
  });

  it("accepts either signature while a secret is being rotated", async () => {
    const body = JSON.stringify(bouncePayload("Permanent"));
    const timestamp = Math.floor(NOW / 1000).toString();
    const valid = await svixSignature("msg_rotate", timestamp, body);

    const result = await verifySvixSignature({
      headers: {
        id: "msg_rotate",
        // The retiring key's signature first, the live one second: both are
        // present during a rotation and either must be accepted.
        signature: `v1,c3RhbGUga2V5IHNpZ25hdHVyZSB2YWx1ZSBnb2VzAAA= ${valid}`,
        timestamp,
      },
      now: NOW,
      rawBody: body,
      secret: SECRET,
    });

    expect(result).toEqual({ reason: null, valid: true });
  });

  it("reports a malformed secret distinctly rather than as a mismatch", async () => {
    const body = JSON.stringify(bouncePayload("Permanent"));
    const timestamp = Math.floor(NOW / 1000).toString();

    const result = await verifySvixSignature({
      headers: { id: "msg_1", signature: "v1,abc", timestamp },
      now: NOW,
      rawBody: body,
      secret: "whsec_",
    });

    expect(result).toEqual({ reason: "malformed_secret", valid: false });
  });
});

describe("resendEventDetails classification", () => {
  // Only Transient means "may still arrive" — Resend is still retrying it, and
  // filing it as undeliverable would report a message as dead while it is in
  // flight. Undetermined and a missing type are real failures, and treating
  // them as anything else is how a lost email stays invisible.
  it.each([
    ["Permanent", true],
    ["Transient", false],
    ["Undetermined", true],
    [null, true],
  ] as const)("classifies a %s bounce as terminal=%s", (bounceType, terminal) => {
    expect(resendEventDetails(bouncePayload(bounceType)).terminal).toBe(terminal);
  });

  it.each(["email.complained", "email.failed", "email.suppressed"])(
    "treats %s as terminal",
    (type) => {
      expect(resendEventDetails({ type, data: { email_id: EMAIL_ID } }).terminal).toBe(true);
    },
  );

  it.each([
    "email.sent",
    "email.delivered",
    "email.opened",
    "email.clicked",
    "email.delivery_delayed",
  ])("does not treat %s as terminal", (type) => {
    expect(resendEventDetails({ type, data: { email_id: EMAIL_ID } }).terminal).toBe(false);
  });

  it("builds a failure reason carrying the bounce detail", () => {
    const details = resendEventDetails(bouncePayload("Permanent"));
    expect(details.failureReason).toContain("email.bounced");
    expect(details.failureReason).toContain("Permanent");
    expect(details.failureReason).toContain("mailbox does not exist");
  });

  it("survives a payload that is not an object", () => {
    expect(resendEventDetails("nonsense" as never)).toMatchObject({
      emailId: null,
      eventType: null,
      terminal: false,
    });
  });
});

describe("resendWebhook notification handling", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    fake.reset();
    process.env = { ...originalEnv, RESEND_WEBHOOK_SECRET: SECRET };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("moves a permanently bounced notification to needs_review, not failed", async () => {
    seedSentNotification(EMAIL_ID);

    const response = await respondToResendWebhook(
      await signedRequest(bouncePayload("Permanent")),
      NOW,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, applied: true });
    const row = notificationById("notif-1");
    // `failed` would put the row straight back into runNotificationDrainJob's
    // retry set and resend to an address that permanently rejected it.
    expect(row?.state).toBe("needs_review");
    expect(row?.failure_reason).toContain("email.bounced");
  });

  it("leaves a transiently bounced notification alone", async () => {
    seedSentNotification(EMAIL_ID);

    const response = await respondToResendWebhook(
      await signedRequest(bouncePayload("Transient")),
      NOW,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true });
    expect(notificationById("notif-1")?.state).toBe("sent");
    // Recorded as a soft bounce specifically. Filed as `ignored_event_type` it
    // would be indistinguishable from an `email.opened`, and "was this a soft
    // bounce?" is the question this archive exists to answer.
    expect(fake.store.tables.email_webhook_events[0]).toMatchObject({
      result: "transient_bounce",
      signature_valid: true,
    });
  });

  it("records a delivered event without touching the notification", async () => {
    seedSentNotification(EMAIL_ID);

    const response = await respondToResendWebhook(
      await signedRequest({ type: "email.delivered", data: { email_id: EMAIL_ID } }),
      NOW,
    );

    expect(response.status).toBe(200);
    expect(notificationById("notif-1")?.state).toBe("sent");
    expect(fake.store.tables.email_webhook_events).toHaveLength(1);
  });

  it("matches a channel:both notification whose message ids are comma joined", async () => {
    // dispatchNotification stores `messageIds.join(",")`, so an exact-equality
    // lookup would silently skip every notification sent by two channels.
    seedSentNotification(`${EMAIL_ID},wamid.HBgLOTY1...`);

    const response = await respondToResendWebhook(
      await signedRequest(bouncePayload("Permanent")),
      NOW,
    );

    expect(response.status).toBe(200);
    expect(notificationById("notif-1")?.state).toBe("needs_review");
  });

  // An event created more than EARLY_MISS_WINDOW_MS ago, so a miss means "this
  // mail was not sent by us", not "the row is not written yet".
  const SETTLED = NOW - 3 * 60 * 1000;

  it("does not match a notification whose id merely contains the event id", async () => {
    seedSentNotification(`${EMAIL_ID}-extra-suffix`);

    const response = await respondToResendWebhook(
      await signedRequest(bouncePayload("Permanent", EMAIL_ID, SETTLED)),
      NOW,
    );

    expect(await response.json()).toMatchObject({ unmatched: true });
    expect(notificationById("notif-1")?.state).toBe("sent");
  });

  it("acknowledges an event for mail this app never sent", async () => {
    const response = await respondToResendWebhook(
      await signedRequest(bouncePayload("Permanent", "unknown-email-id", SETTLED)),
      NOW,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, unmatched: true });
    expect(fake.store.tables.email_webhook_events[0]).toMatchObject({ result: "unmatched" });
  });

  it("asks Svix to retry a fresh bounce whose notification row is not written yet", async () => {
    // dispatchNotification stores provider_message_id only AFTER the send
    // returns, so a fast bounce can arrive first. Acknowledging it would tell
    // Svix never to retry and the bounce would be lost for good — the exact
    // invisible failure this endpoint exists to prevent.
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await respondToResendWebhook(
      await signedRequest(bouncePayload("Permanent"), { id: "msg_race" }),
      NOW,
    );

    expect(response.status).toBe(503);
    // Nothing archived: a stored row would collide with the retry's own
    // svix-id, and the retry is the entire point.
    expect(fake.store.tables.email_webhook_events).toHaveLength(0);
  });

  it("applies the retry once the notification row lands", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const early = await respondToResendWebhook(
      await signedRequest(bouncePayload("Permanent"), { id: "msg_race" }),
      NOW,
    );
    expect(early.status).toBe(503);

    seedSentNotification(EMAIL_ID);
    const retry = await respondToResendWebhook(
      await signedRequest(bouncePayload("Permanent"), { id: "msg_race" }),
      NOW,
    );

    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ applied: true });
    expect(notificationById("notif-1")?.state).toBe("needs_review");
  });

  it("corrects an unverified archive row when the same delivery later verifies", async () => {
    // The runbook's ordinary case: the endpoint deploys before the secret is
    // set, so real deliveries are archived `unverified`; the secret is then
    // fixed and Svix retries the SAME id.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    seedSentNotification(EMAIL_ID);
    const body = JSON.stringify(bouncePayload("Permanent"));
    const timestamp = Math.floor(NOW / 1000).toString();

    await respondToResendWebhook(
      new Request("https://danat-future.com/api/public/resend-webhook", {
        method: "POST",
        headers: {
          "svix-id": "msg_setup",
          "svix-timestamp": timestamp,
          "svix-signature": "v1,d3Jvbmcgc2VjcmV0IHNpZ25hdHVyZSB2YWx1ZQAAAA=",
        },
        body,
      }),
      NOW,
    );
    expect(fake.store.tables.email_webhook_events[0]).toMatchObject({ signature_valid: false });

    const fixed = await respondToResendWebhook(
      await signedRequest(bouncePayload("Permanent"), { id: "msg_setup" }),
      NOW,
    );

    expect(await fixed.json()).toMatchObject({ applied: true, replay: false });
    expect(notificationById("notif-1")?.state).toBe("needs_review");
    // Still one row, and it must no longer claim the event went unverified and
    // touched nothing — otherwise the archive contradicts the notification.
    expect(fake.store.tables.email_webhook_events).toHaveLength(1);
    expect(fake.store.tables.email_webhook_events[0]).toMatchObject({
      signature_valid: true,
      processed: true,
      result: "applied",
      notification_id: "notif-1",
    });
  });

  it("treats a redelivery of the same svix-id as a no-op", async () => {
    seedSentNotification(EMAIL_ID);

    const first = await respondToResendWebhook(
      await signedRequest(bouncePayload("Permanent"), { id: "msg_replay" }),
      NOW,
    );
    expect(await first.json()).toMatchObject({ applied: true });

    // Svix retries with the SAME id until it gets a 2xx.
    const second = await respondToResendWebhook(
      await signedRequest(bouncePayload("Permanent"), { id: "msg_replay" }),
      NOW,
    );

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ applied: false, replay: true });
    expect(fake.store.tables.email_webhook_events).toHaveLength(1);
    expect(notificationById("notif-1")?.state).toBe("needs_review");
  });

  it("does not overwrite a row a human has already re-queued", async () => {
    // Out-of-order or late delivery: the row left `sent` after the bounce was
    // handled, and the conditional update must find nothing to change.
    fake.store.tables.notifications.push({
      id: "notif-1",
      state: "queued",
      provider_message_id: EMAIL_ID,
      failure_reason: null,
    });

    const response = await respondToResendWebhook(
      await signedRequest(bouncePayload("Permanent"), { id: "msg_late" }),
      NOW,
    );

    expect(await response.json()).toMatchObject({ applied: false });
    expect(notificationById("notif-1")?.state).toBe("queued");
    expect(fake.store.tables.email_webhook_events[0]).toMatchObject({
      result: "already_terminal",
    });
  });
});
