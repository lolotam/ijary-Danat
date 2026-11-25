import type { Json, LocaleCode } from "@/integrations/supabase/database.types";

/**
 * Resolves the provider-side template identifiers for a WhatsApp notification.
 *
 * A business-initiated WhatsApp message must name a template the provider has
 * approved. That name lives in the provider's namespace and is decided by their
 * review, so it is recorded on the notification_templates row (migration 38)
 * rather than derived from our local `code`.
 *
 * Resolution returns a reason instead of throwing: dispatch collects reasons per
 * channel so a `channel: "both"` notification can still report a delivered email
 * leg alongside an undeliverable WhatsApp leg.
 */

/** The mapping columns added by migration 38. */
export interface ProviderTemplateMapping {
  allow_freeform: boolean | null;
  provider_language_code: string | null;
  provider_param_keys: string[] | null;
  provider_template_name: string | null;
  twilio_content_sid: string | null;
  twilio_variable_keys: string[] | null;
}

export interface MetaTemplateBinding {
  languageCode: string;
  /** Ordered body parameters; index 0 becomes {{1}}. */
  params: string[];
  templateName: string;
}

export interface TwilioTemplateBinding {
  contentSid: string;
  /** Twilio ContentVariables, keyed by 1-based position as a string. */
  contentVariables: Record<string, string>;
}

export type BindingResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Setup documentation carries sentinels (META_TEMPLATE_NAME_REQUIRED,
 * TWILIO_CONTENT_SID_REQUIRED) marking identifiers still awaiting provider
 * approval. Treat any `*_REQUIRED` value as absent so a placeholder that reaches
 * the database can never be sent as if it were approved.
 */
export function isMappedIdentifier(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && !trimmed.endsWith("_REQUIRED");
}

function payloadVariable(payload: Json, key: string): string | null {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return null;
  const value = payload[key];
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

/**
 * Collects the ordered parameter values, or names every key the payload is
 * missing. Meta and Twilio both reject a template whose parameter count does not
 * match the approved body, so a partial list is never worth sending.
 */
function collectParams(
  payload: Json,
  keys: string[],
): { ok: true; values: string[] } | { ok: false; missing: string[] } {
  const values: string[] = [];
  const missing: string[] = [];
  for (const key of keys) {
    const value = payloadVariable(payload, key);
    if (value === null) missing.push(key);
    else values.push(value);
  }
  return missing.length ? { ok: false, missing } : { ok: true, values };
}

export function resolveMetaBinding(
  mapping: ProviderTemplateMapping | null,
  payload: Json,
  locale: LocaleCode,
): BindingResult<MetaTemplateBinding> {
  if (!mapping) {
    return { ok: false, reason: "No notification template is linked to this notification." };
  }
  if (!isMappedIdentifier(mapping.provider_template_name)) {
    return {
      ok: false,
      reason:
        "No approved Meta template name is recorded for this notification template. " +
        "Record the approved name in notification_templates.provider_template_name.",
    };
  }
  const keys = mapping.provider_param_keys ?? [];
  const params = collectParams(payload, keys);
  if (!params.ok) {
    return {
      ok: false,
      reason: `Notification payload is missing Meta template variables: ${params.missing.join(", ")}.`,
    };
  }
  return {
    ok: true,
    value: {
      languageCode: isMappedIdentifier(mapping.provider_language_code)
        ? mapping.provider_language_code.trim()
        : locale,
      params: params.values,
      templateName: mapping.provider_template_name.trim(),
    },
  };
}

export function resolveTwilioBinding(
  mapping: ProviderTemplateMapping | null,
  payload: Json,
): BindingResult<TwilioTemplateBinding> {
  if (!mapping) {
    return { ok: false, reason: "No notification template is linked to this notification." };
  }
  if (!isMappedIdentifier(mapping.twilio_content_sid)) {
    return {
      ok: false,
      reason:
        "No approved Twilio Content SID is recorded for this notification template. " +
        "Record the Content SID in notification_templates.twilio_content_sid.",
    };
  }
  const keys = mapping.twilio_variable_keys ?? [];
  const params = collectParams(payload, keys);
  if (!params.ok) {
    return {
      ok: false,
      reason: `Notification payload is missing Twilio content variables: ${params.missing.join(", ")}.`,
    };
  }
  const contentVariables: Record<string, string> = {};
  params.values.forEach((value, index) => {
    contentVariables[String(index + 1)] = value;
  });
  return { ok: true, value: { contentSid: mapping.twilio_content_sid.trim(), contentVariables } };
}

/**
 * Free-form (non-template) WhatsApp delivery is only valid inside an open
 * 24-hour customer-service window. Neither provider tells us whether that window
 * is open, so it is never inferred: the template must opt in, or the caller must
 * assert it explicitly on the notification payload.
 */
export function allowsFreeform(mapping: ProviderTemplateMapping | null, payload: Json): boolean {
  if (mapping?.allow_freeform === true) return true;
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return false;
  return payload.whatsapp_freeform === true;
}
