import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendWithTwilio } from "./twilio";
import { stubHungFetch } from "./hungProvider.fixture";
import { DELIVERY_INDETERMINATE, PROVIDER_TIMEOUT_MS } from "./types";

const CONFIG = {
  account_sid_env: "TWILIO_ACCOUNT_SID",
  secret_env: "TWILIO_AUTH_TOKEN",
  from_whatsapp_env: "TWILIO_WHATSAPP_FROM",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

/** Twilio takes form-encoded bodies; decode the last one for assertions. */
function lastCall() {
  const mock = vi.mocked(globalThis.fetch);
  const [url, init] = mock.mock.calls[mock.mock.calls.length - 1] as [string, RequestInit];
  return { url, init, params: new URLSearchParams(String(init.body)) };
}

describe("sendWithTwilio", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "auth-token");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const contentMessage = {
    config: CONFIG,
    contentSid: "HX0123456789abcdef",
    contentVariables: { "1": "أحمد", "2": "150.000 KWD" },
    from: null,
    to: "+96550123456",
  };

  it("reports a provider that never answers as possibly delivered, not as a plain failure", async () => {
    // No idempotency key exists here, so the drain must not retry a timeout:
    // the provider may have accepted the message after we stopped waiting.
    const { fireTimeout, timeoutSpy } = stubHungFetch();

    const send = sendWithTwilio(contentMessage);
    fireTimeout();

    await expect(send).rejects.toMatchObject({ code: DELIVERY_INDETERMINATE });
    expect(timeoutSpy).toHaveBeenCalledWith(PROVIDER_TIMEOUT_MS);
  });

  it("posts to the account Messages endpoint with basic authorization", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(201, { sid: "SM123" }));

    const result = await sendWithTwilio(contentMessage);

    const { url, init } = lastCall();
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("AC123:auth-token").toString("base64")}`,
    );
    expect(result.messageId).toBe("SM123");
  });

  it("normalises both addresses to whatsapp:+E164", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(201, { sid: "SM1" }));

    await sendWithTwilio({ ...contentMessage, from: "+1 (415) 523-8886", to: "965 5012 3456" });

    const { params } = lastCall();
    expect(params.get("From")).toBe("whatsapp:+14155238886");
    expect(params.get("To")).toBe("whatsapp:+96550123456");
  });

  it("sends a business-initiated message as ContentSid with ordered variables", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(201, { sid: "SM2" }));

    await sendWithTwilio(contentMessage);

    const { params } = lastCall();
    expect(params.get("ContentSid")).toBe("HX0123456789abcdef");
    expect(JSON.parse(String(params.get("ContentVariables")))).toEqual({
      "1": "أحمد",
      "2": "150.000 KWD",
    });
    // Twilio rejects a request carrying both, so Body must be absent.
    expect(params.get("Body")).toBeNull();
  });

  it("sends Body only when the caller explicitly allows free-form delivery", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(201, { sid: "SM3" }));

    await sendWithTwilio({
      allowFreeform: true,
      body: "Reply received, thank you.",
      config: CONFIG,
      from: null,
      to: "+96550123456",
    });

    const { params } = lastCall();
    expect(params.get("Body")).toBe("Reply received, thank you.");
    expect(params.get("ContentSid")).toBeNull();
  });

  it("refuses free-form delivery that was not explicitly allowed", async () => {
    await expect(
      sendWithTwilio({
        body: "Your rent is overdue.",
        config: CONFIG,
        from: null,
        to: "+96550123456",
      }),
    ).rejects.toThrow(/requires an approved Content SID/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refuses an allowed free-form message with an empty body", async () => {
    await expect(
      sendWithTwilio({
        allowFreeform: true,
        body: "   ",
        config: CONFIG,
        from: null,
        to: "+96550123456",
      }),
    ).rejects.toThrow(/body is required/i);
  });

  it("fails when no sender is configured", async () => {
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "");

    await expect(sendWithTwilio(contentMessage)).rejects.toThrow(
      /sender \(from\) is not configured/i,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fails before making a request when the auth token variable is unset", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");

    await expect(sendWithTwilio(contentMessage)).rejects.toThrow(/TWILIO_AUTH_TOKEN is not set/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("surfaces the Twilio error code and message without the credentials", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(400, { code: 63016, message: "Failed to send freeform message" }),
    );

    const error = await sendWithTwilio(contentMessage).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/\[code 63016\].*Failed to send freeform message/);
    expect((error as Error).message).not.toContain("auth-token");
  });

  it("rejects a 2xx response that carries no SID", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(201, { status: "queued" }));

    await expect(sendWithTwilio(contentMessage)).rejects.toThrow(/did not contain a message SID/i);
  });
});
