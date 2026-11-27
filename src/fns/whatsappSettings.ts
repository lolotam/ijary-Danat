import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { assertNotSupportSession } from "@/company/supportSessionGuard";
import { requirePermission, type PermissionContext } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type {
  Database,
  WhatsappConnectionMethod,
  WhatsappConnectionRow,
  WhatsappConnectionStatus,
} from "@/integrations/supabase/database.types";
import {
  ensureEvolutionInstance,
  fetchEvolutionQr,
  logoutEvolutionInstance,
} from "@/whatsapp/evolutionInstance";

/*
 * دوال إعدادات واتساب للشركة: قراءة الحالة الحالية، بدء الاقتران برمز QR،
 * فصل الاتصال، وتبديل طريقة الربط النشطة.
 *
 * All reads and writes go through `companyClient(companyId)` (`company_service`
 * role). Mutating functions reject support impersonation sessions first (T181),
 * and `lastQr` is returned only while `status === "pairing"`.
 */

const WHATSAPP_METHODS = ["evolution_qr", "cloud_api", "cloud_coexistence"] as const;

const methodSchema = z.object({
  method: z.enum(WHATSAPP_METHODS),
});

const optionalMethodSchema = z
  .object({
    method: z.enum(WHATSAPP_METHODS).optional(),
  })
  .optional();

/** ملخص اتصال واتساب الآمن للعرض في واجهة الإعدادات (دون أسرار). */
export interface WhatsappConnectionSummary {
  id: string;
  method: WhatsappConnectionMethod;
  isActive: boolean;
  status: WhatsappConnectionStatus;
  connectedNumber: string | null;
  lastSeenAt: string | null;
  connectedAt: string | null;
  lastError: string | null;
  lastQr: string | null;
}

/** استجابة حالة واتساب للشركة: الاتصال النشط وقائمة الطرق المتاحة. */
export interface WhatsappSettingsStatus {
  active: WhatsappConnectionSummary | null;
  connections: WhatsappConnectionSummary[];
}

/**
 * يتحقق من صلاحية إدارة التكاملات للمستخدم ويسجّل الرفض عند انعدامها.
 */
async function assertCanManageIntegrations(
  context: PermissionContext,
  attempted: string,
  refusal: string,
): Promise<void> {
  await requirePermission(context, {
    code: "settings.integrations",
    attempted,
    refusal,
  });
}

/**
 * يحوّل صف `whatsapp_connections` إلى ملخص آمن؛ يُظهر `lastQr` أثناء الاقتران فقط.
 */
function toSummary(row: WhatsappConnectionRow): WhatsappConnectionSummary {
  return {
    id: row.id,
    method: row.method,
    isActive: row.is_active,
    status: row.status,
    connectedNumber: row.connected_number,
    lastSeenAt: row.last_seen_at,
    connectedAt: row.connected_at,
    lastError: row.last_error,
    lastQr: row.status === "pairing" ? row.last_qr : null,
  };
}

/**
 * يعطّل أي طريقة واتساب نشطة أخرى للشركة قبل تفعيل الطريقة المختارة
 * التزاماً بفهرس التفرد `whatsapp_connections_one_active_per_company`.
 */
async function activateConnectionRow(
  db: SupabaseClient<Database>,
  connectionId: string,
): Promise<WhatsappConnectionRow> {
  const { error: deactivateError } = await db
    .from("whatsapp_connections")
    .update({ is_active: false })
    .eq("is_active", true)
    .neq("id", connectionId);

  if (deactivateError) {
    throw new Error(`Failed to deactivate previous WhatsApp method: ${deactivateError.message}`);
  }

  const { data: activated, error: activateError } = await db
    .from("whatsapp_connections")
    .update({ is_active: true })
    .eq("id", connectionId)
    .select("*")
    .single();

  if (activateError) {
    throw new Error(`Failed to activate WhatsApp method: ${activateError.message}`);
  }

  return activated;
}

/**
 * يعرض حالة اتصالات واتساب للشركة الحالية دون كشف أي أسرار، مع إظهار رمز QR أثناء الاقتران فقط.
 */
export const whatsappStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<WhatsappSettingsStatus> => {
    await assertCanManageIntegrations(
      context as never,
      "whatsapp.status",
      "You do not have permission to view WhatsApp settings.",
    );

    const companyId = requireRequestCompany().id;
    const db = companyClient(companyId);
    const { data, error } = await db
      .from("whatsapp_connections")
      .select(
        "id, company_id, method, is_active, status, connected_number, instance_name, phone_number_id, waba_id, last_qr, last_seen_at, last_error, disconnect_alert_armed, disconnected_at, connected_at, created_at, updated_at",
      );

    if (error) {
      throw new Error(`Failed to load WhatsApp status: ${error.message}`);
    }

    const connections = (data ?? []).map(toSummary);
    const active = connections.find((c) => c.isActive) ?? null;
    return { active, connections };
  });

/**
 * يبدأ أو يجدّد اقتران واتساب عبر Evolution QR، ويجعله الطريقة النشطة للشركة.
 */
export const whatsappStartQr = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    assertNotSupportSession((context as { claims?: unknown } | undefined)?.claims);
    await assertCanManageIntegrations(
      context as never,
      "whatsapp.start_qr",
      "You do not have permission to manage the WhatsApp connection.",
    );

    const companyId = requireRequestCompany().id;
    const db = companyClient(companyId);
    const { connection } = await ensureEvolutionInstance(companyId);
    await activateConnectionRow(db, connection.id);
    return fetchEvolutionQr(companyId);
  });

/**
 * يفصل اتصال واتساب النشط أو المحدّد ويمسح رمز QR المخزّن.
 */
export const whatsappDisconnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(optionalMethodSchema)
  .handler(async ({ data, context }) => {
    assertNotSupportSession((context as { claims?: unknown } | undefined)?.claims);
    await assertCanManageIntegrations(
      context as never,
      "whatsapp.disconnect",
      "You do not have permission to manage the WhatsApp connection.",
    );

    const companyId = requireRequestCompany().id;
    const db = companyClient(companyId);

    let targetMethod = data?.method;
    if (!targetMethod) {
      const { data: activeRow, error } = await db
        .from("whatsapp_connections")
        .select("method")
        .eq("is_active", true)
        .maybeSingle();
      if (error) {
        throw new Error(`Failed to load active WhatsApp connection: ${error.message}`);
      }
      targetMethod = activeRow?.method ?? "evolution_qr";
    }

    if (targetMethod === "evolution_qr") {
      return logoutEvolutionInstance(companyId);
    }

    const { error: updateError } = await db
      .from("whatsapp_connections")
      .update({
        status: "disconnected",
        is_active: false,
        last_qr: null,
        disconnected_at: new Date().toISOString(),
      })
      .eq("company_id", companyId)
      .eq("method", targetMethod);

    if (updateError) {
      throw new Error(`Failed to disconnect WhatsApp method: ${updateError.message}`);
    }

    return { disconnected: true, status: "disconnected" as const };
  });

/**
 * يبدّل طريقة اتصال واتساب النشطة للشركة إلى الطريقة المحددة.
 */
export const whatsappActivate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(methodSchema)
  .handler(async ({ data, context }): Promise<WhatsappConnectionSummary> => {
    assertNotSupportSession((context as { claims?: unknown } | undefined)?.claims);
    await assertCanManageIntegrations(
      context as never,
      "whatsapp.activate",
      "You do not have permission to manage the WhatsApp connection.",
    );

    const companyId = requireRequestCompany().id;
    const db = companyClient(companyId);

    const { data: target, error: findError } = await db
      .from("whatsapp_connections")
      .select("*")
      .eq("company_id", companyId)
      .eq("method", data.method)
      .maybeSingle();

    if (findError) {
      throw new Error(`Failed to load WhatsApp connection: ${findError.message}`);
    }
    if (!target) {
      throw new Error(`WhatsApp connection for ${data.method} is not configured.`);
    }

    const activated = await activateConnectionRow(db, target.id);
    return toSummary(activated);
  });
