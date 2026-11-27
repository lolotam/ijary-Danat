import type { EmailProviderMessage, ProviderResult } from "@/lib/providers/types";
import {
  configValue,
  DECRYPTED_SECRET_KEY,
  DELIVERY_INDETERMINATE,
  PROVIDER_TIMEOUT_MS,
  ProviderDeliveryError,
  providerSecret,
  providerSetting,
  readProviderEnv,
} from "@/lib/providers/types";
import { stripMarkup } from "@/lib/templateRender";

/**
 * يبني Message-ID ثابتاً من مفتاح منع التكرار، على نطاق المُرسِل.
 *
 * SMTP has no idempotency key. A stable Message-ID is the closest thing: a
 * retry after a timeout carries the same id, and Gmail and most mail stores
 * collapse a second copy with an id they have already filed. Returns undefined
 * (nodemailer then generates one) when there is no key or no sender domain.
 */
function stableMessageId(from: string, idempotencyKey?: string): string | undefined {
  const domain = /@([^\s>]+)>?\s*$/.exec(from)?.[1];
  return idempotencyKey && domain ? `<${idempotencyKey}@${domain}>` : undefined;
}

/**
 * يحدّد هل انتهت مهلة SMTP بعد احتمال قبول الخادم للرسالة (فلا تُعاد تلقائياً).
 *
 * nodemailer reports three timeouts with code ETIMEDOUT. "Connection timeout"
 * and "Greeting never received" happen before any mail is handed over, so a
 * retry is safe. The socket idle "Timeout" can fire mid-transaction, after the
 * server has accepted the message but before its reply reached us. Anything
 * that is not one of the two safe ones is treated as ambiguous.
 */
function isAmbiguousTimeout(error: unknown): boolean {
  if (!(error instanceof Error) || (error as { code?: string }).code !== "ETIMEDOUT") return false;
  return !/connection timeout|greeting never received/i.test(error.message);
}

/**
 * يرسل رسالة بريد عبر خادم SMTP ويعيد معرّف الرسالة.
 *
 * The host, the port and the user come from the provider config — either
 * written directly by the company that owns the sender or read through the
 * environment reference the platform's own rows were seeded with. The password
 * comes from the encrypted company secret when there is one, and from the
 * environment otherwise.
 */
export async function sendWithSmtp(message: EmailProviderMessage): Promise<ProviderResult> {
  const nodemailer = (await import("nodemailer")).default;
  const host = providerSetting(message.config, "host");
  if (!host) throw new Error("SMTP host is not configured.");
  // The platform's SMTP password may only go to the platform's SMTP host: a
  // company that types its own host must store its own password as well.
  if (!configValue(message.config, DECRYPTED_SECRET_KEY) && configValue(message.config, "host")) {
    throw new Error("A platform credential can only be sent to the platform's own endpoint.");
  }
  // The port may be written directly or named through `port_env`. An unset
  // variable used to make the port NaN and the send fail loudly, and that is
  // still the safer reading than quietly defaulting to 587.
  const portValue = configValue(message.config, "port");
  const portEnvName = configValue(message.config, "port_env");
  const port = portValue
    ? Number(portValue)
    : portEnvName
      ? Number(readProviderEnv(portEnvName) ?? Number.NaN)
      : 587;
  if (!Number.isFinite(port)) throw new Error("SMTP port is invalid.");
  const user = providerSetting(message.config, "user") ?? undefined;
  const pass = providerSecret(message.config) ?? undefined;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
    // nodemailer's defaults are 2 minutes to connect and 10 minutes of socket
    // silence, long enough to stall the whole notification drain (audit H13).
    // The socket limit is idle time, not total time, so a large PDF upload
    // that keeps sending bytes is not cut off by it.
    connectionTimeout: PROVIDER_TIMEOUT_MS,
    greetingTimeout: PROVIDER_TIMEOUT_MS,
    socketTimeout: PROVIDER_TIMEOUT_MS * 3,
  });

  const info = await transporter
    .sendMail({
      from: message.from,
      to: message.to.join(", "),
      subject: message.subject,
      messageId: stableMessageId(message.from, message.idempotencyKey),
      html: message.body,
      // stripMarkup, not a bare tag regex: it exists because that crude version
      // already shipped broken plain-text to tenants — no line breaks, raw
      // `&amp;` entities (audit M33).
      text: stripMarkup(message.body),
      // The reply address is the company's own, so an answer reaches the office
      // rather than the no-reply address the message was sent from.
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      attachments: message.attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
      })),
    })
    .catch((error: unknown) => {
      if (!isAmbiguousTimeout(error)) throw error;
      throw new ProviderDeliveryError(
        "The SMTP server stopped answering mid-send; the message may have been delivered.",
        DELIVERY_INDETERMINATE,
      );
    });

  return { messageId: info.messageId || `smtp-${Date.now()}` };
}
