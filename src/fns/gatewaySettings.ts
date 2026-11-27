import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requireModule } from "@/company/requireModule";
import { assertNotSupportSession } from "@/company/supportSessionGuard";
import { requirePermission, type PermissionContext } from "@/fns/requirePermission";
import { loadGatewayConnection, saveGatewayCredentials } from "@/gateways/connectionStore.server";
import { gatewayRegistry } from "@/gateways/registry";
import { GATEWAY_PROVIDERS, type GatewayMode, type GatewayProvider } from "@/gateways/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type {
  AuditResult,
  Database,
  GatewayConnectionRow,
  Json,
} from "@/integrations/supabase/database.types";

/*
 * دوال إعدادات بوابات الدفع لكل شركة: العرض، حفظ بيانات الاعتماد، اختبار
 * الاتصال، والتفعيل أو التعطيل.
 *
 * All reads and writes go through `companyClient(companyId)` (`company_service`
 * role); secrets are encrypted via `connectionStore.server.ts` and never
 * returned to callers or written to audit logs.
 */

const GATEWAY_PERMISSION = "settings.integrations";
const GATEWAY_MODULE = "online_payments" as const;

/** رموز أخطاء إعدادات بوابات الدفع القياسية. */
export const GATEWAY_SETTINGS_ERROR_CODES = [
  "CONNECTION_NOT_FOUND",
  "TEST_REQUIRED",
  "ONE_ACTIVE_GATEWAY",
] as const;

export type GatewaySettingsErrorCode = (typeof GATEWAY_SETTINGS_ERROR_CODES)[number];

/**
 * خطأ موحّد لدوال إعدادات البوابات؛ يحمل الرمز في الرسالة أيضاً لتمييزه عبر حدود الخادم.
 */
export class GatewaySettingsError extends Error {
  readonly code: GatewaySettingsErrorCode;

  /** ينشئ خطأ إعدادات بوابة برمز قياسي ورسالة توضيحية. */
  constructor(code: GatewaySettingsErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "GatewaySettingsError";
    this.code = code;
  }
}

/** معاينة سر بوابة الدفع: الاسم وآخر أربعة أحرف فقط. */
export interface GatewaySecretPreview {
  name: string;
  last4: string;
}

/** ملخص اتصال بوابة دفع واحد كما يُعرض في شاشة الإعدادات. */
export interface GatewayListItem {
  provider: GatewayProvider;
  configured: boolean;
  mode: GatewayMode;
  publicConfig: Json;
  isActive: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean;
  lastTestMessage: string | null;
  secretPreviews: GatewaySecretPreview[];
}

const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonSchema),
    z.record(z.string(), jsonSchema),
  ]),
);

const providerSchema = z.object({
  provider: z.enum(GATEWAY_PROVIDERS),
});

export const saveGatewayCredentialsSchema = z.object({
  provider: z.enum(GATEWAY_PROVIDERS),
  mode: z.enum(["test", "live"]).default("test"),
  publicConfig: z.record(z.string(), jsonSchema).default({}),
  credentials: z.record(z.string().trim().min(1), z.string().min(1)),
});

/**
 * يتحقق من صلاحية إدارة التكاملات وتفعيل قسم الدفع الإلكتروني، ثم يعيد عميل الشركة.
 */
async function requireGatewayContext(
  context: PermissionContext,
  attempted: string,
  refusal: string,
): Promise<SupabaseClient<Database>> {
  await requirePermission(context, {
    code: GATEWAY_PERMISSION,
    attempted,
    refusal,
  });
  const company = requireRequestCompany();
  const db = companyClient(company.id);
  await requireModule(db, GATEWAY_MODULE);
  return db;
}

/**
 * يقرأ صف اتصال مزوّد واحد للشركة الحالية أو يرمي `CONNECTION_NOT_FOUND`.
 */
async function requireProviderConnection(
  db: SupabaseClient<Database>,
  provider: GatewayProvider,
): Promise<GatewayConnectionRow> {
  const { data, error } = await db
    .from("gateway_connections")
    .select("*")
    .eq("provider", provider)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load gateway connection: ${error.message}`);
  }
  if (!data) {
    throw new GatewaySettingsError(
      "CONNECTION_NOT_FOUND",
      `Gateway connection for ${provider} is not configured.`,
    );
  }
  return data;
}

/**
 * يسجّل حدث تدقيق لإجراءات إعدادات البوابات دون تضمين أي قيم سرية.
 */
async function writeGatewayAudit(
  db: SupabaseClient<Database>,
  params: {
    action: string;
    entityId: string;
    before?: Json | null;
    after?: Json | null;
    result?: AuditResult;
    errorCode?: string | null;
  },
): Promise<void> {
  const { error } = await db.rpc("write_audit", {
    p_action: params.action,
    p_entity_type: "gateway_connection",
    p_entity_id: params.entityId,
    p_before: params.before ?? null,
    p_after: params.after ?? null,
    p_result: params.result ?? "success",
    p_error_code: params.errorCode ?? null,
  });
  if (error) {
    throw new Error(`Audit log write failed: ${error.message}`);
  }
}

/**
 * يحوّل أخطاء قيود التفعيل في قاعدة البيانات إلى رموز أخطاء واضحة.
 */
function mapActivationDbError(message: string): Error {
  if (message.includes("gateway_connections_active_requires_passing_test")) {
    return new GatewaySettingsError(
      "TEST_REQUIRED",
      "Run a successful connection test before activating this gateway.",
    );
  }
  if (message.includes("gateway_connections_one_active_per_company")) {
    return new GatewaySettingsError(
      "ONE_ACTIVE_GATEWAY",
      "Another payment gateway is already active for this company.",
    );
  }
  return new Error(`Failed to activate gateway: ${message}`);
}

/**
 * يعرض حالة كل مزوّد بوابة دفع للشركة مع معاينات `last4` فقط دون أي قيمة سرية.
 */
export const gatewayList = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<GatewayListItem[]> => {
    const db = await requireGatewayContext(
      context as never,
      "gateway.list",
      "You do not have permission to view payment gateway settings.",
    );

    const [connectionsRes, previewsRes] = await Promise.all([
      db
        .from("gateway_connections")
        .select(
          "id, provider, mode, public_config, is_active, last_test_at, last_test_ok, last_test_message, credentials_version",
        ),
      db
        .from("company_secret_previews")
        .select("owner_id, name, last4, version")
        .eq("owner_kind", "gateway"),
    ]);

    if (connectionsRes.error) {
      throw new Error(`Failed to list gateway connections: ${connectionsRes.error.message}`);
    }
    if (previewsRes.error) {
      throw new Error(`Failed to list gateway secret previews: ${previewsRes.error.message}`);
    }

    const byProvider = new Map((connectionsRes.data ?? []).map((row) => [row.provider, row]));
    const previews = previewsRes.data ?? [];

    return GATEWAY_PROVIDERS.map((provider) => {
      const row = byProvider.get(provider);
      if (!row) {
        return {
          provider,
          configured: false,
          mode: "test",
          publicConfig: {},
          isActive: false,
          lastTestAt: null,
          lastTestOk: false,
          lastTestMessage: null,
          secretPreviews: [],
        };
      }
      return {
        provider: row.provider,
        configured: true,
        mode: row.mode,
        publicConfig: row.public_config,
        isActive: row.is_active,
        lastTestAt: row.last_test_at,
        lastTestOk: row.last_test_ok,
        lastTestMessage: row.last_test_message,
        secretPreviews: previews
          .filter((p) => p.owner_id === row.id && p.version === row.credentials_version)
          .map((p) => ({ name: p.name, last4: p.last4 })),
      };
    });
  });

/**
 * يحفظ بيانات اعتماد بوابة الدفع مشفّرةً ويكتب سجل تدقيق خالياً من الأسرار.
 */
export const gatewaySaveCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(saveGatewayCredentialsSchema)
  .handler(async ({ data, context }) => {
    assertNotSupportSession((context as { claims?: unknown } | undefined)?.claims);
    const db = await requireGatewayContext(
      context as never,
      "gateway.save_credentials",
      "You do not have permission to configure payment gateways.",
    );

    const saved = await saveGatewayCredentials(db, {
      provider: data.provider,
      mode: data.mode,
      publicConfig: data.publicConfig,
      credentials: data.credentials,
    });

    await writeGatewayAudit(db, {
      action: "gateway.save_credentials",
      entityId: saved.id,
      after: {
        provider: saved.provider,
        mode: saved.mode,
        credentials_version: saved.credentials_version,
        credential_names: Object.keys(data.credentials),
      },
    });

    return {
      provider: saved.provider,
      mode: saved.mode,
      isActive: saved.is_active,
      lastTestAt: saved.last_test_at,
      lastTestOk: saved.last_test_ok,
      lastTestMessage: saved.last_test_message,
      credentialsVersion: saved.credentials_version,
    };
  });

/**
 * يختبر اتصال بوابة الدفع عبر `gatewayRegistry` ويحفظ نتيجة الاختبار على الاتصال.
 */
export const gatewayTestConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(providerSchema)
  .handler(async ({ data, context }) => {
    assertNotSupportSession((context as { claims?: unknown } | undefined)?.claims);
    const db = await requireGatewayContext(
      context as never,
      "gateway.test",
      "You do not have permission to test payment gateways.",
    );

    const row = await requireProviderConnection(db, data.provider);
    const loaded = await loadGatewayConnection(db, row.id);
    const adapter = gatewayRegistry.create(loaded.connection);
    const result = await adapter.testConnection();
    const testedAt = new Date().toISOString();

    const { error: updateError } = await db
      .from("gateway_connections")
      .update({
        last_test_at: testedAt,
        last_test_ok: result.ok,
        last_test_message: result.message,
        // Keep the DB check constraint `gateway_connections_active_requires_passing_test`
        // satisfied if an active connection fails a re-test.
        ...(result.ok ? {} : { is_active: false }),
      })
      .eq("id", row.id);

    if (updateError) {
      throw new Error(`Failed to record gateway test result: ${updateError.message}`);
    }

    await writeGatewayAudit(db, {
      action: "gateway.test",
      entityId: row.id,
      after: {
        provider: data.provider,
        ok: result.ok,
        message: result.message,
      },
      result: result.ok ? "success" : "failure",
    });

    return {
      ok: result.ok,
      message: result.message,
      testedAt,
    };
  });

/**
 * يفعّل بوابة الدفع بعد نجاح اختبارها ويعطّل أي بوابة نشطة أخرى للشركة في نفس الطلب.
 */
export const gatewayActivate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(providerSchema)
  .handler(async ({ data, context }) => {
    assertNotSupportSession((context as { claims?: unknown } | undefined)?.claims);
    const db = await requireGatewayContext(
      context as never,
      "gateway.activate",
      "You do not have permission to activate payment gateways.",
    );

    const row = await requireProviderConnection(db, data.provider);
    if (!row.last_test_ok || !row.last_test_at) {
      throw new GatewaySettingsError(
        "TEST_REQUIRED",
        "Run a successful connection test before activating this gateway.",
      );
    }

    const { error: deactivateOthersError } = await db
      .from("gateway_connections")
      .update({ is_active: false })
      .eq("is_active", true)
      .neq("id", row.id);

    if (deactivateOthersError) {
      throw new Error(`Failed to deactivate other gateway: ${deactivateOthersError.message}`);
    }

    const { data: activated, error: activateError } = await db
      .from("gateway_connections")
      .update({ is_active: true })
      .eq("id", row.id)
      .select("*")
      .single();

    if (activateError) {
      throw mapActivationDbError(activateError.message);
    }

    await writeGatewayAudit(db, {
      action: "gateway.activate",
      entityId: activated.id,
      before: { is_active: row.is_active },
      after: { provider: activated.provider, is_active: activated.is_active },
    });

    return {
      provider: activated.provider,
      mode: activated.mode,
      isActive: activated.is_active,
    };
  });

/**
 * يعطّل بوابة دفع محدّدة للشركة الحالية ويسجّل ذلك في سجل التدقيق.
 */
export const gatewayDeactivate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(providerSchema)
  .handler(async ({ data, context }) => {
    assertNotSupportSession((context as { claims?: unknown } | undefined)?.claims);
    const db = await requireGatewayContext(
      context as never,
      "gateway.deactivate",
      "You do not have permission to deactivate payment gateways.",
    );

    const row = await requireProviderConnection(db, data.provider);
    const { data: updated, error } = await db
      .from("gateway_connections")
      .update({ is_active: false })
      .eq("id", row.id)
      .select("*")
      .single();

    if (error) {
      throw new Error(`Failed to deactivate gateway: ${error.message}`);
    }

    await writeGatewayAudit(db, {
      action: "gateway.deactivate",
      entityId: updated.id,
      before: { is_active: row.is_active },
      after: { provider: updated.provider, is_active: updated.is_active },
    });

    return {
      provider: updated.provider,
      mode: updated.mode,
      isActive: updated.is_active,
    };
  });
