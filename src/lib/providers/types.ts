import type { Json } from "@/integrations/supabase/database.types";
import { normalizePhoneDigits } from "@/lib/kuwaitPhone";
import type { MetaTemplateBinding } from "@/lib/providers/whatsappTemplateBinding";

/**
 * أقصى مدة ننتظرها ردّ مزوّد الإشعارات قبل إلغاء الطلب واعتباره فاشلاً.
 *
 * A bare `fetch` has no timeout: a provider that accepts the connection and
 * never answers holds the request open for as long as the socket lives, and
 * the notification drain processes its batch in sequence, so one hung send
 * stalls every message behind it (audit H13). The payment gateway learned
 * this first (`myfatoorahGateway.ts`); 20s matches its limit. What an aborted
 * send means depends on the provider: one that honours an idempotency key
 * (Resend, Postora) is retried safely by the drain job, within the provider's
 * key lifetime (24 hours for Resend; the drain retries for up to 72); one that
 * does not is
 * recorded as `DELIVERY_INDETERMINATE` and parked for a human, because the
 * provider may have delivered it after we stopped waiting.
 */
export const PROVIDER_TIMEOUT_MS = 20_000;

/**
 * كود فشل يعني أن المزوّد ربما سلّم الرسالة: إعادة المحاولة قد تُرسلها مرتين.
 */
export const DELIVERY_INDETERMINATE = "delivery_indeterminate";

/**
 * خطأ مزوّد يحمل كوداً تقرأه مهمة التصريف لتقرّر: إعادة المحاولة أم المراجعة البشرية.
 *
 * Same contract as PostoraProviderError and EvolutionProviderError: only
 * `.code` is persisted (as `notifications.error_code`) and read by the drain
 * job, for the providers that had no typed error of their own.
 */
export class ProviderDeliveryError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ProviderDeliveryError";
  }
}

/**
 * يرسل طلباً إلى مزوّد لا يدعم مفتاح منع التكرار، ويحوّل انتهاء المهلة إلى "تسليم غير محسوم".
 *
 * Twilio Messages and Meta's Cloud API have no idempotency key. When the
 * timeout fires the request may already have been accepted, so the drain
 * job's usual retry would message the tenant twice (Pass 2 residual). The
 * body is read inside the same guard because the timer also covers the read.
 */
export async function postWithoutIdempotency(
  provider: string,
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch (error) {
    // Bun 1.2 rejects with TimeoutError (checked); AbortError covers runtimes
    // that reject with a plain abort. The timeout is this fetch's only signal.
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ProviderDeliveryError(
        `${provider} did not answer within ${PROVIDER_TIMEOUT_MS / 1000}s; the message may have been delivered.`,
        DELIVERY_INDETERMINATE,
      );
    }
    throw error;
  }
}

export interface EmailAttachment {
  content: Buffer | string;
  contentType?: string;
  filename: string;
}

export interface EmailProviderMessage {
  attachments?: EmailAttachment[];
  /** HTML body. */
  body: string;
  /**
   * Optional so every existing notification caller keeps compiling; only a
   * mailbox send passes these through from the compose window.
   */
  cc?: string[];
  bcc?: string[];
  config: Json;
  from: string;
  replyTo?: string;
  subject: string;
  /**
   * Plain-text alternative sent alongside `body`, never instead of it — a
   * client that refuses HTML otherwise renders an empty message.
   */
  text?: string;
  to: string[];
  /**
   * Notification sends pass the row id. Resend combines it with a hash of the
   * request and deduplicates on that for 24 hours, so a drain retry of a send
   * that timed out after Resend accepted it is recognised instead of delivered
   * twice. SMTP turns it into the Message-ID.
   */
  idempotencyKey?: string;
}

export interface WhatsAppMediaPart {
  /** Raw file content, base64-encoded. */
  base64: string;
  fileName: string;
  mediatype: "audio" | "document" | "image" | "video";
  /**
   * Stored content type for the inbox cache copy. Evolution itself only needs
   * `mediatype`; this is what the bucket object is tagged with so a later
   * download from the inbox opens as a PDF rather than a nameless blob.
   */
  mimeType?: string;
}

export interface WhatsAppProviderMessage {
  /**
   * Free-form text. Only deliverable when `allowFreeform` is true, which means
   * the caller has asserted an open 24-hour customer-service window.
   */
  allowFreeform?: boolean;
  body?: string | null;
  config: Json;
  /** Twilio: approved Content SID and its ordered variables. */
  contentSid?: string | null;
  contentVariables?: Record<string, string> | null;
  from: string | null;
  /**
   * Evolution only: attachments sent as separate media messages after the
   * text part. Other providers ignore this — Meta/Twilio sends stay
   * template-bound and text-only.
   */
  media?: WhatsAppMediaPart[];
  /** Meta Cloud API: approved template name, language and ordered parameters. */
  template?: MetaTemplateBinding | null;
  to: string;
}

export interface ProviderResult {
  messageId: string;
}

export function configValue(config: Json, key: string): string | null {
  if (!config || Array.isArray(config) || typeof config !== "object") return null;
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * يطبّع رقم المستلم إلى أرقام دولية، مع افتراض الكويت للجوّالات المحلية.
 *
 * Providers address recipients in E.164. The rule itself lives in
 * `lib/kuwaitPhone` — shared with the browser-side `toChatNumber` so a number
 * the inbox links to is exactly a number delivery can address. This wrapper
 * adds what the server needs and the browser does not: refusal is an exception,
 * because a send that quietly addresses the wrong number is worse than a
 * failed one.
 */
export function toInternationalDigits(value: string): string {
  const result = normalizePhoneDigits(value);
  if (result.ok) return result.digits;
  if (result.reason === "empty") throw new Error("Recipient WhatsApp number is empty.");
  throw new Error(
    `Recipient WhatsApp number "${value.trim()}" is not in international format. ` +
      "Store it with a country code (for example +965…).",
  );
}

export function requiredEnv(config: Json, key: string): string {
  const envName = configValue(config, key);
  if (!envName) throw new Error(`Provider config is missing ${key}.`);
  const value = process.env[envName];
  if (!value) throw new Error(`Provider secret environment variable ${envName} is not set.`);
  return value;
}
