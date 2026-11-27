import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { decodeByteaHex } from "@/gateways/connectionStore.server";
import type { Database, Json, LocaleCode, Tables } from "@/integrations/supabase/database.types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/fns/requirePermission";
import {
  configValue,
  DECRYPTED_SECRET_KEY,
  EmailSenderNotConfiguredError,
} from "@/lib/providers/types";
import { decryptSecret } from "@/lib/secrets.server";

/*
 * مُرسِل البريد لكل شركة (قصة المستخدم 10).
 *
 * Three sources, in this order:
 *   1. the company's own sender — an enabled `provider_configs` row whose
 *      credential lives encrypted in `company_secrets` (owner_kind `email`);
 *   2. the platform's default sender — the environment configuration, used by
 *      every company that has no sender of its own;
 *   3. nothing — the send is refused with a clear reason, and the row is
 *      never retried, because no retry configures a sender that is not there.
 *
 * The platform sender shows the company's name as the display name and the
 * company's address as the reply-to, so the renter sees their landlord rather
 * than the platform's no-reply address (FR-068).
 *
 * The credential is decrypted here, at the moment of use, and the status
 * function that feeds the settings screen returns the sender address and
 * nothing else.
 */

/** المزوّدان اللذان يرسلان البريد. */
const EMAIL_PROVIDERS = ["resend", "smtp"] as const;

export type EmailProviderKind = (typeof EMAIL_PROVIDERS)[number];

/**
 * اسم السر الذي يحمله كل مزوّد في `company_secrets`.
 *
 * Migration 332 documents the convention; the row's `owner_id` is the
 * `provider_configs` row that owns the sender.
 */
const EMAIL_SECRET_NAMES: Record<EmailProviderKind, string> = {
  resend: "api_key",
  smtp: "password",
};

/** اسم سرّ توقيع 웹 هوك Resend داخل `company_secrets`. */
export const RESEND_WEBHOOK_SECRET_NAME = "webhook_secret";

/**
 * إعداد كل مزوّد في المُرسِل الافتراضي للمنصة: متغيّرات البيئة التي تحمله.
 *
 * The platform's own credential never enters `company_secrets`: it belongs to
 * the platform, not to a company, and the environment is where it already is.
 */
const PLATFORM_PROVIDER_CONFIG: Record<EmailProviderKind, Json> = {
  resend: { secret_env: "RESEND_API_KEY" },
  smtp: {
    host_env: "SMTP_HOST",
    port_env: "SMTP_PORT",
    user_env: "SMTP_USER",
    secret_env: "SMTP_PASS",
  },
};

/** كيف يرسل الشركة بريدها. */
export type EmailSenderMode = "own" | "platform" | "none";

/**
 * حالة مُرسِل البريد كما تُعرض في إعدادات الإشعارات: بلا أي سرّ.
 */
export interface EmailSenderStatus {
  /** `own`: مُرسِل الشركة، `platform`: مُرسّل المنصة، `none`: لا مُرسّل. */
  mode: EmailSenderMode;
  /** العنوان الذي تُرسَل منه الرسالة، أو null إن لم يكن هناك مُرسّل. */
  from: string | null;
  /** عنوان الشركة الذي تصل إليه الردود. */
  replyTo: string | null;
}

/** مزوّد جاهز للإرسال: إعداداته وبيانات اعتماده مفكوكة التشفير. */
export interface EmailSenderProvider {
  provider: EmailProviderKind;
  /** إعدادات المزوّد، وفيها سرّ الشركة بعد فك التشفير. */
  config: Json;
  /** العنوان الذي تُرسَل منه الرسالة. */
  from: string;
}

/** المُرسِل المحسوم للشركة: من يرسل، ومن أين، وإلى أين تصل الردود. */
export interface ResolvedEmailSender {
  mode: EmailSenderMode;
  /** المزوّدون بالترتيب: الأساسي أولاً، ثم الاحتياطي. */
  providers: EmailSenderProvider[];
  from: string | null;
  replyTo: string | null;
}

/** صف مُرسِل البريد، ومعه عمود إصدار الأسرار الذي يضيفه الترحيل 332. */
export type EmailProviderRow = Tables<"provider_configs">;

/** هوية الشركة التي يحتاجها المُرسِل: الاسم الذي يُعرض، والعنوان الذي تُرد إليه. */
interface CompanyIdentity {
  displayName: string;
  email: string | null;
}

/** ما خطّته وحدة الإرسال قبل فكّ الأسرار: من يرسل، وبأي مزوّد. */
interface SenderPlan {
  mode: EmailSenderMode;
  from: string | null;
  replyTo: string | null;
  /** صفوف مُرسّل الشركة، الأساسي أولاً. */
  ownRows: EmailProviderRow[];
  /** مزوّد المنصة حين يكون المُرسّل الافتراضي هو الساري. */
  platform: EmailProviderKind | null;
}

/**
 * يقرأ اسم الشركة وعنوانها: الاسم يُعرض على الرسالة، والعنوان تصل إليه الردود.
 */
async function readCompanyIdentity(
  db: SupabaseClient<Database>,
  companyId: string,
  locale: LocaleCode,
): Promise<CompanyIdentity> {
  const { data, error } = await db
    .from("companies")
    .select("name_ar, name_en, email")
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw new Error(`company identity read failed: ${error.message}`);
  if (!data) throw new Error(`company identity read failed: company ${companyId} not found`);
  return {
    displayName: (locale === "en" ? data.name_en : data.name_ar) || data.name_ar,
    email: data.email?.trim() || null,
  };
}

/**
 * يبني عنوان المُرسِل بصيغة «الاسم <العنوان>»، مع تهريب علامات الاقتباس.
 *
 * The display name is the company's own, so a renter sees who wrote to them.
 */
function displayFrom(displayName: string, address: string): string {
  const escaped = displayName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}" <${address}>`;
}

/**
 * يقرأ مُرسّل المنصة من البيئة، أو null إن لم يكن مُرسّل افتراضي مُهيّأ.
 *
 * Both variables are optional: the owner of the platform has not chosen an
 * address yet, and until they do a company without a sender of its own has
 * nowhere to send from — the send says so instead of pretending to have
 * delivered.
 */
function platformSender(): { address: string; provider: EmailProviderKind } | null {
  const provider = process.env.PLATFORM_EMAIL_PROVIDER;
  const address = process.env.PLATFORM_EMAIL_FROM?.trim();
  if ((provider !== "resend" && provider !== "smtp") || !address) return null;
  return { address, provider };
}

/**
 * يخطّط الإرسال: مُرسّل الشركة إن وُجد، وإلا مُرسّل المنصة، وإلا لا مُرسّل.
 */
async function planSender(
  db: SupabaseClient<Database>,
  companyId: string,
  locale: LocaleCode,
  ownProviders: EmailProviderRow[],
): Promise<SenderPlan> {
  const identity = await readCompanyIdentity(db, companyId, locale);

  if (ownProviders.length) {
    const first = ownProviders[0];
    const from =
      first.from_email?.trim() ||
      process.env[first.provider === "resend" ? "RESEND_FROM" : "SMTP_FROM"]?.trim() ||
      "";
    return { mode: "own", from, replyTo: identity.email, ownRows: ownProviders, platform: null };
  }

  const platform = platformSender();
  if (!platform) {
    return { mode: "none", from: null, replyTo: identity.email, ownRows: [], platform: null };
  }
  return {
    mode: "platform",
    from: displayFrom(identity.displayName, platform.address),
    replyTo: identity.email,
    ownRows: [],
    platform: platform.provider,
  };
}

/**
 * يقرأ سرّ الشركة من `company_secrets` ويفكّ تشفيره، أو null إن لم يوجد.
 *
 * The credential is stored per provider row and per version, exactly like the
 * payment gateways' credentials (migration 319), so a rotated secret never
 * leaves the previous version readable by the running send.
 */
async function readCompanySecret(
  db: SupabaseClient<Database>,
  ownerId: string,
  name: string,
  version: number,
): Promise<string | null> {
  const { data, error } = await db
    .from("company_secrets")
    .select("ciphertext, iv, auth_tag, key_version")
    .eq("owner_kind", "email")
    .eq("owner_id", ownerId)
    .eq("name", name)
    .eq("version", version);
  if (error) throw new Error(`company secret read failed: ${error.message}`);

  const row = (data ?? [])[0];
  if (!row) return null;
  return decryptSecret({
    ciphertext: decodeByteaHex(row.ciphertext),
    iv: decodeByteaHex(row.iv),
    authTag: decodeByteaHex(row.auth_tag),
    keyVersion: row.key_version,
  });
}

/**
 * يبني إعدادات مزوّد الشركة: سرّه المشفّر مفكوك، أو مرجع البيئة إن لم يكن له سرّ خاص.
 *
 * `secrets_version` says which credential the row sends with: zero — the row
 * the platform seeded, which still points at the platform's environment
 * variable — or the version of the company's own encrypted credential. The
 * read is skipped in the first case, so a row that never stored a credential
 * of its own touches no secret at all.
 */
async function ownProvider(
  db: SupabaseClient<Database>,
  row: EmailProviderRow,
): Promise<EmailSenderProvider> {
  const provider = row.provider as EmailProviderKind;
  const version = row.secrets_version ?? 0;
  const secret =
    version > 0 ? await readCompanySecret(db, row.id, EMAIL_SECRET_NAMES[provider], version) : null;
  const base = (row.config ?? {}) as Record<string, unknown>;
  if (!secret && !configValue(base as Json, "secret_env")) {
    // A sender with no credential at all cannot authenticate, and no retry
    // gives it one: the company has to store the key in Settings →
    // Notifications, or go back to the platform's default sender.
    throw new EmailSenderNotConfiguredError(
      `The company's ${provider} sender has no credential. Store it in Settings → Notifications, or disable that sender to use the platform's default sender.`,
    );
  }
  const config = (secret ? { ...base, [DECRYPTED_SECRET_KEY]: secret } : base) as Json;
  const from =
    row.from_email?.trim() ||
    process.env[provider === "resend" ? "RESEND_FROM" : "SMTP_FROM"]?.trim() ||
    "";
  return { provider, config, from };
}

/**
 * يحسم مُرسِل البريد للشركة مع أسرارها مفكوكة، جاهزاً للإرسال.
 *
 * The company's own sender wins; a company without one sends through the
 * platform's default sender, showing the company's name and reply address.
 * `mode: "none"` means nothing is configured — the caller must refuse the send
 * rather than drop the message.
 */
export async function resolveEmailSender(input: {
  companyId: string;
  locale: LocaleCode;
  ownProviders: EmailProviderRow[];
}): Promise<ResolvedEmailSender> {
  const db = companyClient(input.companyId);
  const plan = await planSender(db, input.companyId, input.locale, input.ownProviders);

  if (plan.mode === "own") {
    const providers = await Promise.all(plan.ownRows.map((row) => ownProvider(db, row)));
    return { mode: "own", providers, from: plan.from, replyTo: plan.replyTo };
  }

  if (plan.mode === "platform" && plan.platform) {
    return {
      mode: "platform",
      providers: [
        {
          provider: plan.platform,
          config: PLATFORM_PROVIDER_CONFIG[plan.platform],
          from: plan.from ?? "",
        },
      ],
      from: plan.from,
      replyTo: plan.replyTo,
    };
  }

  return { mode: "none", providers: [], from: null, replyTo: plan.replyTo };
}

/**
 * يقرأ حالة مُرسِل البريد للشركة: هل تملك مُرسّلاً، ومن أين ترسل، وأين تصل الردود.
 *
 * The status never carries a secret: it exists so the settings screen can say
 * which sender is in use, and the credential stays where it was written.
 */
export async function getEmailSenderStatus(
  companyId: string,
  locale: LocaleCode,
): Promise<EmailSenderStatus> {
  const db = companyClient(companyId);
  const { data, error } = await db
    .from("provider_configs")
    .select("*")
    .eq("is_enabled", true)
    .in("provider", [...EMAIL_PROVIDERS]);
  if (error) throw new Error(`provider_configs read failed: ${error.message}`);

  const plan = await planSender(db, companyId, locale, (data ?? []) as EmailProviderRow[]);
  return { mode: plan.mode, from: plan.from, replyTo: plan.replyTo };
}

const statusInput = z.object({ locale: z.enum(["ar", "en"]) });

/**
 * يُعيد حالة مُرسِل البريد للشركة الحالية، وصلاحية التكاملات شرط لقراءتها.
 *
 * A server function rather than a browser read: whether the platform's default
 * sender is configured is a fact about the server's environment, and the
 * browser cannot know it.
 */
export const emailSenderStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => statusInput.parse(input))
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "settings.integrations",
      attempted: "email_sender.status",
      refusal: "Forbidden: you do not have permission to view the email sender.",
    });
    return getEmailSenderStatus(requireRequestCompany().id, data.locale);
  });
