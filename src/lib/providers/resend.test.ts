import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendWithResend } from "./resend";
import { stubHungFetch } from "./hungProvider.fixture";
import { PROVIDER_TIMEOUT_MS } from "./types";

const CONFIG = { secret_env: "RESEND_API_KEY" };

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

function lastCall() {
  const mock = vi.mocked(globalThis.fetch);
  const [url, init] = mock.mock.calls[mock.mock.calls.length - 1] as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) };
}

describe("sendWithResend", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("RESEND_API_KEY", "re_live_key");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const message = {
    body: "<p>Receipt</p>",
    config: CONFIG,
    from: "billing@danat-future.com",
    subject: "Receipt",
    to: ["tenant@example.com"],
  };

  it("gives up on a provider that never answers instead of hanging the drain", async () => {
    const { fireTimeout, timeoutSpy } = stubHungFetch();

    const send = sendWithResend(message);
    fireTimeout();

    await expect(send).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeoutSpy).toHaveBeenCalledWith(PROVIDER_TIMEOUT_MS);
  });

  it("keys a retry on its content, so only an identical resend is deduplicated", async () => {
    // Resend answers a reused key with a different body with 409 for 24 hours.
    // The body is rebuilt on every attempt, so after an admin fixes a bad
    // address the retry must carry a new key rather than dead-end.
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      jsonResponse(200, { id: "resend-k" }),
    );
    const keyOf = async (to: string[]) => {
      await sendWithResend({ ...message, to, idempotencyKey: "row-1" });
      return (lastCall().init.headers as Record<string, string>)["Idempotency-Key"];
    };

    const first = await keyOf(["tenant@example.com"]);
    const identical = await keyOf(["tenant@example.com"]);
    const corrected = await keyOf(["tenant.fixed@example.com"]);

    expect(first).toMatch(/^row-1\//);
    expect(identical).toBe(first);
    expect(corrected).not.toBe(first);
  });

  it("sends no idempotency header when the caller gives no key", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(200, { id: "resend-n" }));

    await sendWithResend(message);

    expect(lastCall().init.headers).not.toHaveProperty("Idempotency-Key");
  });

  it("carries cc, bcc and the plain-text alternative", async () => {
    // These were silently dropped: the payload only ever sent from/to/subject/
    // html, so a Cc'd recipient never received the message and a client that
    // refuses HTML rendered an empty one.
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(200, { id: "resend-2" }));

    await sendWithResend({
      ...message,
      cc: ["manager@example.com"],
      bcc: ["archive@example.com"],
      text: "Receipt",
      replyTo: "ceo@danat-future.com",
    });

    expect(lastCall().body).toMatchObject({
      cc: ["manager@example.com"],
      bcc: ["archive@example.com"],
      text: "Receipt",
      reply_to: "ceo@danat-future.com",
    });
  });

  it("omits cc and bcc entirely when empty rather than sending empty arrays", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(200, { id: "resend-3" }));

    await sendWithResend({ ...message, cc: [], bcc: [] });

    const body = lastCall().body;
    expect(body).not.toHaveProperty("cc");
    expect(body).not.toHaveProperty("bcc");
  });

  it("sends a Bcc-only message instead of rejecting it", async () => {
    // "Send to all tenants" produces exactly this shape. The old guard required
    // a visible `to` and made that send impossible through Resend.
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(200, { id: "resend-4" }));

    await sendWithResend({ ...message, to: [], bcc: ["a@example.com"] });

    expect(lastCall().body).toMatchObject({ to: [], bcc: ["a@example.com"] });
  });

  it("still rejects a message with no recipient in any field", async () => {
    await expect(sendWithResend({ ...message, to: [], cc: [], bcc: [] })).rejects.toThrow(
      /at least one recipient/i,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("posts to the emails endpoint with bearer authorization", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(200, { id: "resend-1" }));

    const result = await sendWithResend(message);

    const { url, init, body } = lastCall();
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_live_key");
    expect(body).toMatchObject({
      from: "billing@danat-future.com",
      to: ["tenant@example.com"],
      subject: "Receipt",
      html: "<p>Receipt</p>",
    });
    expect(result.messageId).toBe("resend-1");
  });

  it("base64-encodes attachments and preserves the content type", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(200, { id: "resend-2" }));

    await sendWithResend({
      ...message,
      attachments: [
        {
          content: Buffer.from("%PDF-1.4"),
          contentType: "application/pdf",
          filename: "receipt.pdf",
        },
      ],
    });

    expect(lastCall().body.attachments).toEqual([
      {
        filename: "receipt.pdf",
        content: Buffer.from("%PDF-1.4").toString("base64"),
        content_type: "application/pdf",
      },
    ]);
  });

  it("omits content_type when it is unknown so Resend infers it", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(200, { id: "resend-3" }));

    await sendWithResend({
      ...message,
      attachments: [{ content: "YWJj", filename: "note.txt" }],
    });

    expect(lastCall().body.attachments[0]).not.toHaveProperty("content_type");
  });

  it("fails before making a request when the API key variable is unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "");

    await expect(sendWithResend(message)).rejects.toThrow(/RESEND_API_KEY is not set/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fails when the sender address is empty", async () => {
    await expect(sendWithResend({ ...message, from: "  " })).rejects.toThrow(
      /sender address is not configured/i,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fails when there is no recipient", async () => {
    await expect(sendWithResend({ ...message, to: [] })).rejects.toThrow(/at least one recipient/i);
  });

  it("surfaces the Resend error without the API key", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(403, {
        name: "validation_error",
        message: "The danat-future.com domain is not verified",
      }),
    );

    const error = await sendWithResend(message).catch((caught: Error) => caught);
    expect((error as Error).message).toMatch(/\[validation_error\].*domain is not verified/);
    expect((error as Error).message).not.toContain("re_live_key");
  });

  it("rejects a 2xx response that carries no id", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(200, {}));

    await expect(sendWithResend(message)).rejects.toThrow(/did not contain a message id/i);
  });
});
