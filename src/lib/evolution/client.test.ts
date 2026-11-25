import { describe, expect, it, vi } from "vitest";

import {
  addressableJid,
  collectMessagePage,
  createEvolutionClient,
  EvolutionApiError,
  extractQr,
  extractState,
  maskJid,
  normalizeEvolutionEvent,
  remoteNumberFor,
} from "./client";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clientWith(fetcher: typeof fetch) {
  return createEvolutionClient({ baseUrl: "http://evo:8080/", apiKey: "global-key", fetcher });
}

describe("createEvolutionClient", () => {
  it("sends the apikey header and strips the trailing slash from the base URL", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    await clientWith(fetcher).connectionState("danat");

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://evo:8080/instance/connectionState/danat");
    expect((init.headers as Record<string, string>).apikey).toBe("global-key");
  });

  it("URL-escapes instance names so a hostile name cannot change the path", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    await clientWith(fetcher).connect("a/b c");

    expect(String(fetcher.mock.calls[0][0])).toBe("http://evo:8080/instance/connect/a%2Fb%20c");
  });

  it("throws EvolutionApiError carrying status and body on a non-2xx answer", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(404, { message: "instance not found" }));

    const error = await clientWith(fetcher)
      .sendText("danat", { number: "96550123456", text: "hi" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EvolutionApiError);
    expect((error as EvolutionApiError).status).toBe(404);
    expect((error as EvolutionApiError).body).toEqual({ message: "instance not found" });
  });

  it("normalises a timeout to EvolutionApiError with status 0", async () => {
    // A fetcher that respects the abort signal, like real fetch does.
    const fetcher = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        }),
    );
    const client = createEvolutionClient({
      baseUrl: "http://evo:8080",
      apiKey: "k",
      fetcher: fetcher as typeof fetch,
      timeoutMs: 10,
    });

    await expect(client.connect("danat")).rejects.toMatchObject({
      name: "EvolutionApiError",
      status: 0,
      message: /timed out/,
    });
  });

  it("creates instances as WHATSAPP-BAILEYS with the webhook wired in", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(201, {}));
    await clientWith(fetcher).createInstance({
      instanceName: "danat",
      webhook: {
        url: "https://danat-future.com/api/public/evolution-webhook",
        headers: { "x-danat-webhook-secret": "s" },
        events: ["MESSAGES_UPSERT"],
      },
    });

    const body = JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body));
    expect(body.integration).toBe("WHATSAPP-BAILEYS");
    expect(body.qrcode).toBe(true);
    expect(body.webhook.url).toBe("https://danat-future.com/api/public/evolution-webhook");
    expect(body.webhook.headers).toEqual({ "x-danat-webhook-secret": "s" });
  });
});

describe("normalizeEvolutionEvent", () => {
  it("maps delivered dotted names onto the SCREAMING_SNAKE subscription names", () => {
    expect(normalizeEvolutionEvent("connection.update")).toBe("CONNECTION_UPDATE");
    expect(normalizeEvolutionEvent("messages-upsert")).toBe("MESSAGES_UPSERT");
    expect(normalizeEvolutionEvent("QRCODE_UPDATED")).toBe("QRCODE_UPDATED");
    expect(normalizeEvolutionEvent(undefined)).toBe("");
  });
});

describe("extractQr / extractState", () => {
  it("reads the QR across the payload shapes Evolution versions produce", () => {
    expect(extractQr({ qrcode: { base64: "AAA" } })).toBe("AAA");
    expect(extractQr({ qr: { image: "BBB" } })).toBe("BBB");
    expect(extractQr({ code: "CCC" })).toBe("CCC");
    expect(extractQr({})).toBeNull();
  });

  it("reads the state from instance, root and connectionStatus shapes", () => {
    expect(extractState({ instance: { state: "open" } })).toBe("open");
    expect(extractState({ state: "connecting" })).toBe("connecting");
    expect(extractState({ connectionStatus: "close" })).toBe("close");
    expect(extractState({})).toBeNull();
  });
});

describe("remoteNumberFor", () => {
  it("strips the multi-device suffix BEFORE stripping non-digits", () => {
    // Stripping non-digits first would splice ':12' onto the subscriber number
    // and fabricate 9659795035012 — a wrong phone number in the conversation id.
    expect(remoteNumberFor("96597950350:12@s.whatsapp.net")).toBe("96597950350");
    expect(remoteNumberFor("96550123456@s.whatsapp.net")).toBe("96550123456");
  });
});

describe("addressableJid", () => {
  it("accepts phone JIDs, resolves @lid via remoteJidAlt, drops the rest", () => {
    expect(addressableJid({ remoteJid: "96550123456@s.whatsapp.net" })).toBe(
      "96550123456@s.whatsapp.net",
    );
    expect(
      addressableJid({ remoteJid: "123@lid", remoteJidAlt: "96550123456@s.whatsapp.net" }),
    ).toBe("96550123456@s.whatsapp.net");
    expect(addressableJid({ remoteJid: "123@lid" })).toBeNull();
    expect(addressableJid({ remoteJid: "abc@g.us" })).toBeNull();
    expect(addressableJid({ remoteJid: "status@broadcast" })).toBeNull();
  });
});

describe("maskJid", () => {
  it("keeps only the last four digits out of logs", () => {
    expect(maskJid("96550123456@s.whatsapp.net")).toBe("…3456");
  });
});

describe("collectMessagePage", () => {
  it("reads the v2.3.7 paged envelope and reports pages as the terminator", () => {
    // Stopping on a short page instead of `pages` loops the same ~40 rows.
    const page = collectMessagePage({ messages: { records: [{ id: 1 }], pages: 3 } });
    expect(page.records).toEqual([{ id: 1 }]);
    expect(page.totalPages).toBe(3);
  });

  it("treats a bare array as the complete result immediately", () => {
    // Some deployments skip the envelope; paging on would re-accumulate rows.
    const page = collectMessagePage([{ id: "a" }, { id: "b" }]);
    expect(page.records).toHaveLength(2);
    expect(page.totalPages).toBeNull();
  });

  it("yields an empty single page for malformed payloads", () => {
    expect(collectMessagePage({ nope: true })).toEqual({ records: [], totalPages: 1 });
    expect(collectMessagePage(null)).toEqual({ records: [], totalPages: 1 });
  });
});

describe("history endpoints", () => {
  it("findContacts lives under /chat/, where 2.3.7 actually answers", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, []));
    await clientWith(fetcher).findContacts("danat");
    expect(String(fetcher.mock.calls[0][0])).toBe("http://evo:8080/chat/findContacts/danat");
  });

  it("findMessages filters by remoteJid with the fixed page envelope", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { messages: { records: [] } }));
    await clientWith(fetcher).findMessages("danat", {
      remoteJid: "96550123456@s.whatsapp.net",
      page: 2,
    });
    const body = JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body));
    expect(body).toEqual({
      page: 2,
      offset: 50,
      where: { key: { remoteJid: "96550123456@s.whatsapp.net" } },
    });
  });
});
