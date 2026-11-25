import { z } from "zod";

import type { ProviderResult, WhatsAppProviderMessage } from "@/lib/providers/types";
import {
  configValue,
  postWithoutIdempotency,
  requiredEnv,
  toInternationalDigits,
} from "@/lib/providers/types";

const responseSchema = z.object({ sid: z.string().min(1) });

/** Twilio error bodies carry a code and a documentation link. */
const errorSchema = z.object({
  code: z.number().optional(),
  message: z.string(),
});

function describeFailure(status: number, body: string): string {
  try {
    const parsed = errorSchema.parse(JSON.parse(body));
    const code = parsed.code === undefined ? "" : ` [code ${parsed.code}]`;
    return `Twilio rejected the message (${status})${code}: ${parsed.message}`;
  } catch {
    return `Twilio WhatsApp request failed (${status}): ${body || "no response body"}`;
  }
}

function asWhatsAppAddress(value: string): string {
  const trimmed = value.trim();
  const bare = trimmed.startsWith("whatsapp:") ? trimmed.slice("whatsapp:".length) : trimmed;
  return `whatsapp:+${toInternationalDigits(bare)}`;
}

export async function sendWithTwilio(message: WhatsAppProviderMessage): Promise<ProviderResult> {
  const accountSid = requiredEnv(message.config, "account_sid_env");
  const authToken = requiredEnv(message.config, "secret_env");
  const fromEnv = configValue(message.config, "from_whatsapp_env");
  const from = message.from || (fromEnv ? process.env[fromEnv] : null);
  if (!from) throw new Error("Twilio WhatsApp sender (from) is not configured.");

  const params = new URLSearchParams({
    From: asWhatsAppAddress(from),
    To: asWhatsAppAddress(message.to),
  });

  // Twilio rejects a request carrying both ContentSid and Body, so the two modes
  // are exclusive. Business-initiated notifications must use an approved Content
  // template; Body is only valid inside an open customer-service window, which
  // the caller has to assert — it is never assumed.
  if (message.contentSid) {
    params.set("ContentSid", message.contentSid);
    const variables = message.contentVariables ?? {};
    if (Object.keys(variables).length) {
      params.set("ContentVariables", JSON.stringify(variables));
    }
  } else if (message.allowFreeform) {
    const bodyText = (message.body ?? "").trim();
    if (!bodyText) throw new Error("Twilio WhatsApp message body is required.");
    params.set("Body", bodyText);
  } else {
    throw new Error(
      "Twilio requires an approved Content SID for business-initiated messages. " +
        "No Twilio content mapping was resolved for this notification template.",
    );
  }

  const response = await postWithoutIdempotency(
    "Twilio",
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
  );

  const text = response.text;
  if (!response.ok) throw new Error(describeFailure(response.status, text));

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Twilio returned a response that is not valid JSON.");
  }
  const result = responseSchema.safeParse(parsed);
  if (!result.success) throw new Error("Twilio response did not contain a message SID.");
  return { messageId: result.data.sid };
}
