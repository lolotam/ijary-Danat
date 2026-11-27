import { z } from "zod";

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::(\d{1,5}))?$/i;

/**
 * يحوّل القيم النصية الفارغة أو المقتصرة على المسافات إلى undefined
 * حتى تعاملها مخططات Zod كمتغيرات غير مضبوطة بدلاً من فشل التحقق.
 */
function emptyToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

/**
 * يلفّ مخطط Zod اختيارياً مع تطبيع السلاسل الفارغة القادمة من ملفات البيئة أو Docker Compose.
 */
function optionalEnv<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(emptyToUndefined, schema.optional());
}

/**
 * يتحقق من أن المفتاح الرئيسي للتكاملات هو سلسلة Base64 صالحة بطول 32 بايت (AES-256-GCM).
 */
function isValidBase64Key32(value: string): boolean {
  if (!value || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").length === 32;
}

/**
 * يتحقق من أن القيمة رابط Redis صالح بالبروتوكول redis:// أو rediss:// مع اسم مضيف.
 */
function isValidRedisUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "redis:" || parsed.protocol === "rediss:") && Boolean(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * يتحقق من أن القيمة رابط HTTP/HTTPS صالح مع اسم مضيف.
 */
function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * يتحقق من أن القيمة اسم مضيف صالح (مع منفذ اختياري) دون بروتوكول أو مسار.
 */
function isValidHost(value: string): boolean {
  const match = HOST_PATTERN.exec(value);
  if (!match) return false;
  if (!match[1]) return true;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535;
}

export const envSchema = z
  .object({
    SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL"),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
    SUPABASE_PUBLISHABLE_KEY: z.string().min(1, "SUPABASE_PUBLISHABLE_KEY is required"),
    SUPABASE_JWT_SECRET: z
      .string()
      .trim()
      .min(32, "SUPABASE_JWT_SECRET must be at least 32 characters long"),
    INTEGRATIONS_MASTER_KEY: z
      .string()
      .trim()
      .refine(
        isValidBase64Key32,
        "INTEGRATIONS_MASTER_KEY must be a base64-encoded 32-byte key (openssl rand -base64 32)",
      ),
    REDIS_URL: z
      .string()
      .trim()
      .refine(isValidRedisUrl, "REDIS_URL must be a valid redis:// or rediss:// URL"),
    PLATFORM_ROOT_HOST: z
      .string()
      .trim()
      .refine(
        isValidHost,
        "PLATFORM_ROOT_HOST must be a valid hostname without protocol or path (e.g. ijary.app)",
      ),
    PLATFORM_ADMIN_HOST: z
      .string()
      .trim()
      .refine(
        isValidHost,
        "PLATFORM_ADMIN_HOST must be a valid hostname without protocol or path (e.g. admin.ijary.app)",
      ),
    TRUST_FORWARDED_HOST: optionalEnv(
      z.enum(["true", "false"], {
        message: "TRUST_FORWARDED_HOST must be 'true' or 'false'",
      }),
    ),
    CRON_SECRET: z.string().min(16, "CRON_SECRET must be at least 16 characters long"),
    MYFATOORAH_API_KEY: optionalEnv(z.string().trim().min(1)),
    MYFATOORAH_WEBHOOK_SECRET: optionalEnv(z.string().trim().min(1)),
    MYFATOORAH_BASE_URL: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .url("MYFATOORAH_BASE_URL must be a valid URL")
        .default("https://api.myfatoorah.com"),
    ),
    // Public origin used to build gateway redirect URLs back into the app.
    APP_BASE_URL: optionalEnv(z.string().url("APP_BASE_URL must be a valid URL")),
    // Platform default email sender (optional until configured; required pair when set).
    PLATFORM_EMAIL_PROVIDER: optionalEnv(
      z.enum(["resend", "smtp"], {
        message: "PLATFORM_EMAIL_PROVIDER must be 'resend' or 'smtp'",
      }),
    ),
    PLATFORM_EMAIL_FROM: optionalEnv(
      z.string().trim().email("PLATFORM_EMAIL_FROM must be a valid email address"),
    ),
    PLATFORM_RESEND_WEBHOOK_SECRET: optionalEnv(
      z.string().trim().min(1, "PLATFORM_RESEND_WEBHOOK_SECRET must not be empty"),
    ),
    RESEND_API_KEY: optionalEnv(z.string().trim().min(1)),
    SMTP_HOST: optionalEnv(z.string().trim().min(1)),
    SMTP_PORT: optionalEnv(z.coerce.number().int().min(1).max(65535)),
    SMTP_USER: optionalEnv(z.string().trim().min(1)),
    SMTP_PASS: optionalEnv(z.string().trim().min(1)),
    // Platform Meta app (WhatsApp Cloud API & Embedded Signup).
    META_APP_ID: optionalEnv(z.string().trim().min(1, "META_APP_ID must not be empty")),
    META_APP_SECRET: optionalEnv(z.string().trim().min(1, "META_APP_SECRET must not be empty")),
    META_EMBEDDED_SIGNUP_CONFIG_ID: optionalEnv(
      z.string().trim().min(1, "META_EMBEDDED_SIGNUP_CONFIG_ID must not be empty"),
    ),
    META_WEBHOOK_VERIFY_TOKEN: optionalEnv(
      z.string().trim().min(1, "META_WEBHOOK_VERIFY_TOKEN must not be empty"),
    ),
    META_GRAPH_API_VERSION: optionalEnv(
      z
        .string()
        .trim()
        .regex(/^v\d+\.\d+$/, "META_GRAPH_API_VERSION must match e.g. v23.0"),
    ),
    // Platform Evolution server (WhatsApp QR).
    EVOLUTION_API_URL: optionalEnv(
      z
        .string()
        .trim()
        .refine(isValidHttpUrl, "EVOLUTION_API_URL must be a valid http:// or https:// URL"),
    ),
    EVOLUTION_API_KEY: optionalEnv(z.string().trim().min(1, "EVOLUTION_API_KEY must not be empty")),
    // Cloudflare zone that hosts the platform, used for the custom-hostname
    // (Cloudflare for SaaS) flow of the custom domains.
    CLOUDFLARE_API_TOKEN: optionalEnv(
      z.string().trim().min(1, "CLOUDFLARE_API_TOKEN must not be empty"),
    ),
    CLOUDFLARE_ZONE_ID: optionalEnv(
      z.string().trim().min(1, "CLOUDFLARE_ZONE_ID must not be empty"),
    ),
  })
  .superRefine((data, ctx) => {
    if (data.PLATFORM_ROOT_HOST.toLowerCase() === data.PLATFORM_ADMIN_HOST.toLowerCase()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PLATFORM_ADMIN_HOST"],
        message: "PLATFORM_ADMIN_HOST must differ from PLATFORM_ROOT_HOST",
      });
    }

    if (data.PLATFORM_EMAIL_PROVIDER && !data.PLATFORM_EMAIL_FROM) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PLATFORM_EMAIL_FROM"],
        message: "PLATFORM_EMAIL_FROM is required when PLATFORM_EMAIL_PROVIDER is set",
      });
    }
    if (data.PLATFORM_EMAIL_FROM && !data.PLATFORM_EMAIL_PROVIDER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PLATFORM_EMAIL_PROVIDER"],
        message: "PLATFORM_EMAIL_PROVIDER is required when PLATFORM_EMAIL_FROM is set",
      });
    }
    if (data.PLATFORM_EMAIL_PROVIDER === "resend" && !data.RESEND_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RESEND_API_KEY"],
        message: "RESEND_API_KEY is required when PLATFORM_EMAIL_PROVIDER is 'resend'",
      });
    }
    if (data.PLATFORM_EMAIL_PROVIDER === "smtp" && !data.SMTP_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SMTP_HOST"],
        message: "SMTP_HOST is required when PLATFORM_EMAIL_PROVIDER is 'smtp'",
      });
    }

    if ((data.META_APP_ID || data.META_EMBEDDED_SIGNUP_CONFIG_ID) && !data.META_APP_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["META_APP_SECRET"],
        message:
          "META_APP_SECRET is required when META_APP_ID or META_EMBEDDED_SIGNUP_CONFIG_ID is set",
      });
    }
    if (data.META_EMBEDDED_SIGNUP_CONFIG_ID && !data.META_APP_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["META_APP_ID"],
        message: "META_APP_ID is required when META_EMBEDDED_SIGNUP_CONFIG_ID is set",
      });
    }

    if (data.EVOLUTION_API_URL && !data.EVOLUTION_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["EVOLUTION_API_KEY"],
        message: "EVOLUTION_API_KEY is required when EVOLUTION_API_URL is set",
      });
    }

    if (data.CLOUDFLARE_API_TOKEN && !data.CLOUDFLARE_ZONE_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CLOUDFLARE_ZONE_ID"],
        message: "CLOUDFLARE_ZONE_ID is required when CLOUDFLARE_API_TOKEN is set",
      });
    }
    if (data.CLOUDFLARE_ZONE_ID && !data.CLOUDFLARE_API_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CLOUDFLARE_API_TOKEN"],
        message: "CLOUDFLARE_API_TOKEN is required when CLOUDFLARE_ZONE_ID is set",
      });
    }
  });

export type ServerEnv = z.infer<typeof envSchema>;

let isValidated = false;

/**
 * يطبّع متغيرات البيئة ويحقق صحتها وفق مخطط الخادم؛ يطبع أسماء الحقول المخالفة فقط دون قيمها.
 *
 * Lovable preview reserves the SUPABASE_ / VITE_ prefixes, so callers set
 * SELF_SUPABASE_* aliases there. Normalise so the schema still validates.
 */
export function parseServerEnv(rawEnv: Record<string, string | undefined>): ServerEnv {
  const env = {
    ...rawEnv,
    SUPABASE_URL: rawEnv.SUPABASE_URL || rawEnv.SELF_SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY:
      rawEnv.SUPABASE_PUBLISHABLE_KEY || rawEnv.SELF_SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY:
      rawEnv.SUPABASE_SERVICE_ROLE_KEY || rawEnv.SELF_SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_JWT_SECRET: rawEnv.SUPABASE_JWT_SECRET || rawEnv.SELF_SUPABASE_JWT_SECRET,
  };

  const result = envSchema.safeParse(env);
  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    console.error("❌ Environment validation failed:");
    console.error(JSON.stringify(errors, null, 2));
    throw new Error(
      `Server environment variables are misconfigured: ${Object.keys(errors).join(", ")}`,
    );
  }
  return result.data;
}

/**
 * يقرأ رمز Cloudflare ومعرّف منطقة المنصة، أو `null` إن لم يُضبطا معاً.
 *
 * The custom-domain flow stays off until the owner provides the zone and a
 * token with the "SSL and Certificates Write" permission (T190 is still open),
 * so a missing pair is a configuration state the caller reports in its own
 * words — not a broken deployment. The names live in the schema above, so the
 * validated names and the read names cannot drift apart.
 */
export function readCloudflareConfig(): { apiToken: string; zoneId: string } | null {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const zoneId = process.env.CLOUDFLARE_ZONE_ID?.trim();
  if (!apiToken || !zoneId) return null;
  return { apiToken, zoneId };
}

/**
 * يعيد ضبط حالة التخزين المؤقت للتحقق من البيئة — مخصص للاختبارات فقط.
 */
export function resetEnvValidationForTest(): void {
  isValidated = false;
}

/**
 * يتحقق من متغيرات بيئة الخادم مرة واحدة عند بدء التشغيل، ويتجاوز الفحص في بيئة الاختبار.
 */
export function validateEnv(): void {
  if (isValidated) return;

  // Skip validation during tests or if explicitly requested via SKIP_ENV_VALIDATION
  if (process.env.VITEST === "true" || process.env.SKIP_ENV_VALIDATION === "true") {
    isValidated = true;
    return;
  }

  parseServerEnv(process.env);
  isValidated = true;
}
