import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendWithWhatsApp } from "./whatsapp";
import { stubHungFetch } from "./hungProvider.fixture";
import { DELIVERY_INDETERMINATE, PROVIDER_TIMEOUT_MS } from "./types";

const CONFIG = {
  secret_env: "WHATSAPP_ACCESS_TOKEN",
  phone_number_id_env: "WHATSAPP_PHONE_NUMBER_ID",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

/** Last request the module made, decoded. */
function lastCall() {
  const mock = vi.mocked(globalThis.fetch);
  const [url, init] = mock.mock.calls[mock.mock.calls.length - 1] as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) };
}

describe("sendWithWhatsApp", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "meta-token");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "1234567890");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const arabicTemplate = {
    languageCode: "ar",
    params: ["أحمد", "150.000 KWD"],
    templateName: "danat_receipt_ar",
  };

  it("reports a provider that never answers as possibly delivered, not as a plain failure", async () => {
    // No idempotency key exists here, so the drain must not retry a timeout:
    // the provider may have accepted the message after we stopped waiting.
    const { fireTimeout, timeoutSpy } = stubHungFetch();

    const send = sendWithWhatsApp({
      config: CONFIG,
      from: null,
      template: arabicTemplate,
      to: "+96550123456",
    });
    fireTimeout();

    await expect(send).rejects.toMatchObject({ code: DELIVERY_INDETERMINATE });
    expect(timeoutSpy).toHaveBeenCalledWith(PROVIDER_TIMEOUT_MS);
  });

  it("posts an approved template to the Cloud API messages endpoint", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(200, { messages: [{ id: "wamid.ABC" }] }),
    );

    const result = await sendWithWhatsApp({
      config: CONFIG,
      from: null,
      template: arabicTemplate,
      to: "+96550123456",
    });

    const { url, init, body } = lastCall();
    expect(url).toBe("https://graph.facebook.com/v23.0/1234567890/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer meta-token");
    expect(body.messaging_product).toBe("whatsapp");
    expect(body.to).toBe("96550123456");
    expect(body.type).toBe("template");
    expect(result.messageId).toBe("wamid.ABC");
  });

  it("sends the approved name and language verbatim rather than deriving them", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(200, { messages: [{ id: "wamid.1" }] }),
    );

    await sendWithWhatsApp({
      config: CONFIG,
      from: null,
      // Meta approved a name unrelated to the local "receipt-en" code.
      template: { languageCode: "en_US", params: [], templateName: "danat_payment_receipt_v2" },
      to: "+96550123456",
    });

    const { body } = lastCall();
    expect(body.template.name).toBe("danat_payment_receipt_v2");
    expect(body.template.language.code).toBe("en_US");
  });

  it("maps ordered parameters to positional body components", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(200, { messages: [{ id: "wamid.2" }] }),
    );

    await sendWithWhatsApp({
      config: CONFIG,
      from: null,
      template: arabicTemplate,
      to: "+96550123456",
    });

    const { body } = lastCall();
    expect(body.template.components).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "أحمد" },
          { type: "text", text: "150.000 KWD" },
        ],
      },
    ]);
  });

  it("omits the components array when the template takes no parameters", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(200, { messages: [{ id: "wamid.3" }] }),
    );

    await sendWithWhatsApp({
      config: CONFIG,
      from: null,
      template: { languageCode: "ar", params: [], templateName: "danat_notice_ar" },
      to: "+96550123456",
    });

    expect(lastCall().body.template.components).toBeUndefined();
  });

  it("refuses to send without a resolved template mapping", async () => {
    await expect(
      sendWithWhatsApp({ config: CONFIG, from: null, template: null, to: "+96550123456" }),
    ).rejects.toThrow(/requires an approved template/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refuses a recipient that is not in international format", async () => {
    // 7 digits fits no Kuwaiti mobile shape, so no country can be assumed.
    await expect(
      sendWithWhatsApp({ config: CONFIG, from: null, template: arabicTemplate, to: "1234567" }),
    ).rejects.toThrow(/international format/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fails before making a request when the token variable is unset", async () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "");

    await expect(
      sendWithWhatsApp({
        config: CONFIG,
        from: null,
        template: arabicTemplate,
        to: "+96550123456",
      }),
    ).rejects.toThrow(/WHATSAPP_ACCESS_TOKEN is not set/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fails when the phone number id is not configured", async () => {
    await expect(
      sendWithWhatsApp({
        config: { secret_env: "WHATSAPP_ACCESS_TOKEN" },
        from: null,
        template: arabicTemplate,
        to: "+96550123456",
      }),
    ).rejects.toThrow(/missing phone_number_id_env/i);
  });

  it("surfaces the Meta error message and code without the credentials", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(400, {
        error: { code: 132001, message: "Template name does not exist in the translation" },
      }),
    );

    await expect(
      sendWithWhatsApp({
        config: CONFIG,
        from: null,
        template: arabicTemplate,
        to: "+96550123456",
      }),
    ).rejects.toThrow(/\[code 132001\].*Template name does not exist/);
  });

  it("rejects a 2xx response that carries no message id", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(200, { messages: [] }));

    await expect(
      sendWithWhatsApp({
        config: CONFIG,
        from: null,
        template: arabicTemplate,
        to: "+96550123456",
      }),
    ).rejects.toThrow(/did not contain a message id/i);
  });

  it("rejects a 2xx response that is not valid JSON", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("<html>502</html>", { status: 200 }),
    );

    await expect(
      sendWithWhatsApp({
        config: CONFIG,
        from: null,
        template: arabicTemplate,
        to: "+96550123456",
      }),
    ).rejects.toThrow(/not valid JSON/i);
  });
});
