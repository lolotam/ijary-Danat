import { z } from "zod";

import type { Json } from "@/integrations/supabase/database.types";
import type { ProviderResult, WhatsAppProviderMessage } from "@/lib/providers/types";
import {
  configValue,
  PROVIDER_TIMEOUT_MS,
  requiredEnv,
  toInternationalDigits,
} from "@/lib/providers/types";

const successSchema = z.object({
  message_id: z.string(),
  request_id: z.string().optional(),
});

const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().optional(),
    details: z.unknown().optional(),
  }),
  request_id: z.string().optional(),
});

/** Live get_status shape captured from api.postora.cloud (2026-08). */
const statusSuccessSchema = z.object({
  success: z.boolean().optional(),
  whatsapp_connected: z.boolean(),
  phone_number_id: z.string().nullable().optional(),
  workspace_id: z.string(),
  request_id: z.string().optional(),
});

/**
 * list_templates may return Meta template objects of evolving shape; empty list
 * is normal (no approved templates yet) and must not be treated as an error.
 */
const listTemplatesSuccessSchema = z.object({
  success: z.boolean().optional(),
  templates: z.array(z.unknown()),
  request_id: z.string().optional(),
});

export type PostoraStatus = {
  phoneNumberId: string | null;
  whatsappConnected: boolean;
  workspaceId: string;
};

/**
 * خطأ من مزوّد Postora يحمل العقد المُنمّط لواجهة الشريك.
 *
 * `retryable` أهم من الرسالة: مهمة التصريف يجب ألا تُعيد إرسال نتيجة
 * `idempotency_indeterminate`، لأن تلك الرسالة قد تكون وصلت للمستأجر بالفعل.
 *
 * A Postora failure that carries the partner API's typed contract. Only `.code`
 * is persisted (as `notifications.error_code`) and read by the drain job;
 * `.retryable` is carried for callers and tests that reason about the contract
 * directly, and deliberately does not drive the retry decision — that decision
 * keys off the specific code, not a general flag.
 */
export class PostoraProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "PostoraProviderError";
  }
}

/**
 * يستخرج معرّف الطلب مفضّلاً رأس `x-postora-request-id` ثم `request_id` من الجسم.
 *
 * The partner API returns the same id in both places; the header is the
 * correlation handle even when the body is non-JSON (gateway/proxy failure).
 */
function resolveRequestId(
  headerRequestId: string | null,
  bodyRequestId?: string | null,
): string | undefined {
  return headerRequestId || bodyRequestId || undefined;
}

/**
 * يبني خطأً مُنمّطاً من استجابة فشل من Postora، أو خطأً عاماً قابلاً لإعادة
 * المحاولة إذا لم يكن النص JSON صالحاً (بوّابة/وكيل بيننا وبين الدالة).
 *
 * Builds a typed Postora error from a failure response, or a generic retryable
 * error if the body is not valid JSON. A non-JSON body means something between
 * us and the function answered (a gateway or proxy) — treat it as retryable;
 * nothing was confirmed sent. Prefer the response header for request id so
 * success and failure share the same correlation path.
 */
function describeFailure(
  status: number,
  raw: string,
  headerRequestId: string | null = null,
): PostoraProviderError {
  try {
    const parsed = errorSchema.parse(JSON.parse(raw));
    const requestId = resolveRequestId(headerRequestId, parsed.request_id);
    const rid = requestId ? ` [request ${requestId}]` : "";
    return new PostoraProviderError(
      `Postora rejected the message (${status}) [${parsed.error.code}]${rid}: ${parsed.error.message}`,
      parsed.error.code,
      parsed.error.retryable ?? false,
      requestId,
    );
  } catch {
    return new PostoraProviderError(
      `Postora request failed (${status}): ${raw.slice(0, 200) || "no response body"}`,
      "unknown_error",
      true,
      resolveRequestId(headerRequestId),
    );
  }
}

/**
 * يقرأ api_base ومفتاح البيئة من إعداد المزوّد دون كشف السر.
 */
function resolvePostoraCredentials(config: Json): { apiBase: string; apiKey: string } {
  const apiBase = configValue(config, "api_base");
  if (!apiBase) throw new Error("Postora provider config is missing api_base.");
  const apiKey = requiredEnv(config, "api_key_env");
  return { apiBase, apiKey };
}

type PostoraFetchOptions = {
  apiBase: string;
  apiKey: string;
  body: Record<string, unknown>;
  /** send_template only — status/templates must not send one. */
  idempotencyKey?: string;
};

/**
 * ينفّذ POST موحّداً إلى واجهة شريك Postora ويعيد النص ومعرّف الطلب من الرأس.
 *
 * Shared so send / get_status / list_templates share headers and request-id
 * correlation without three near-identical fetch blocks. Callers that never
 * send a message omit idempotencyKey so the header is absent entirely.
 */
async function postoraFetch(options: PostoraFetchOptions): Promise<{
  headerRequestId: string | null;
  ok: boolean;
  raw: string;
  status: number;
}> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Postora-Key": options.apiKey,
  };
  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  const response = await fetch(options.apiBase, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  const raw = await response.text();
  // Fetch normalises header names; get is case-insensitive.
  const headerRequestId = response.headers.get("x-postora-request-id");
  return { ok: response.ok, status: response.status, raw, headerRequestId };
}

/**
 * يُرسل قالب واتساب معتمداً عبر واجهة الشريك من Postora.
 *
 * ليست بديلاً مباشراً عن `sendWithWhatsApp`: تأخذ مفتاح إلغاء التكرار
 * (idempotency key) لأن Postora تتطلبه في كل إرسالة، والغرض الأساسي هو أن
 * حلقة إعادة المحاولة الخاصة بدانات لا يمكنها إرسال رسالتين لنفس المستأجر.
 * مفتاح الإلغاء هو مُعرّف صف الإشعار، لذا تعيد مهمة التصريف نفس المفتاح
 * لتعثر Postora على التكرار بدلاً من إرسال نسخة ثانية.
 *
 * Send an approved WhatsApp template through Postora's partner API. Deliberately
 * NOT a drop-in replacement for sendWithWhatsApp: it takes an idempotency key,
 * because Postora requires one on every send and the whole point is that Danat's
 * own retry loop cannot double-message a tenant.
 */
export async function sendWithPostora(
  message: WhatsAppProviderMessage,
  idempotencyKey: string,
): Promise<ProviderResult> {
  const { apiBase, apiKey } = resolvePostoraCredentials(message.config);

  if (!idempotencyKey) {
    throw new Error("Postora sends require an idempotency key from the caller.");
  }

  // Validate the recipient BEFORE the template check so a malformed number
  // fails the same way it does on the direct-to-Meta path.
  const to = toInternationalDigits(message.to);

  const template = message.template ?? null;
  if (!template) {
    throw new Error(
      "Postora requires an approved template. No provider template mapping was resolved.",
    );
  }

  const { ok, status, raw, headerRequestId } = await postoraFetch({
    apiBase,
    apiKey,
    idempotencyKey,
    body: {
      action: "send_template",
      recipient_phone: to,
      template_name: template.templateName,
      template_language: template.languageCode,
      template_components: template.params.length
        ? [
            {
              type: "body",
              parameters: template.params.map((text) => ({ type: "text", text })),
            },
          ]
        : [],
    },
  });

  if (!ok) throw describeFailure(status, raw, headerRequestId);

  const parsed = successSchema.parse(JSON.parse(raw));
  // Correlation handle for delivered-but-disputed messages; never log phone or
  // template parameters (tenant names and money amounts).
  const requestId = resolveRequestId(headerRequestId, parsed.request_id);
  if (requestId) {
    console.info(
      `[postora] send_template ok request_id=${requestId} message_id=${parsed.message_id}`,
    );
  } else {
    console.info(`[postora] send_template ok message_id=${parsed.message_id}`);
  }
  return { messageId: parsed.message_id };
}

/**
 * يستعلم حالة اتصال واتساب لحساب الشريك في Postora (قراءة فقط، بلا إرسال).
 *
 * No idempotency key: this never creates a message, so there is nothing to
 * deduplicate. Used for admin connectivity checks, not the drain path.
 */
export async function getPostoraStatus(config: Json): Promise<PostoraStatus> {
  const { apiBase, apiKey } = resolvePostoraCredentials(config);
  const { ok, status, raw, headerRequestId } = await postoraFetch({
    apiBase,
    apiKey,
    body: { action: "get_status" },
  });

  if (!ok) throw describeFailure(status, raw, headerRequestId);

  const parsed = statusSuccessSchema.parse(JSON.parse(raw));
  const requestId = resolveRequestId(headerRequestId, parsed.request_id);
  if (requestId) {
    console.info(`[postora] get_status ok request_id=${requestId}`);
  }

  return {
    whatsappConnected: parsed.whatsapp_connected,
    phoneNumberId: parsed.phone_number_id ?? null,
    workspaceId: parsed.workspace_id,
  };
}

/**
 * يسرد قوالب واتساب المعتمدة (أو المسجّلة) لدى Postora؛ القائمة الفارغة نتيجة طبيعية.
 *
 * Empty `templates: []` is expected when no Meta-approved templates exist yet —
 * treat it as success, never as an error. No idempotency key (read-only).
 */
export async function listPostoraTemplates(config: Json): Promise<unknown[]> {
  const { apiBase, apiKey } = resolvePostoraCredentials(config);
  const { ok, status, raw, headerRequestId } = await postoraFetch({
    apiBase,
    apiKey,
    body: { action: "list_templates" },
  });

  if (!ok) throw describeFailure(status, raw, headerRequestId);

  const parsed = listTemplatesSuccessSchema.parse(JSON.parse(raw));
  const requestId = resolveRequestId(headerRequestId, parsed.request_id);
  if (requestId) {
    console.info(
      `[postora] list_templates ok request_id=${requestId} count=${parsed.templates.length}`,
    );
  }

  return parsed.templates;
}
