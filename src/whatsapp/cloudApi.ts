import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { decodeByteaHex } from "@/gateways/connectionStore.server";
import type { Database } from "@/integrations/supabase/database.types";
import {
  ProviderDeliveryError,
  postWithoutIdempotency,
  toInternationalDigits,
} from "@/lib/providers/types";
import {
  isMappedIdentifier,
  type MetaTemplateBinding,
} from "@/lib/providers/whatsappTemplateBinding";
import { decryptSecret } from "@/lib/secrets.server";

/*
 * مرسل رسائل WhatsApp Cloud API لكل شركة: يقرأ الاتصال السحابي النشط ورمز الوصول المشفّر،
 * ويتحقق من نافذة الـ 24 ساعة والقالب المعتمد قبل الإرسال عبر Graph API.
 */

/** إصدار Graph API المعتمد لرسائل Meta (راجع research.md R15). */
export const META_GRAPH_API_VERSION = "v23.0";

const CUSTOMER_WINDOW_MS = 24 * 60 * 60 * 1000;

/** رموز الأخطاء غير القابلة لإعادة المحاولة عند الإرسال عبر Cloud API. */
export type CloudApiErrorCode =
  | "CLOUD_CONNECTION_NOT_ACTIVE"
  | "ACCESS_TOKEN_MISSING"
  | "OUTSIDE_CUSTOMER_WINDOW"
  | "TEMPLATE_NOT_APPROVED"
  | "EMPTY_MESSAGE";

/**
 * خطأ إرسال Cloud API غير قابل لإعادة المحاولة (غياب الاتصال أو الرمز أو القالب أو انتهاء النافذة).
 */
export class CloudApiSendError extends ProviderDeliveryError {
  readonly retryable = false as const;

  /** ينشئ خطأ Cloud API برمز قياسي ورسالة واضحة. */
  constructor(code: CloudApiErrorCode, message: string) {
    super(message, code);
    this.name = "CloudApiSendError";
  }
}

/** مدخلات إرسال رسالة عبر اتصال Cloud API النشط للشركة. */
export interface CloudApiSendInput {
  companyId: string;
  to: string;
  template?: MetaTemplateBinding;
  text?: string;
}

/** تبعيات قابلة للحقن للاختبار (عميل الشركة والساعة). */
export interface CloudApiSendDeps {
  db?: SupabaseClient<Database>;
  now?: () => Date;
}

/** نتيجة الإرسال الناجح عبر Cloud API. */
export interface CloudApiSendResult {
  messageId: string;
  connectionId: string;
}

const graphSuccessSchema = z.object({
  messages: z.array(z.object({ id: z.string() })).min(1),
});

const graphErrorSchema = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string(),
  }),
});

/**
 * يصف رفض Graph API برسالة واضحة دون تسريب بيانات الاعتماد.
 */
function describeGraphFailure(status: number, rawBody: string): string {
  try {
    const parsed = graphErrorSchema.parse(JSON.parse(rawBody));
    const code = parsed.error.code === undefined ? "" : ` [code ${parsed.error.code}]`;
    return `WhatsApp Cloud API rejected the message (${status})${code}: ${parsed.error.message}`;
  } catch {
    return `WhatsApp Cloud API request failed (${status}): ${rawBody || "no response body"}`;
  }
}

/**
 * يحمّل اتصال Cloud API النشط للشركة مع معرّف رقم الهاتف الخاص به.
 */
async function loadActiveCloudConnection(
  db: SupabaseClient<Database>,
): Promise<{ id: string; phoneNumberId: string }> {
  const { data, error } = await db
    .from("whatsapp_connections")
    .select("id, phone_number_id")
    .eq("is_active", true)
    .in("method", ["cloud_api", "cloud_coexistence"])
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load active Cloud API connection: ${error.message}`);
  }
  if (!data || !data.phone_number_id) {
    throw new CloudApiSendError(
      "CLOUD_CONNECTION_NOT_ACTIVE",
      "No active WhatsApp Cloud API connection with phone_number_id is configured for this company.",
    );
  }
  return { id: data.id, phoneNumberId: data.phone_number_id };
}

/**
 * يقرأ ويفك تشفير رمز الوصول (`access_token`) الأحدث للاتصال من `company_secrets`.
 */
async function loadCloudAccessToken(
  db: SupabaseClient<Database>,
  connectionId: string,
): Promise<string> {
  const { data, error } = await db
    .from("company_secrets")
    .select("ciphertext, iv, auth_tag, key_version")
    .eq("owner_kind", "whatsapp")
    .eq("owner_id", connectionId)
    .eq("name", "access_token")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load Cloud API access_token: ${error.message}`);
  }
  if (!data) {
    throw new CloudApiSendError(
      "ACCESS_TOKEN_MISSING",
      "WhatsApp Cloud API access_token secret is not configured for this connection.",
    );
  }

  return decryptSecret({
    ciphertext: decodeByteaHex(data.ciphertext),
    iv: decodeByteaHex(data.iv),
    authTag: decodeByteaHex(data.auth_tag),
    keyVersion: data.key_version,
  });
}

/**
 * يتحقق من أن المستلم أرسل رسالة واردة خلال آخر 24 ساعة على نفس الاتصال (نافذة خدمة العملاء).
 */
async function isInsideCustomerWindow(
  db: SupabaseClient<Database>,
  connectionId: string,
  chatNumber: string,
  now: Date,
): Promise<boolean> {
  const { data, error } = await db
    .from("whatsapp_messages")
    .select("sent_at")
    .eq("connection_id", connectionId)
    .eq("chat_number", chatNumber)
    .eq("direction", "inbound")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to check 24-hour customer window: ${error.message}`);
  }
  if (!data?.sent_at) return false;
  const elapsedMs = now.getTime() - Date.parse(data.sent_at);
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= CUSTOMER_WINDOW_MS;
}

/**
 * يتحقق من أن اسم القالب مسجّل ومعتمد في جدول `notification_templates` للشركة.
 */
async function assertApprovedTemplate(
  db: SupabaseClient<Database>,
  templateName: string,
): Promise<void> {
  if (!isMappedIdentifier(templateName)) {
    throw new CloudApiSendError(
      "TEMPLATE_NOT_APPROVED",
      `WhatsApp template "${templateName}" is not approved.`,
    );
  }
  const { data, error } = await db
    .from("notification_templates")
    .select("provider_template_name")
    .eq("provider_template_name", templateName.trim())
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to verify approved template: ${error.message}`);
  }
  if (!data?.provider_template_name) {
    throw new CloudApiSendError(
      "TEMPLATE_NOT_APPROVED",
      `WhatsApp template "${templateName}" is not in the company's approved templates list.`,
    );
  }
}

/**
 * يبني جسم طلب Meta Graph API لقالب معتمد أو لنص حر.
 */
function buildGraphMessageBody(
  to: string,
  input: Pick<CloudApiSendInput, "template" | "text">,
): Record<string, unknown> {
  if (input.template) {
    const { template } = input;
    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: template.templateName.trim(),
        language: { code: template.languageCode },
        ...(template.params.length > 0
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
  }

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: (input.text ?? "").trim() },
  };
}

/**
 * يرسل رسالة واتساب عبر اتصال Cloud API النشط للشركة، مع فرض قاعدة نافذة الـ 24 ساعة والقوالب المعتمدة.
 */
export async function sendCloudApiMessage(
  input: CloudApiSendInput,
  deps: CloudApiSendDeps = {},
): Promise<CloudApiSendResult> {
  const db = deps.db ?? companyClient(input.companyId);
  const now = (deps.now ?? (() => new Date()))();
  const to = toInternationalDigits(input.to);

  if (!input.template && !(input.text ?? "").trim()) {
    throw new CloudApiSendError(
      "EMPTY_MESSAGE",
      "WhatsApp Cloud API requires either an approved template or a non-empty text body.",
    );
  }

  const connection = await loadActiveCloudConnection(db);
  const accessToken = await loadCloudAccessToken(db, connection.id);

  if (input.template) {
    await assertApprovedTemplate(db, input.template.templateName);
  } else {
    const inWindow = await isInsideCustomerWindow(db, connection.id, to, now);
    if (!inWindow) {
      throw new CloudApiSendError(
        "OUTSIDE_CUSTOMER_WINDOW",
        "Outside the 24-hour customer-service window; an approved WhatsApp template is required.",
      );
    }
  }

  const body = buildGraphMessageBody(to, input);
  const response = await postWithoutIdempotency(
    "WhatsApp Cloud API",
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${encodeURIComponent(connection.phoneNumberId)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    throw new Error(describeGraphFailure(response.status, response.text));
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(response.text);
  } catch {
    throw new Error("WhatsApp Cloud API returned a response that is not valid JSON.");
  }

  const parsed = graphSuccessSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error("WhatsApp Cloud API response did not contain a message id.");
  }

  return {
    messageId: parsed.data.messages[0].id,
    connectionId: connection.id,
  };
}
