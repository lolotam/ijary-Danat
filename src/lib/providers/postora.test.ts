import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPostoraStatus, listPostoraTemplates, sendWithPostora } from "./postora";
import { stubHungFetch } from "./hungProvider.fixture";
import { PROVIDER_TIMEOUT_MS } from "./types";

const CONFIG = {
  api_base: "https://api.postora.cloud/functions/v1/partner-api",
  api_key_env: "POSTORA_API_KEY",
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function lastCall() {
  const mock = vi.mocked(globalThis.fetch);
  const [url, init] = mock.mock.calls[mock.mock.calls.length - 1] as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) };
}

const template = {
  languageCode: "ar",
  params: ["أحمد", "150.000 KWD"],
  templateName: "danat_receipt_ar",
};

describe("sendWithPostora", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("POSTORA_API_KEY", "pk_live_test");
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("gives up on a provider that never answers instead of hanging the drain", async () => {
    const { fireTimeout, timeoutSpy } = stubHungFetch();

    const send = sendWithPostora(
      { config: CONFIG, from: null, template, to: "+96512345678" },
      "n-1",
    );
    fireTimeout();

    await expect(send).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeoutSpy).toHaveBeenCalledWith(PROVIDER_TIMEOUT_MS);
  });

  it("posts send_template with the key and idempotency headers", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(200, { success: true, message_id: "wamid.ABC", state: "accepted_by_meta" }),
    );

    const result = await sendWithPostora(
      { config: CONFIG, from: null, template, to: "+96512345678" },
      "notification-row-1",
    );

    expect(result.messageId).toBe("wamid.ABC");

    const { url, init, body } = lastCall();
    expect(url).toBe(CONFIG.api_base);
    expect((init.headers as Record<string, string>)["X-Postora-Key"]).toBe("pk_live_test");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("notification-row-1");
    expect(body.action).toBe("send_template");
    expect(body.template_name).toBe("danat_receipt_ar");
    expect(body.template_language).toBe("ar");
    expect(body.recipient_phone).toBe("96512345678");
  });

  it("sends template parameters as ordered body components", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(200, { success: true, message_id: "wamid.ABC" }),
    );

    await sendWithPostora({ config: CONFIG, from: null, template, to: "+96512345678" }, "n-1");

    const { body } = lastCall();
    expect(body.template_components).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "أحمد" },
          { type: "text", text: "150.000 KWD" },
        ],
      },
    ]);
  });

  it("refuses to send without an approved template", async () => {
    await expect(
      sendWithPostora({ config: CONFIG, from: null, template: null, to: "+96512345678" }, "n-1"),
    ).rejects.toThrow(/template/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("surfaces a typed Postora error code in the thrown message", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(422, {
        success: false,
        error: {
          code: "template_not_approved",
          message: "Template rejected by Meta",
          retryable: false,
        },
        request_id: "req-1",
      }),
    );

    await expect(
      sendWithPostora({ config: CONFIG, from: null, template, to: "+96512345678" }, "n-1"),
    ).rejects.toThrow(/template_not_approved/);
  });

  it("includes the Postora request id so failures can be correlated", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(500, {
        success: false,
        error: { code: "internal_error", message: "boom", retryable: true },
        request_id: "req-42",
      }),
    );

    await expect(
      sendWithPostora({ config: CONFIG, from: null, template, to: "+96512345678" }, "n-1"),
    ).rejects.toThrow(/req-42/);
  });

  it("prefers the x-postora-request-id header over the body request_id on failure", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(
        500,
        {
          success: false,
          error: { code: "internal_error", message: "boom", retryable: true },
          request_id: "body-id",
        },
        { "x-postora-request-id": "header-id" },
      ),
    );

    await expect(
      sendWithPostora({ config: CONFIG, from: null, template, to: "+96512345678" }, "n-1"),
    ).rejects.toMatchObject({ requestId: "header-id" });
  });

  it("falls back to the body request_id when the header is absent", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(500, {
        success: false,
        error: { code: "internal_error", message: "boom", retryable: true },
        request_id: "body-only",
      }),
    );

    await expect(
      sendWithPostora({ config: CONFIG, from: null, template, to: "+96512345678" }, "n-1"),
    ).rejects.toMatchObject({ requestId: "body-only" });
  });

  it("logs the request id on success without logging the phone or template params", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(
        200,
        { success: true, message_id: "wamid.OK", request_id: "body-rid" },
        { "x-postora-request-id": "header-rid" },
      ),
    );

    await sendWithPostora({ config: CONFIG, from: null, template, to: "+96512345678" }, "n-1");

    expect(console.info).toHaveBeenCalledWith(
      expect.stringMatching(/\[postora\].*request_id=header-rid/),
    );
    const logged = String(vi.mocked(console.info).mock.calls[0]?.[0] ?? "");
    expect(logged).not.toMatch(/96512345678|أحمد|150\.000|pk_live_test/);
  });

  it("treats an indeterminate send as non-retryable", async () => {
    // The message may already have reached the tenant. Retrying would send a
    // second copy, so this must not look like an ordinary failure.
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(409, {
        success: false,
        error: {
          code: "idempotency_indeterminate",
          message: "may have been delivered",
          retryable: false,
        },
        request_id: "req-9",
      }),
    );

    await expect(
      sendWithPostora({ config: CONFIG, from: null, template, to: "+96512345678" }, "n-1"),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("refuses a recipient that is not in international format", async () => {
    // 7 digits fits no Kuwaiti mobile shape, so no country can be assumed.
    await expect(
      sendWithPostora({ config: CONFIG, from: null, template, to: "1234567" }, "n-1"),
    ).rejects.toThrow(/international/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("getPostoraStatus", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("POSTORA_API_KEY", "pk_live_test");
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("posts get_status without an idempotency key and maps the live response shape", async () => {
    // Ground truth captured from api.postora.cloud (empty secrets, real shape).
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(
        200,
        {
          success: true,
          whatsapp_connected: true,
          phone_number_id: "1097745303431352",
          workspace_id: "fe27a275-943f-4579-b50b-805d42080514",
          request_id: "f4c89a69-status",
        },
        { "x-postora-request-id": "f4c89a69-status" },
      ),
    );

    const status = await getPostoraStatus(CONFIG);

    expect(status).toEqual({
      whatsappConnected: true,
      phoneNumberId: "1097745303431352",
      workspaceId: "fe27a275-943f-4579-b50b-805d42080514",
    });

    const { init, body } = lastCall();
    expect(body).toEqual({ action: "get_status" });
    expect((init.headers as Record<string, string>)["X-Postora-Key"]).toBe("pk_live_test");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
  });

  it("throws a typed PostoraProviderError when the partner rejects the status call", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(
        401,
        {
          success: false,
          error: { code: "invalid_api_key", message: "bad key", retryable: false },
          request_id: "req-status-fail",
        },
        { "x-postora-request-id": "hdr-status-fail" },
      ),
    );

    await expect(getPostoraStatus(CONFIG)).rejects.toMatchObject({
      code: "invalid_api_key",
      requestId: "hdr-status-fail",
    });
  });
});

describe("listPostoraTemplates", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("POSTORA_API_KEY", "pk_live_test");
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("treats an empty templates array as a normal successful result", async () => {
    // Live capture: no Meta-approved templates yet — empty list is expected.
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(200, {
        success: true,
        templates: [],
        request_id: "c17fa0b0-templates",
      }),
    );

    const templates = await listPostoraTemplates(CONFIG);

    expect(templates).toEqual([]);
    const { body, init } = lastCall();
    expect(body).toEqual({ action: "list_templates" });
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
  });

  it("returns the templates array when Postora has entries", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(200, {
        success: true,
        templates: [{ name: "danat_receipt_ar", language: "ar" }],
        request_id: "tpl-1",
      }),
    );

    await expect(listPostoraTemplates(CONFIG)).resolves.toEqual([
      { name: "danat_receipt_ar", language: "ar" },
    ]);
  });
});
