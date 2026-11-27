import type { NotificationProvider } from "@/integrations/supabase/database.types";

/**
 * Client-side mirror of the `provider_configs_secret_references_only` database
 * constraint (migration 07). The database is still the authority — this exists so
 * an admin gets a specific, actionable message instead of a raw constraint
 * violation surfaced as a generic error toast.
 */

/**
 * Config keys each provider reads, mapped to the value an admin should enter —
 * the documented environment-variable name, never a credential.
 */
export const PROVIDER_CONFIG_SHAPE: Record<
  NotificationProvider,
  { optional: Record<string, string>; required: Record<string, string> }
> = {
  smtp: {
    required: {
      host_env: "SMTP_HOST",
      port_env: "SMTP_PORT",
      user_env: "SMTP_USER",
      secret_env: "SMTP_PASS",
    },
    optional: {},
  },
  resend: {
    required: { secret_env: "RESEND_API_KEY" },
    optional: {},
  },
  whatsapp_cloud_api: {
    required: {
      secret_env: "WHATSAPP_ACCESS_TOKEN",
      phone_number_id_env: "WHATSAPP_PHONE_NUMBER_ID",
    },
    optional: { waba_id_env: "WHATSAPP_WABA_ID", graph_api_version: "v23.0" },
  },
  twilio: {
    required: {
      account_sid_env: "TWILIO_ACCOUNT_SID",
      secret_env: "TWILIO_AUTH_TOKEN",
      from_whatsapp_env: "TWILIO_WHATSAPP_FROM",
    },
    optional: {},
  },
  postora: {
    required: {
      api_key_env: "POSTORA_WHATSAPP_API_KEY",
      api_base: "https://api.postora.cloud/functions/v1/partner-api",
    },
    optional: { webhook_secret_env: "POSTORA_WEBHOOK_SECRET" },
  },
  evolution_api: {
    // No instance_name here on purpose: the company's `whatsapp_connections`
    // row (migration 333) is its single source of truth, so config and paired
    // session cannot drift.
    required: {
      api_base: "http://evolution:8080",
      api_key_env: "EVOLUTION_API_KEY",
    },
    optional: {},
  },
};

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const SECRETISH_KEY = /(secret|password|token|api.?key)/i;
const REFERENCE_KEY = /(_env|_ref)$/i;

/**
 * Returns a human-readable problem, or null when the config is acceptable.
 * Rejecting is deliberately conservative: a stored raw credential would be
 * readable by every admin and would outlive any later rotation.
 */
export function validateProviderConfig(provider: NotificationProvider, raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return `Not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "Configuration must be a JSON object.";
  }

  const config = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== "string") {
      return `"${key}" must be a string.`;
    }
    if (SECRETISH_KEY.test(key) && !REFERENCE_KEY.test(key)) {
      return `"${key}" looks like a raw credential. Rename it to "${key}_env" and store the value as a server variable.`;
    }
    if (REFERENCE_KEY.test(key) && !ENV_NAME.test(value)) {
      return `"${key}" must name an environment variable in UPPER_SNAKE_CASE, not the value itself.`;
    }
  }

  const missing = Object.keys(PROVIDER_CONFIG_SHAPE[provider].required).filter(
    (key) => !config[key],
  );
  if (missing.length) {
    return `Missing required key(s): ${missing.join(", ")}.`;
  }
  return null;
}
