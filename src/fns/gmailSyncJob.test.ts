import { beforeEach, describe, expect, test, vi } from "vitest";

import { stubHungFetch } from "@/lib/providers/hungProvider.fixture";
import { PROVIDER_TIMEOUT_MS } from "@/lib/providers/types";

const mocks = vi.hoisted(() => ({
  readGmailGrant: vi.fn(),
  getGmailAccessToken: vi.fn().mockResolvedValue("access-token"),
  from: vi.fn(),
  fetch: vi.fn(),
  upsert: vi.fn().mockResolvedValue({ error: null }),
  storedIdsIn: vi.fn(),
  hydrate: vi.fn(),
  connectionUpdate: vi.fn(),
}));

vi.mock("@/lib/gmailClient.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/gmailClient.server")>(
    "@/lib/gmailClient.server",
  );
  return {
    ...actual,
    readGmailGrant: mocks.readGmailGrant,
    getGmailAccessToken: mocks.getGmailAccessToken,
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

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({ from: mocks.from }),
  serverCompanyClient: (explicitCompanyId?: string) => ({
    companyId: explicitCompanyId ?? TEST_COMPANY.id,
    client: { from: mocks.from },
  }),
}));

import { resolveMessageKey, runGmailSyncJob } from "@/fns/gmailSyncJob";
// extractPlainText moved to lib/gmailMessage.ts when the detail view and the
// send path needed the same MIME walking the sync job had kept private.
import { extractPlainText, type GmailMessagePayload } from "@/lib/gmailMessage";

/** Gmail returns part bodies as URL-safe base64. */
function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

const grant = {
  credentials: {
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "refresh",
    address: "me",
  },
  connectionId: "conn-1",
};

function mockFrom() {
  mocks.from.mockImplementation((table: string) => {
    if (table === "companies") {
      return {
        select: () => ({
          order: () => ({
            limit: () => ({
              single: async () => ({ data: { id: "company-1" }, error: null }),
            }),
          }),
        }),
      };
    }
    if (table === "gmail_connections") {
      return {
        update: (values: unknown) => {
          mocks.connectionUpdate(values);
          return { eq: async () => ({ error: null }) };
        },
      };
    }
    if (table === "gmail_messages") {
      // Three shapes on the same table: the diff read, the hydrate update,
      // and the insert.
      return {
        upsert: mocks.upsert,
        select: () => ({ eq: () => ({ in: mocks.storedIdsIn }) }),
        update: (values: unknown) => ({
          eq: () => ({
            eq: (_col: string, messageId: string) => ({
              is: () => ({ select: () => mocks.hydrate(messageId, values) }),
            }),
          }),
        }),
      };
    }
    return {};
  });
}

/** Full-message JSON the job would get from format=full. */
function fullMessage(id: string, labelIds: string[] | undefined, subject: string) {
  return {
    id,
    threadId: `thread-${id}`,
    snippet: subject,
    internalDate: "1700000000000",
    labelIds,
    payload: {
      headers: [
        { name: "From", value: "sender@example.com" },
        { name: "To", value: "inbox@example.com" },
        { name: "Subject", value: subject },
        { name: "Message-ID", value: `<${id}@mail.example>` },
      ],
      body: { data: b64("body") },
    },
  };
}

describe("extractPlainText", () => {
  test("reads a single-part body (the original shape)", () => {
    const payload: GmailMessagePayload = { body: { data: b64("Hello there") } };
    expect(extractPlainText(payload)).toBe("Hello there");
  });

  test("finds text/plain inside a multipart/alternative", () => {
    // This is what essentially all real mail looks like, and what the previous
    // top-level-only reader returned null for.
    const payload: GmailMessagePayload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64("Plain version") } },
        { mimeType: "text/html", body: { data: b64("<p>HTML version</p>") } },
      ],
    };
    expect(extractPlainText(payload)).toBe("Plain version");
  });

  test("walks nested multiparts", () => {
    const payload: GmailMessagePayload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [{ mimeType: "text/plain", body: { data: b64("Deeply nested") } }],
        },
        { mimeType: "application/pdf", body: { data: b64("%PDF-1.7") } },
      ],
    };
    expect(extractPlainText(payload)).toBe("Deeply nested");
  });

  test("falls back to stripped HTML when there is no plain part", () => {
    const payload: GmailMessagePayload = {
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/html",
          body: { data: b64("<style>p{color:red}</style><p>Hi <b>there</b></p>") },
        },
      ],
    };
    expect(extractPlainText(payload)).toBe("Hi there");
  });

  test("prefers plain text even when the HTML part comes first", () => {
    const payload: GmailMessagePayload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64("<p>HTML</p>") } },
        { mimeType: "text/plain", body: { data: b64("Plain") } },
      ],
    };
    expect(extractPlainText(payload)).toBe("Plain");
  });

  test("ignores an empty text/plain part and keeps looking", () => {
    const payload: GmailMessagePayload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64("   ") } },
        { mimeType: "text/html", body: { data: b64("<p>Real content</p>") } },
      ],
    };
    expect(extractPlainText(payload)).toBe("Real content");
  });

  test("returns null when there is nothing readable", () => {
    // The caller falls back to Gmail's snippet.
    expect(extractPlainText(undefined)).toBeNull();
    expect(extractPlainText({ mimeType: "multipart/mixed", parts: [] })).toBeNull();
    expect(
      extractPlainText({
        mimeType: "multipart/mixed",
        parts: [{ mimeType: "image/png", body: { data: b64("binary") } }],
      }),
    ).toBeNull();
  });
});

describe("resolveMessageKey", () => {
  test("prefers the RFC 822 Message-ID header", () => {
    expect(resolveMessageKey("<abc@mail.example>", "18f0")).toBe("<abc@mail.example>");
  });

  test("falls back to the Gmail id when the header is absent", () => {
    // The column is NOT NULL for exactly this case: while it was nullable, a
    // header-less message re-inserted on every tick, because in Postgres null
    // is never equal to null and so the unique constraint never fired.
    expect(resolveMessageKey(null, "18f0")).toBe("gmail:18f0");
  });

  test("treats a blank header as absent", () => {
    expect(resolveMessageKey("   ", "18f0")).toBe("gmail:18f0");
    expect(resolveMessageKey("", "18f0")).toBe("gmail:18f0");
  });

  test("is stable — the same message always yields the same key", () => {
    expect(resolveMessageKey(null, "18f0")).toBe(resolveMessageKey(null, "18f0"));
  });
});

describe("runGmailSyncJob request timeouts", () => {
  beforeEach(() => {
    mocks.readGmailGrant.mockReset().mockResolvedValue(grant);
    mocks.getGmailAccessToken.mockReset().mockResolvedValue("access-token");
    mocks.from.mockReset();
    mocks.upsert.mockReset().mockResolvedValue({ error: null });
    // Nothing stored, so the listed message is new and its fetch is attempted.
    mocks.storedIdsIn.mockReset().mockResolvedValue({ data: [], error: null });
    mockFrom();
    mocks.fetch.mockReset();
    vi.stubGlobal("fetch", mocks.fetch);
  });

  test("a hung message fetch fails the run instead of stalling the cron tick", async () => {
    // Both Gmail calls were bare fetches: one that never answered held the
    // sync open for as long as the socket lived. The list call answers here
    // and the per-message call hangs, so both call sites must pass a signal.
    const { fireTimeout, timeoutSpy } = stubHungFetch();
    mocks.fetch.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({ messages: [{ id: "msg-hung" }] }),
    }));

    const run = runGmailSyncJob();
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    fireTimeout();

    await expect(run).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalledWith(PROVIDER_TIMEOUT_MS);
    // The list call answered, so only its init can show it carried a signal.
    expect((mocks.fetch.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});

describe("runGmailSyncJob is_read from labelIds", () => {
  beforeEach(() => {
    mocks.readGmailGrant.mockReset().mockResolvedValue(grant);
    mocks.getGmailAccessToken.mockReset().mockResolvedValue("access-token");
    mocks.from.mockReset();
    mocks.upsert.mockReset().mockResolvedValue({ error: null });
    // Nothing stored by default, so every listed message counts as new.
    mocks.storedIdsIn.mockReset().mockResolvedValue({ data: [], error: null });
    mocks.hydrate.mockReset().mockResolvedValue({ data: [], error: null });
    mockFrom();
    mocks.fetch.mockReset();
    vi.stubGlobal("fetch", mocks.fetch);
  });

  test("upserts is_read true when labels lack UNREAD, false when present", async () => {
    // List page → two messages; full GETs return one already-read and one unread.
    mocks.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages?") || /\/messages$/.test(url.split("?")[0] ?? "")) {
        // List endpoint (no trailing message id).
        if (!url.includes("/messages/msg-")) {
          return {
            ok: true,
            json: async () => ({
              messages: [{ id: "msg-read" }, { id: "msg-unread" }],
            }),
          };
        }
      }
      if (url.includes("/messages/msg-read")) {
        return {
          ok: true,
          json: async () => fullMessage("msg-read", ["INBOX"], "Already read"),
        };
      }
      if (url.includes("/messages/msg-unread")) {
        return {
          ok: true,
          json: async () => fullMessage("msg-unread", ["INBOX", "UNREAD"], "Still unread"),
        };
      }
      return { ok: false, text: async () => "unexpected" };
    });

    const result = await runGmailSyncJob();
    expect(result).toEqual({ synced: 2 });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);

    const rows = mocks.upsert.mock.calls[0][0] as Array<{ message_id: string; is_read: boolean }>;
    const byId = Object.fromEntries(rows.map((r) => [r.message_id, r.is_read]));
    expect(byId["<msg-read@mail.example>"]).toBe(true);
    expect(byId["<msg-unread@mail.example>"]).toBe(false);
  });

  test("copies X-Failed-Recipients onto the list row so the inbox can flag a DSN", async () => {
    mocks.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes("/messages/msg-bounce") && url.includes("/messages")) {
        return {
          ok: true,
          json: async () => ({ messages: [{ id: "msg-bounce" }] }),
        };
      }
      if (url.includes("/messages/msg-bounce")) {
        const message = fullMessage("msg-bounce", ["INBOX"], "Delivery Status Notification");
        message.payload.headers.push({
          name: "X-Failed-Recipients",
          value: "gone@example.com",
        });
        return { ok: true, json: async () => message };
      }
      return { ok: false, text: async () => "unexpected" };
    });

    await runGmailSyncJob();
    const rows = mocks.upsert.mock.calls[0][0] as Array<{ failed_recipients: string | null }>;
    expect(rows[0].failed_recipients).toBe("gone@example.com");
  });
});

/**
 * The quota incident of 2026-09-14.
 *
 * The job listed its 30-day window and issued one `messages.get?format=full`
 * per listed id every ten minutes — including the ~208 already stored, whose
 * rows the upsert then discarded because it runs with `ignoreDuplicates`.
 * Measured against the live mailbox, Gmail allows about 105 full gets per
 * minute per user (99 succeeded, a second batch was refused at number 6), so
 * the run was refused ~27 seconds in, every single time.
 */
describe("runGmailSyncJob quota discipline", () => {
  /** يسجّل كل نداءات Gmail حتى يمكن عدّ ما طُلب فعلاً. */
  let requested: string[];

  beforeEach(() => {
    mocks.readGmailGrant.mockReset().mockResolvedValue(grant);
    mocks.getGmailAccessToken.mockReset().mockResolvedValue("access-token");
    mocks.from.mockReset();
    mocks.upsert.mockReset().mockResolvedValue({ error: null });
    mocks.storedIdsIn.mockReset().mockResolvedValue({ data: [], error: null });
    // No placeholder by default: the update matches nothing.
    mocks.hydrate.mockReset().mockResolvedValue({ data: [], error: null });
    mockFrom();
    mocks.fetch.mockReset();
    vi.stubGlobal("fetch", mocks.fetch);
    requested = [];
  });

  /**
   * يردّ على الاستعراض بالمعرّفات المعطاة، وعلى كل رسالة بنسخة كاملة.
   * `throttleAfter` يحاكي نفاد الحصة بعد عدد محدّد من نداءات الرسائل.
   */
  function stubGmail(ids: string[], throttleAfter = Infinity) {
    let gets = 0;
    mocks.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      const messageMatch = /\/messages\/([^?]+)/.exec(url);
      if (!messageMatch) {
        return { ok: true, json: async () => ({ messages: ids.map((id) => ({ id })) }) };
      }
      gets += 1;
      if (gets > throttleAfter) {
        return {
          ok: false,
          status: 403,
          text: async () =>
            JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } }),
        };
      }
      return { ok: true, json: async () => fullMessage(messageMatch[1], ["INBOX"], "Subject") };
    });
  }

  /** عدد نداءات الرسائل الكاملة، وهي الوحيدة باهظة الحصة. */
  function fullGetCount() {
    return requested.filter((url) => /\/messages\/[^?]+/.test(url)).length;
  }

  test("fetches nothing when every listed message is already stored", async () => {
    stubGmail(["msg-1", "msg-2", "msg-3"]);
    mocks.storedIdsIn.mockResolvedValue({
      data: [{ gmail_id: "msg-1" }, { gmail_id: "msg-2" }, { gmail_id: "msg-3" }],
      error: null,
    });

    const result = await runGmailSyncJob();

    expect(fullGetCount()).toBe(0);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(result).toEqual({ synced: 0 });
  });

  test("fetches only the messages it has never seen", async () => {
    stubGmail(["msg-old", "msg-new"]);
    mocks.storedIdsIn.mockResolvedValue({ data: [{ gmail_id: "msg-old" }], error: null });

    await runGmailSyncJob();

    expect(fullGetCount()).toBe(1);
    expect(requested.some((url) => url.includes("/messages/msg-new"))).toBe(true);
    expect(requested.some((url) => url.includes("/messages/msg-old"))).toBe(false);
  });

  /**
   * Review finding on PR #207, and production confirmed it before the fix: all
   * three messages ever sent from the app had two rows — the placeholder keyed
   * on the bare Gmail id, and the synced row keyed on the RFC 822 header. The
   * upsert cannot see that as a conflict, and the row a user clicks in the
   * Inbox may be the one with no MIME tree, so attachments and reply threading
   * stay broken for it.
   */
  test("fills the placeholder a local send left, rather than inserting beside it", async () => {
    stubGmail(["msg-sent-from-app"]);
    mocks.hydrate.mockResolvedValue({ data: [{ id: "existing-row" }], error: null });

    await runGmailSyncJob();

    // The full payload went into the existing row...
    expect(mocks.hydrate).toHaveBeenCalledWith(
      "msg-sent-from-app",
      expect.objectContaining({
        raw_payload: expect.objectContaining({ id: "msg-sent-from-app" }),
      }),
    );
    // ...and no second row was created for it.
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  /**
   * `is_read` and `direction` are the send's own truth: the staff member who
   * sent the message has read it, and a label-derived value would undo that.
   */
  test("does not overwrite the placeholder's read state or direction", async () => {
    stubGmail(["msg-sent-from-app"]);
    mocks.hydrate.mockResolvedValue({ data: [{ id: "existing-row" }], error: null });

    await runGmailSyncJob();

    const values = mocks.hydrate.mock.calls[0][1] as Record<string, unknown>;
    expect(values).not.toHaveProperty("is_read");
    expect(values).not.toHaveProperty("direction");
    expect(values).not.toHaveProperty("received_at");
  });

  test("inserts normally when there is no placeholder to fill", async () => {
    stubGmail(["msg-inbound"]);

    await runGmailSyncJob();

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const rows = mocks.upsert.mock.calls[0][0] as Array<{ message_id: string }>;
    expect(rows).toHaveLength(1);
  });

  /**
   * Falling through to the insert is the safe direction: at worst it recreates
   * the duplicate that exists today, rather than dropping a message entirely.
   */
  test("still stores the message when the hydrate update errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stubGmail(["msg-sent-from-app"]);
    mocks.hydrate.mockResolvedValue({ data: null, error: { message: "update failed" } });

    await runGmailSyncJob();

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  test("diffs against the ids Gmail lists, not the RFC 822 header we store as message_id", async () => {
    // `message_id` holds `<msg-1@mail.example>` while the list endpoint returns
    // `msg-1`. Diffing on the wrong column matches nothing and refetches all.
    stubGmail(["msg-1"]);

    await runGmailSyncJob();

    expect(mocks.storedIdsIn).toHaveBeenCalledWith("gmail_id", ["msg-1"]);
  });

  /**
   * The pages already written are durable and the next tick has a fresh budget
   * and a shorter diff. Failing the tick would mark the job red every ten
   * minutes while it was in fact making progress.
   */
  test("a spent quota stops the run without failing it, keeping what it stored", async () => {
    stubGmail(["msg-1", "msg-2", "msg-3"], 2);

    const result = await runGmailSyncJob();

    expect(result).toEqual({ synced: 2, reason: "rate-limited" });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  /**
   * Production 2026-09-24: the integrations page showed "Gmail list failed
   * (403) … rateLimitExceeded" permanently, because every tick spent the
   * budget re-downloading stored mail and the next LIST call was refused. A
   * spent quota on the list call is the same soft stop, and must not be
   * recorded as the connection's error.
   */
  test("a rate-limited list call stops cleanly and leaves no sync error behind", async () => {
    mocks.connectionUpdate.mockReset();
    mocks.fetch.mockImplementation(async () => ({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({
          error: {
            code: 403,
            message:
              "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'.",
            errors: [{ domain: "usageLimits", reason: "rateLimitExceeded" }],
            status: "PERMISSION_DENIED",
          },
        }),
    }));

    const result = await runGmailSyncJob();

    expect(result).toEqual({ synced: 0, reason: "rate-limited" });
    expect(mocks.connectionUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ last_sync_error: null }),
    );
  });

  /**
   * 403 is also how Gmail reports a missing scope, which needs an admin to
   * reconnect — the opposite of "try again shortly".
   */
  test("a 403 that is not a rate limit still fails the tick", async () => {
    mocks.fetch.mockImplementation(async () => ({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({ error: { message: "insufficient authentication scopes" } }),
    }));

    await expect(runGmailSyncJob()).rejects.toThrow(/Disconnect|scope|Gmail/i);
  });

  test("refetches a page rather than skipping it when the stored ids cannot be read", async () => {
    // The safe direction: a wasted fetch costs quota, a wrongly skipped message
    // is never stored at all.
    stubGmail(["msg-1"]);
    mocks.storedIdsIn.mockResolvedValue({ data: null, error: { message: "read failed" } });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await runGmailSyncJob();

    expect(fullGetCount()).toBe(1);
    consoleError.mockRestore();
  });
});
