import { createHash } from "node:crypto";

import { z } from "zod";

import type { EmailProviderMessage, ProviderResult } from "@/lib/providers/types";
import { PROVIDER_TIMEOUT_MS, requiredEnv } from "@/lib/providers/types";

const responseSchema = z.object({ id: z.string().min(1) });

/** Resend error bodies carry a machine-readable name plus a message. */
const errorSchema = z.object({
  message: z.string(),
  name: z.string().optional(),
});

function describeFailure(status: number, body: string): string {
  try {
    const parsed = errorSchema.parse(JSON.parse(body));
    const name = parsed.name ? ` [${parsed.name}]` : "";
    return `Resend rejected the message (${status})${name}: ${parsed.message}`;
  } catch {
    return `Resend request failed (${status}): ${body || "no response body"}`;
  }
}

/**
 * يشتق مفتاح منع التكرار من مفتاح الصف وبصمة الحمولة النهائية.
 *
 * Resend answers a reused key whose body differs with 409, and keeps keys for
 * 24 hours. The body is rebuilt on every attempt (current branding, the
 * tenant's current address, whichever attachments downloaded), so a bare row
 * id would dead-end a legitimate retry: an admin fixes a bad address, presses
 * retry, and gets 409 for a day. With the payload hash an identical retry is
 * still recognised, and a changed one goes out as the new message it is.
 */
function requestIdempotencyKey(baseKey: string, payload: Record<string, unknown>): string {
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return `${baseKey}/${digest.slice(0, 32)}`;
}

/**
 * يرسل رسالة بريد عبر Resend ويعيد معرّف الرسالة.
 *
 * Recipients may arrive in any of `to`, `cc` or `bcc`; only the combination
 * being empty is an error. The key is read from the environment variable named
 * in `config`, never from the config itself.
 */
export async function sendWithResend(message: EmailProviderMessage): Promise<ProviderResult> {
  // Read the key first: a missing secret should fail before a request is built,
  // and the error names the environment variable, never its value.
  const apiKey = requiredEnv(message.config, "secret_env");
  if (!message.from.trim()) throw new Error("Resend sender address is not configured.");
  // Any one of the three is enough. Requiring `to` rejected a Bcc-only message,
  // which is exactly the shape "send to all tenants" produces — the compose
  // window has always allowed it, so demanding a visible recipient here made a
  // legitimate send impossible through this provider alone.
  const cc = message.cc?.filter(Boolean) ?? [];
  const bcc = message.bcc?.filter(Boolean) ?? [];
  if (!message.to.length && !cc.length && !bcc.length) {
    throw new Error("Resend requires at least one recipient.");
  }

  const payload: Record<string, unknown> = {
    from: message.from,
    to: message.to,
    subject: message.subject,
    html: message.body,
  };
  // Omitted rather than sent empty: Resend rejects an empty array on these.
  if (cc.length) payload.cc = cc;
  if (bcc.length) payload.bcc = bcc;
  if (message.replyTo?.trim()) payload.reply_to = message.replyTo.trim();
  // The plain-text alternative. Without it a recipient whose client refuses HTML
  // sees an empty message rather than the text the sender actually wrote.
  if (message.text?.trim()) payload.text = message.text;
  if (message.attachments?.length) {
    payload.attachments = message.attachments.map((attachment) => ({
      filename: attachment.filename,
      content:
        typeof attachment.content === "string"
          ? attachment.content
          : attachment.content.toString("base64"),
      // Resend infers a type from the filename when omitted; sending the known
      // type keeps PDF receipts from arriving as application/octet-stream.
      ...(attachment.contentType ? { content_type: attachment.contentType } : {}),
    }));
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(message.idempotencyKey
        ? { "Idempotency-Key": requestIdempotencyKey(message.idempotencyKey, payload) }
        : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(describeFailure(response.status, text));

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Resend returned a response that is not valid JSON.");
  }
  const result = responseSchema.safeParse(parsed);
  if (!result.success) throw new Error("Resend response did not contain a message id.");
  return { messageId: result.data.id };
}
