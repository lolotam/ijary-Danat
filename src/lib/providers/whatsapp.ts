import { z } from "zod";

import type { ProviderResult, WhatsAppProviderMessage } from "@/lib/providers/types";
import {
  configValue,
  postWithoutIdempotency,
  requiredEnv,
  toInternationalDigits,
} from "@/lib/providers/types";

const responseSchema = z.object({
  messages: z.array(z.object({ id: z.string() })).min(1),
});

/** Meta returns structured errors; surface the useful parts, never the request. */
const errorSchema = z.object({
  error: z.object({
    code: z.number().optional(),
    error_subcode: z.number().optional(),
    message: z.string(),
    type: z.string().optional(),
  }),
});

function describeFailure(status: number, body: string): string {
  try {
    const parsed = errorSchema.parse(JSON.parse(body));
    const code = parsed.error.code === undefined ? "" : ` [code ${parsed.error.code}]`;
    return `WhatsApp Cloud API rejected the message (${status})${code}: ${parsed.error.message}`;
  } catch {
    return `WhatsApp Cloud API request failed (${status}): ${body || "no response body"}`;
  }
}

export async function sendWithWhatsApp(message: WhatsAppProviderMessage): Promise<ProviderResult> {
  const phoneNumberId = requiredEnv(message.config, "phone_number_id_env");
  const accessToken = requiredEnv(message.config, "secret_env");
  const apiVersion = configValue(message.config, "graph_api_version") ?? "v23.0";
  const to = toInternationalDigits(message.to);

  // Business-initiated notifications must use an approved template. The name is
  // read from the recorded mapping — it is never derived from our local code,
  // because Meta's approved name is decided by their review.
  const template = message.template ?? null;
  if (!template) {
    throw new Error(
      "WhatsApp Cloud API requires an approved template. No provider template mapping was resolved.",
    );
  }

  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: template.templateName,
      language: { code: template.languageCode },
      ...(template.params.length
        ? {
            components: [
              {
                type: "body",
                parameters: template.params.map((text) => ({ type: "text", text })),
              },
            ],
          }
        : {}),
    },
  };

  const response = await postWithoutIdempotency(
    "WhatsApp Cloud API",
    `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(phoneNumberId)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const text = response.text;
  if (!response.ok) throw new Error(describeFailure(response.status, text));

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("WhatsApp Cloud API returned a response that is not valid JSON.");
  }
  const result = responseSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("WhatsApp Cloud API response did not contain a message id.");
  }
  return { messageId: result.data.messages[0].id };
}
