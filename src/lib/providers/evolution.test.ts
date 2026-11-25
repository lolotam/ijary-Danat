import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EvolutionProviderError,
  getEvolutionStatus,
  resetEvolutionPacing,
  sendWithEvolution,
} from "./evolution";
import { DELIVERY_INDETERMINATE } from "./types";

const CONFIG = { api_base: "http://evolution:8080", api_key_env: "TEST_EVOLUTION_KEY" };

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Runs a send with fake timers so the anti-ban pacing delays cost no wall time. */
async function paced<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const promise = work();
    await vi.advanceTimersByTimeAsync(60_000);
    return await promise;
  } finally {
    vi.useRealTimers();
  }
}

describe("sendWithEvolution", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("TEST_EVOLUTION_KEY", "evo-key");
    resetEvolutionPacing();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends free text to bare international digits", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(201, { key: { id: "evo-1" } }));

    const result = await sendWithEvolution(
      { body: "مرحباً", config: CONFIG, from: null, to: "+965 5012-3456" },
      "danat",
    );

    expect(result.messageId).toBe("evo-1");
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://evolution:8080/message/sendText/danat");
    expect(JSON.parse(String(init.body))).toEqual({ number: "96550123456", text: "مرحباً" });
  });

  it("sends the text first, then each media part, and joins the part ids", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(jsonResponse(201, { key: { id: "t-1" } }))
      .mockResolvedValueOnce(jsonResponse(201, { key: { id: "m-1" } }))
      .mockResolvedValueOnce(jsonResponse(201, { key: { id: "m-2" } }));

    const result = await paced(() =>
      sendWithEvolution(
        {
          body: "receipt",
          config: CONFIG,
          from: null,
          to: "+96550123456",
          media: [
            { base64: "QUFB", fileName: "receipt.pdf", mediatype: "document" },
            { base64: "QkJC", fileName: "photo.jpg", mediatype: "image" },
          ],
        },
        "danat",
      ),
    );

    expect(result.partIds).toEqual(["t-1", "m-1", "m-2"]);
    expect(result.messageId).toBe("t-1,m-1,m-2");
    const urls = vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      "http://evolution:8080/message/sendText/danat",
      "http://evolution:8080/message/sendMedia/danat",
      "http://evolution:8080/message/sendMedia/danat",
    ]);
    const firstMedia = JSON.parse(
      String((vi.mocked(globalThis.fetch).mock.calls[1][1] as RequestInit).body),
    );
    expect(firstMedia).toEqual({
      number: "96550123456",
      mediatype: "document",
      media: "QUFB",
      fileName: "receipt.pdf",
    });
  });

  it("reports partial_send when a later part fails after earlier parts landed", async () => {
    // A blind retry of the whole notification would resend the delivered text,
    // so partial failures must carry their own non-retryable code.
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(jsonResponse(201, { key: { id: "t-1" } }))
      .mockResolvedValueOnce(jsonResponse(500, { message: "boom" }));

    const error = await paced(() =>
      sendWithEvolution(
        {
          body: "receipt",
          config: CONFIG,
          from: null,
          to: "+96550123456",
          media: [{ base64: "QUFB", fileName: "receipt.pdf", mediatype: "document" }],
        },
        "danat",
      ).catch((caught: unknown) => caught),
    );

    expect(error).toBeInstanceOf(EvolutionProviderError);
    expect((error as EvolutionProviderError).code).toBe("partial_send");
    expect((error as EvolutionProviderError).retryable).toBe(false);
    expect((error as EvolutionProviderError).message).toMatch(/1 of 2/);
  });

  it("maps a 404 to instance_missing without probing the connection", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(404, {}));

    const error = await sendWithEvolution(
      { body: "hi", config: CONFIG, from: null, to: "+96550123456" },
      "danat",
    ).catch((caught: unknown) => caught);

    expect((error as EvolutionProviderError).code).toBe("instance_missing");
    expect((error as EvolutionProviderError).retryable).toBe(false);
  });

  it("maps a closed session to session_disconnected via one state probe", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(jsonResponse(400, { message: "Connection Closed" }))
      .mockResolvedValueOnce(jsonResponse(200, { instance: { state: "close" } }));

    const error = await sendWithEvolution(
      { body: "hi", config: CONFIG, from: null, to: "+96550123456" },
      "danat",
    ).catch((caught: unknown) => caught);

    expect((error as EvolutionProviderError).code).toBe("session_disconnected");
    expect((error as EvolutionProviderError).retryable).toBe(false);
  });

  it("maps a number-not-on-whatsapp body to its own terminal code", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(400, { message: "number does not exist on whatsapp" }),
    );

    const error = await sendWithEvolution(
      { body: "hi", config: CONFIG, from: null, to: "+96550123456" },
      "danat",
    ).catch((caught: unknown) => caught);

    expect((error as EvolutionProviderError).code).toBe("number_not_on_whatsapp");
    expect((error as EvolutionProviderError).retryable).toBe(false);
  });

  it("treats a 5xx as transient while the session probe still says open", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { instance: { state: "open" } }));

    const error = await sendWithEvolution(
      { body: "hi", config: CONFIG, from: null, to: "+96550123456" },
      "danat",
    ).catch((caught: unknown) => caught);

    expect((error as EvolutionProviderError).code).toBe("unknown_error");
    expect((error as EvolutionProviderError).retryable).toBe(true);
  });

  it("parks a timed-out send as possibly delivered unless the session is known to be closed", async () => {
    // A timeout is not a refusal: Evolution may have queued the message after
    // the client gave up, so retrying it as transient risks a second copy.
    vi.mocked(globalThis.fetch)
      .mockRejectedValueOnce(new DOMException("aborted", "AbortError"))
      .mockResolvedValueOnce(jsonResponse(200, { instance: { state: "open" } }));

    const error = await sendWithEvolution(
      { body: "hi", config: CONFIG, from: null, to: "+96550123456" },
      "danat",
    ).catch((caught: unknown) => caught);

    expect((error as EvolutionProviderError).code).toBe(DELIVERY_INDETERMINATE);
    expect((error as EvolutionProviderError).retryable).toBe(false);
  });

  it("treats a 5xx as transient when the gateway itself is unreachable for the probe", async () => {
    // Evolution restarting: the send 503s and so does the state probe. That is
    // the gateway being down, not the QR session being gone — a retry later is
    // the right call, and parking it for a human re-scan would be wrong.
    vi.mocked(globalThis.fetch).mockImplementation(async () => jsonResponse(503, {}));

    const error = await sendWithEvolution(
      { body: "hi", config: CONFIG, from: null, to: "+96550123456" },
      "danat",
    ).catch((caught: unknown) => caught);

    expect((error as EvolutionProviderError).code).toBe("unknown_error");
    expect((error as EvolutionProviderError).retryable).toBe(true);
  });

  it("maps a 5xx from a closed session to session_disconnected, not to a transient error", async () => {
    // Production 2026-09-02: WhatsApp unlinked the device mid-batch. Evolution
    // answered every later send with HTTP 500 "Connection Closed", which was
    // classified as transient, retried three times, and left as `failed` with
    // a reason that said the opposite of what happened.
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(jsonResponse(500, { message: "Connection Closed" }))
      .mockResolvedValueOnce(jsonResponse(200, { instance: { state: "close" } }));

    const error = await sendWithEvolution(
      { body: "hi", config: CONFIG, from: null, to: "+96550123456" },
      "danat",
    ).catch((caught: unknown) => caught);

    expect((error as EvolutionProviderError).code).toBe("session_disconnected");
    expect((error as EvolutionProviderError).retryable).toBe(false);
    expect((error as EvolutionProviderError).message).toMatch(/re-scan/i);
  });

  it("refuses an empty message with no media before any network call", async () => {
    await expect(
      sendWithEvolution({ body: "  ", config: CONFIG, from: null, to: "+96550123456" }, "danat"),
    ).rejects.toThrow(/body or at least one attachment/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("getEvolutionStatus", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("TEST_EVOLUTION_KEY", "evo-key");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns the state and the owner number once the session is open", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(jsonResponse(200, { instance: { state: "open" } }))
      .mockResolvedValueOnce(jsonResponse(200, [{ ownerJid: "96597950350:3@s.whatsapp.net" }]));

    const status = await getEvolutionStatus(CONFIG, "danat");

    expect(status.state).toBe("open");
    expect(status.connectedNumber).toBe("96597950350");
  });

  it("skips the owner lookup while the session is not open", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(200, { instance: { state: "connecting" } }),
    );

    const status = await getEvolutionStatus(CONFIG, "danat");

    expect(status).toEqual({ state: "connecting", connectedNumber: null });
    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(1);
  });
});
