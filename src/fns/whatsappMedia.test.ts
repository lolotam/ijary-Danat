import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn().mockImplementation(() => {
    const fn: any = (input?: { data?: unknown }) =>
      fn._handler({ data: input?.data, context: fn._context });
    fn._context = {
      supabase: { rpc: async () => ({ data: true, error: null }) },
      userId: "admin-user",
    };
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.validator = vi.fn().mockImplementation(() => fn);
    fn.handler = vi.fn().mockImplementation((handler: any) => {
      fn._handler = handler;
      return fn;
    });
    return fn;
  }),
  createMiddleware: vi.fn().mockReturnValue({
    server: vi.fn().mockImplementation((middlewareFn: any) => middlewareFn),
  }),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));

const db = {
  messages: {} as Record<string, Record<string, unknown>>,
  provider: {
    provider: "evolution_api",
    is_enabled: true,
    from_whatsapp: null,
    config: { api_base: "http://evolution:8080", api_key_env: "TEST_EVOLUTION_KEY" },
  } as Record<string, unknown>,
  connection: { instance_name: "danat", last_connection_state: "open" } as Record<string, unknown>,
  /** bucket path → stored file. */
  storage: {} as Record<string, { bytes: Buffer; type: string }>,
  uploads: [] as string[],
  ingested: [] as Record<string, unknown>[],
};

vi.mock("@/integrations/supabase/client.server", () => {
  function builder(table: string) {
    const chain: any = {
      _messageId: null as string | null,
      select: () => chain,
      eq: (column: string, value: string) => {
        if (column === "message_id") chain._messageId = value;
        return chain;
      },
      maybeSingle: () => {
        if (table === "whatsapp_messages")
          return Promise.resolve({ data: db.messages[chain._messageId!] ?? null, error: null });
        if (table === "provider_configs")
          return Promise.resolve({ data: db.provider, error: null });
        if (table === "evolution_connections")
          return Promise.resolve({ data: db.connection, error: null });
        throw new Error(`Unexpected maybeSingle on ${table}`);
      },
    };
    return chain;
  }
  return {
    supabaseAdmin: {
      from: (table: string) => builder(table),
      rpc: vi.fn().mockImplementation((_name: string, args: { p_rows: unknown }) => {
        db.ingested.push(...(args.p_rows as Record<string, unknown>[]));
        return Promise.resolve({ data: 1, error: null });
      }),
      storage: {
        from: () => ({
          download: (path: string) => {
            const file = db.storage[path];
            if (!file) return Promise.resolve({ data: null, error: { message: "not found" } });
            return Promise.resolve({
              data: {
                type: file.type,
                // Slice to the Buffer's own view — .buffer alone is Node's
                // shared pool slab and would leak unrelated bytes.
                arrayBuffer: () =>
                  Promise.resolve(
                    file.bytes.buffer.slice(
                      file.bytes.byteOffset,
                      file.bytes.byteOffset + file.bytes.byteLength,
                    ),
                  ),
              },
              error: null,
            });
          },
          upload: (path: string, bytes: Buffer, opts: { contentType: string }) => {
            db.storage[path] = { bytes, type: opts.contentType };
            db.uploads.push(path);
            return Promise.resolve({ data: { path }, error: null });
          },
        }),
      },
    },
  };
});

import { resetEvolutionPacing } from "@/lib/providers/evolution";
import {
  downloadWhatsAppMedia,
  forwardWhatsAppMessage,
  sendWhatsAppChatMedia,
} from "./whatsappMedia";

const PDF_BASE64 = Buffer.from("%PDF-1.7 fake receipt").toString("base64");

function mediaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    message_id: "wamid-doc",
    chat_number: "96550123456",
    direction: "inbound",
    from_me: false,
    body: null,
    message_type: "document",
    media_type: "document",
    media_id: "wamid-doc",
    media_filename: "receipt.pdf",
    sent_at: "2026-09-01T10:00:00Z",
    status: "sent",
    raw: null,
    created_at: "2026-09-01T10:00:00Z",
    ...overrides,
  };
}

describe("whatsappMedia server fns", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("TEST_EVOLUTION_KEY", "evo-key");
    resetEvolutionPacing();
    db.messages = {};
    db.storage = {};
    db.uploads = [];
    db.ingested = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("serves a download from the bucket cache without calling Evolution", async () => {
    db.messages["wamid-doc"] = mediaRow();
    db.storage["chat/96550123456/wamid-doc/receipt.pdf"] = {
      bytes: Buffer.from("cached-bytes"),
      type: "application/pdf",
    };

    const result = await downloadWhatsAppMedia({ data: { messageId: "wamid-doc" } });

    expect(result).toEqual({
      base64: Buffer.from("cached-bytes").toString("base64"),
      fileName: "receipt.pdf",
      mimeType: "application/pdf",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fetches a cache miss from Evolution and stores it for next time", async () => {
    db.messages["wamid-doc"] = mediaRow();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ base64: PDF_BASE64, mimetype: "application/pdf" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await downloadWhatsAppMedia({ data: { messageId: "wamid-doc" } });

    expect(result.base64).toBe(PDF_BASE64);
    expect(result.mimeType).toBe("application/pdf");
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0][0])).toBe(
      "http://evolution:8080/chat/getBase64FromMediaMessage/danat",
    );
    expect(db.uploads).toEqual(["chat/96550123456/wamid-doc/receipt.pdf"]);
  });

  it("names a nameless image from its MIME type — never a fake '.image' extension", async () => {
    // Regression, 2026-09-01: WhatsApp images carry no filename, and the old
    // fallback produced "<id>.image" — a file nothing on the admin's machine
    // could open.
    db.messages["WAMIDIMG1XYZ"] = mediaRow({
      message_id: "WAMIDIMG1XYZ",
      media_id: "WAMIDIMG1XYZ",
      media_filename: null,
    });
    const imageBase64 = Buffer.from("fake-jpeg-bytes").toString("base64");
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ base64: imageBase64, mimetype: "image/jpeg" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    db.messages["WAMIDIMG1XYZ"].media_type = "image";

    const result = await downloadWhatsAppMedia({ data: { messageId: "WAMIDIMG1XYZ" } });

    expect(result.fileName).toBe("image-wamidimg.jpg");
    expect(result.mimeType).toBe("image/jpeg");
    // Nameless media caches under the constant leaf so the path is computable
    // before the MIME type is known.
    expect(db.uploads).toEqual(["chat/96550123456/WAMIDIMG1XYZ/file"]);
  });

  it("refuses a message that carries no file", async () => {
    db.messages["wamid-text"] = mediaRow({
      message_id: "wamid-text",
      media_type: null,
      media_id: null,
      body: "نص فقط",
    });

    await expect(downloadWhatsAppMedia({ data: { messageId: "wamid-text" } })).rejects.toThrow(
      /no file/i,
    );
  });

  it("serves a sent file from the cache even though its echo never set media_id", async () => {
    // Outbound media rows used to be written with media_id NULL and rely on
    // the webhook echo; if the echo never arrives the bytes are still in the
    // bucket (the delivery layer cached them at send time), so the preview
    // must come from there without a round-trip to Evolution.
    db.messages["sent-stuck"] = mediaRow({
      message_id: "sent-stuck",
      direction: "outbound",
      from_me: true,
      media_id: null,
    });
    db.storage["chat/96550123456/sent-stuck/receipt.pdf"] = {
      bytes: Buffer.from("sent-cached-bytes"),
      type: "application/pdf",
    };

    const result = await downloadWhatsAppMedia({ data: { messageId: "sent-stuck" } });

    expect(result.base64).toBe(Buffer.from("sent-cached-bytes").toString("base64"));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refuses a cache miss with no media_id instead of asking Evolution", async () => {
    db.messages["sent-lost"] = mediaRow({
      message_id: "sent-lost",
      direction: "outbound",
      from_me: true,
      media_id: null,
    });

    await expect(downloadWhatsAppMedia({ data: { messageId: "sent-lost" } })).rejects.toThrow(
      /no file/i,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("sends a composer file via Evolution and caches it under the sent id", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ key: { id: "sent-1" } }), { status: 201 }),
    );
    // The delivery layer records the outbound row; the cache write reads it back.
    db.messages["sent-1"] = mediaRow({ message_id: "sent-1", direction: "outbound" });

    const result = await sendWhatsAppChatMedia({
      data: {
        chatNumber: "+96550123456",
        fileName: "contract.pdf",
        mimeType: "application/pdf",
        base64: PDF_BASE64,
      },
    });

    expect(result.messageId).toBe("sent-1");
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://evolution:8080/message/sendMedia/danat");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      number: "96550123456",
      mediatype: "document",
      media: PDF_BASE64,
      fileName: "contract.pdf",
    });
    expect(db.uploads).toEqual(["chat/96550123456/sent-1/contract.pdf"]);
    // The outbound row carries media_id at send time — the message key id —
    // because the webhook echo that would otherwise set it is not guaranteed.
    expect(db.ingested).toHaveLength(1);
    expect(db.ingested[0]).toMatchObject({
      message_id: "sent-1",
      media_type: "document",
      media_id: "sent-1",
    });
  });

  it("forwards a text message as a plain send to the target chat", async () => {
    db.messages["wamid-text"] = mediaRow({
      message_id: "wamid-text",
      media_type: null,
      media_id: null,
      body: "موعد الصيانة غداً",
    });
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ key: { id: "fwd-1" } }), { status: 201 }),
    );

    await forwardWhatsAppMessage({
      data: { messageId: "wamid-text", toChatNumber: "+96599887766" },
    });

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://evolution:8080/message/sendText/danat");
    expect(JSON.parse(String(init.body))).toEqual({
      number: "96599887766",
      text: "موعد الصيانة غداً",
    });
  });

  it("forwards a cached media message without re-fetching from Evolution", async () => {
    db.messages["wamid-doc"] = mediaRow();
    db.storage["chat/96550123456/wamid-doc/receipt.pdf"] = {
      bytes: Buffer.from("cached-bytes"),
      type: "application/pdf",
    };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ key: { id: "fwd-2" } }), { status: 201 }),
    );

    await forwardWhatsAppMessage({
      data: { messageId: "wamid-doc", toChatNumber: "+96599887766" },
    });

    // Exactly one network call: the send. The file came from the bucket.
    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(1);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://evolution:8080/message/sendMedia/danat");
    const body = JSON.parse(String(init.body));
    expect(body.number).toBe("96599887766");
    expect(body.fileName).toBe("receipt.pdf");
  });
});
