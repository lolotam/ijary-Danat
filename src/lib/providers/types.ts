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

/**
 * كود فشل الإرسال حين لا يكون للشركة مُرسِل ولا مُرسِل افتراضي للمنصة.
 *
 * Read by the notification drain: retrying cannot configure a sender that does
 * not exist, so the row is parked for a human instead of being sent again.
 */
export const EMAIL_SENDER_NOT_CONFIGURED = "email_sender_not_configured";

/**
 * خطأ إعداد المُرسِل: الشركة بلا مُرسِل خاص، والمنصة بلا مُرسِل افتراضي.
 *
 * Carries the code the drain job reads, exactly like `ProviderDeliveryError`,
 * and extends it so the dispatch persists the code without a second branch.
 * Nothing about the delivery is in doubt here — the message never left.
 */
export class EmailSenderNotConfiguredError extends ProviderDeliveryError {
  /** ينشئ خطأ إعداد مُرسِل برمز قياسي ورسالة توضيحية. */
  constructor(message: string) {
    super(message, EMAIL_SENDER_NOT_CONFIGURED);
    this.name = "EmailSenderNotConfiguredError";
  }
}

/**
 * المفتاح الذي يحمل سرّ المزوّد بعد فك التشفير داخل إعداد المزوّد المُمرَّر للإرسال.
 *
 * The Resend provider opens its API key through `requiredEnv` and nothing else,
 * and that module sits outside the email-sender slice; carrying the decrypted
 * company secret inside the config object reaches it without a second door.
 * The key is underscore-prefixed so it can never collide with a stored config
 * key, and the object is built in memory for one send — it is never written
 * back to the database.
 */
export const DECRYPTED_SECRET_KEY = "__decrypted_secret";

/** اسم مفتاح إعداد المزوّد الذي يحمل المرجع إلى سرّه. */
const SECRET_CONFIG_KEY = "secret_env";

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

/**
 * أسماء متغيّرات البيئة الوحيدة التي يجوز لإعداد مزوّد أن يشير إليها.
 *
 * A company admin can write `provider_configs.config` straight from the browser
 * (policy `provider_configs_admin_all`), so a `*_env` reference is
 * company-controlled input. Without this list, `secret_env:
 * "SUPABASE_SERVICE_ROLE_KEY"` next to the admin's own SMTP host would mail the
 * platform's service key to that host. The names are the ones the seed
 * migrations wrote; anything else is refused.
 */
export const PROVIDER_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "RESEND_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WHATSAPP_FROM",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_WABA_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "EVOLUTION_API_KEY",
  "POSTORA_API_KEY",
  "POSTORA_WHATSAPP_API_KEY",
  "POSTORA_WEBHOOK_SECRET",
]);

/**
 * يقرأ متغيّر بيئة مسموحاً لإعداد مزوّد، ويرفض أي اسم خارج القائمة.
 */
export function readProviderEnv(envName: string): string | null {
  if (!PROVIDER_ENV_ALLOWLIST.has(envName)) {
    throw new Error(`Provider environment reference ${envName} is not allowed.`);
  }
  return process.env[envName]?.trim() || null;
}

/**
 * يتحقق أن عنوان الخدمة هو عنوان المنصة قبل إرسال سرّ المنصة إليه.
 *
 * A secret read from the platform's environment belongs to the platform's own
 * server. A company may store its own base URL, but then it must store its own
 * credential too; otherwise the platform key would travel to the company's host.
 */
export function assertPlatformEndpoint(
  apiBase: string,
  allowed: ReadonlyArray<string | undefined>,
): void {
  const normalized = apiBase.replace(/\/+$/, "");
  const ok = allowed.some((entry) => entry && entry.replace(/\/+$/, "") === normalized);
  if (!ok) {
    throw new Error("A platform credential can only be sent to the platform's own endpoint.");
  }
}

/**
 * يقرأ سرّ مزوّد من مرجع متغيّر البيئة داخل الإعداد، أو من السرّ المشفّر المفكوك.
 *
 * Throws rather than returning an empty value: a send without a key is a
 * configuration fault the caller must name, not a message to drop quietly.
 */
export function requiredEnv(config: Json, key: string): string {
  // The decrypted company secret answers the secret key and nothing else: the
  // host and the port are settings, not secrets, and each keeps coming from
  // where it was configured.
  if (key === SECRET_CONFIG_KEY) {
    const decrypted = configValue(config, DECRYPTED_SECRET_KEY);
    if (decrypted) return decrypted;
  }
  const envName = configValue(config, key);
  if (!envName) throw new Error(`Provider config is missing ${key}.`);
  const value = readProviderEnv(envName);
  if (!value) throw new Error(`Provider secret environment variable ${envName} is not set.`);
  return value;
}

/**
 * يقرأ سرّ المزوّد: السرّ المشفّر والمفكوك داخل الإعداد، وإلا متغيّر البيئة المشار إليه.
 *
 * The two sources are ordered, not interchangeable: a company that stored its
 * own credential must send with it, and the platform's environment variable is
 * the fallback for the rows that were seeded before `company_secrets` existed.
 */
export function providerSecret(config: Json): string | null {
  const decrypted = configValue(config, DECRYPTED_SECRET_KEY);
  if (decrypted) return decrypted;
  const envName = configValue(config, SECRET_CONFIG_KEY);
  if (!envName) return null;
  return readProviderEnv(envName);
}

/**
 * يقرأ إعداد مزوّد: قيمةٌ مباشرة في الإعداد، وإلا متغيّر البيئة الذي يشير إليه `<key>_env`.
 *
 * The two shapes coexist on purpose. The platform's own rows were seeded with
 * environment references, and a company that configures its own sender stores
 * plain settings (`host`, `port`, `user`) next to its encrypted credential.
 */
export function providerSetting(config: Json, key: string): string | null {
  const direct = configValue(config, key);
  if (direct) return direct;
  const envName = configValue(config, `${key}_env`);
  if (!envName) return null;
  return readProviderEnv(envName);
}
