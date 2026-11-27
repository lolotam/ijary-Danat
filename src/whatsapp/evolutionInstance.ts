import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { companyClient } from "@/company/companyClient.server";
import { encodeByteaHex } from "@/gateways/connectionStore.server";
import type { Database, WhatsappConnectionRow } from "@/integrations/supabase/database.types";
import {
  createEvolutionClient,
  EvolutionApiError,
  extractQr,
  extractState,
  type EvolutionClient,
  type EvolutionWebhookConfig,
  type Fetcher,
} from "@/lib/evolution/client";
import { connectedNumberFor } from "@/lib/providers/evolution";
import { encryptSecret, last4 } from "@/lib/secrets.server";

/*
 * دورة حياة نسخة Evolution لكل شركة: إنشاء النسخة وتسجيل الويب هوك،
 * جلب رمز QR، تسجيل الخروج، وحذف النسخة، مع حفظ سر الويب هوك مشفّراً.
 *
 * Uses `companyClient(companyId)` (`company_service` role) and the platform's
 * Evolution server credentials (`EVOLUTION_API_URL`, `EVOLUTION_API_KEY`).
 */

/** ترويسة التحقق من سرّ الويب هوك المرسلة مع أحداث Evolution. */
export const EVOLUTION_WEBHOOK_HEADER = "x-danat-webhook-secret";

const WEBHOOK_EVENTS = [
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
  "CONNECTION_UPDATE",
  "QRCODE_UPDATED",
];

/**
 * يشتق اسم نسخة Evolution الفريد للشركة بإزالة الشرطات من معرّفها.
 */
export function evolutionInstanceName(companyId: string): string {
  return `ijary-${companyId.replace(/-/g, "")}`;
}

/**
 * يبني عنوان الويب هوك الخاص باتصال Evolution محدّد.
 */
export function evolutionWebhookUrl(connectionId: string): string {
  const base = process.env.APP_BASE_URL?.trim();
  if (!base) {
    throw new Error("APP_BASE_URL is not set; Evolution cannot deliver webhooks without it.");
  }
  return `${base.replace(/\/+$/, "")}/api/public/webhooks/evolution/${connectionId}`;
}

/**
 * ينشئ عميل Evolution باستخدام عنوان ومفتاح خادم المنصة.
 */
function platformEvolutionClient(fetcher?: Fetcher): EvolutionClient {
  const baseUrl = process.env.EVOLUTION_API_URL?.trim();
  const apiKey = process.env.EVOLUTION_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    throw new Error("EVOLUTION_API_URL and EVOLUTION_API_KEY must be set.");
  }
  return createEvolutionClient({ baseUrl, apiKey, fetcher });
}

/**
 * يتحقق مما إذا كان خطأ Evolution يعني أن النسخة موجودة مسبقاً على الخادم.
 */
function isAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const text = `${error.message} ${JSON.stringify((error as { body?: unknown }).body ?? "")}`;
  return /already|in use|exists/i.test(text);
}

/**
 * يقرأ صف اتصال `evolution_qr` للشركة أو يعيد `null` إن لم يُنشأ بعد.
 */
async function loadEvolutionConnection(
  db: SupabaseClient<Database>,
  companyId: string,
): Promise<WhatsappConnectionRow | null> {
  const { data, error } = await db
    .from("whatsapp_connections")
    .select("*")
    .eq("company_id", companyId)
    .eq("method", "evolution_qr")
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load WhatsApp connection: ${error.message}`);
  }
  return data;
}

/**
 * يضمن وجود صف `whatsapp_connections` لطريقة `evolution_qr` ويعيده.
 */
async function ensureConnectionRow(
  db: SupabaseClient<Database>,
  companyId: string,
  instanceName: string,
): Promise<WhatsappConnectionRow> {
  const existing = await loadEvolutionConnection(db, companyId);
  if (existing) {
    if (existing.instance_name === instanceName) {
      return existing;
    }
    const { data: updated, error: updateError } = await db
      .from("whatsapp_connections")
      .update({ instance_name: instanceName })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (updateError) {
      throw new Error(`Failed to update Evolution instance name: ${updateError.message}`);
    }
    return updated;
  }

  const { data: inserted, error: insertError } = await db
    .from("whatsapp_connections")
    .insert({
      company_id: companyId,
      method: "evolution_qr",
      instance_name: instanceName,
      status: "disconnected",
    })
    .select("*")
    .single();
  if (insertError) {
    throw new Error(`Failed to create WhatsApp connection row: ${insertError.message}`);
  }
  return inserted;
}

/**
 * يقرأ أعلى رقم إصدار لسرّ الويب هوك الخاص بالاتصال، ويُدرج الإصدار الجديد مشفّراً.
 */
async function storeWebhookSecret(
  db: SupabaseClient<Database>,
  companyId: string,
  connectionId: string,
  plainSecret: string,
): Promise<void> {
  const { data: latest, error: readError } = await db
    .from("company_secrets")
    .select("version")
    .eq("owner_kind", "whatsapp")
    .eq("owner_id", connectionId)
    .eq("name", "webhook_secret")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (readError) {
    throw new Error(`Failed to read webhook secret version: ${readError.message}`);
  }

  const nextVersion = (latest?.version ?? 0) + 1;
  const encrypted = encryptSecret(plainSecret);

  const { error: insertError } = await db.from("company_secrets").insert({
    company_id: companyId,
    owner_kind: "whatsapp",
    owner_id: connectionId,
    name: "webhook_secret",
    ciphertext: encodeByteaHex(encrypted.ciphertext),
    iv: encodeByteaHex(encrypted.iv),
    auth_tag: encodeByteaHex(encrypted.authTag),
    key_version: encrypted.keyVersion,
    last4: last4(plainSecret),
    version: nextVersion,
  });

  if (insertError) {
    throw new Error(`Failed to store webhook secret: ${insertError.message}`);
  }
}

/**
 * يضمن وجود نسخة Evolution للشركة على خادم المنصة مع تسجيل الويب هوك وسرّه المشفّر.
 *
 * Evolution is configured with the new secret before persisting it; if creating
 * a brand-new instance succeeds and saving the secret fails, that new instance
 * is rolled back so we never leave an unhooked orphan.
 */
export async function ensureEvolutionInstance(
  companyId: string,
  options?: { fetcher?: Fetcher },
): Promise<{ connection: WhatsappConnectionRow; instanceName: string }> {
  const db = companyClient(companyId);
  const instanceName = evolutionInstanceName(companyId);
  const connection = await ensureConnectionRow(db, companyId, instanceName);

  const client = platformEvolutionClient(options?.fetcher);
  const secret = randomBytes(32).toString("base64url");
  const webhook: EvolutionWebhookConfig = {
    url: evolutionWebhookUrl(connection.id),
    headers: { [EVOLUTION_WEBHOOK_HEADER]: secret },
    events: WEBHOOK_EVENTS,
  };

  let createdInstance = false;
  try {
    await client.createInstance({ instanceName, webhook });
    createdInstance = true;
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    await client.setWebhook(instanceName, webhook);
  }

  try {
    await storeWebhookSecret(db, companyId, connection.id, secret);
  } catch (error) {
    if (createdInstance) {
      await client.deleteInstance(instanceName).catch(() => undefined);
    }
    throw error;
  }

  return { connection, instanceName };
}

/**
 * يطلب رمز QR من خادم Evolution ويحفظه في `whatsapp_connections` بحالة `pairing`.
 */
export async function fetchEvolutionQr(
  companyId: string,
  options?: { fetcher?: Fetcher },
): Promise<{ connectionId: string; qr: string | null; status: WhatsappConnectionRow["status"] }> {
  const db = companyClient(companyId);
  const instanceName = evolutionInstanceName(companyId);
  const existing = await loadEvolutionConnection(db, companyId);
  if (!existing) {
    throw new Error(
      "WhatsApp evolution_qr connection does not exist; call ensureEvolutionInstance first.",
    );
  }

  const client = platformEvolutionClient(options?.fetcher);
  const raw = await client.connect(instanceName);
  const state = extractState(raw);
  const qr = extractQr(raw);

  if (state === "open") {
    const connectedNumber =
      existing.connected_number ?? (await connectedNumberFor(client, instanceName));
    const now = new Date().toISOString();
    const { error } = await db
      .from("whatsapp_connections")
      .update({
        status: "connected",
        last_qr: null,
        connected_number: connectedNumber,
        connected_at: existing.connected_at ?? now,
        last_seen_at: now,
        last_error: null,
      })
      .eq("id", existing.id);
    if (error) {
      throw new Error(`Failed to update connected WhatsApp status: ${error.message}`);
    }
    return { connectionId: existing.id, qr: null, status: "connected" };
  }

  const { error } = await db
    .from("whatsapp_connections")
    .update({
      status: "pairing",
      last_qr: qr,
      last_error: null,
    })
    .eq("id", existing.id);
  if (error) {
    throw new Error(`Failed to store WhatsApp QR code: ${error.message}`);
  }

  return { connectionId: existing.id, qr, status: "pairing" };
}

/**
 * يسجّل خروج نسخة Evolution للشركة ويضبط الحالة إلى `disconnected` مع مسح `last_qr`.
 */
export async function logoutEvolutionInstance(
  companyId: string,
  options?: { fetcher?: Fetcher },
): Promise<{ disconnected: boolean; status: "disconnected" }> {
  const db = companyClient(companyId);
  const existing = await loadEvolutionConnection(db, companyId);
  if (!existing) {
    return { disconnected: false, status: "disconnected" };
  }

  const instanceName = evolutionInstanceName(companyId);
  const { error: disarmError } = await db
    .from("whatsapp_connections")
    .update({ disconnect_alert_armed: false })
    .eq("id", existing.id);
  if (disarmError) {
    throw new Error(`Failed to disarm WhatsApp disconnect alert: ${disarmError.message}`);
  }

  const client = platformEvolutionClient(options?.fetcher);
  let remoteOk = true;
  try {
    await client.logout(instanceName);
  } catch (error) {
    if (!(error instanceof EvolutionApiError && error.status === 404)) {
      remoteOk = false;
    }
  }

  const { error: updateError } = await db
    .from("whatsapp_connections")
    .update({
      status: "disconnected",
      last_qr: null,
      connected_number: null,
      connected_at: null,
      disconnect_alert_armed: false,
      disconnected_at: new Date().toISOString(),
      last_error: remoteOk ? null : "Failed to log out remote Evolution instance.",
    })
    .eq("id", existing.id);

  if (updateError) {
    throw new Error(`Failed to update disconnected WhatsApp status: ${updateError.message}`);
  }

  return { disconnected: remoteOk, status: "disconnected" };
}

/**
 * يحذف نسخة Evolution للشركة من خادم المنصة ويعيد ضبط صف الاتصال محلياً.
 */
export async function deleteEvolutionInstance(
  companyId: string,
  options?: { fetcher?: Fetcher },
): Promise<{ deleted: boolean }> {
  const db = companyClient(companyId);
  const existing = await loadEvolutionConnection(db, companyId);
  if (!existing) {
    return { deleted: false };
  }

  const client = platformEvolutionClient(options?.fetcher);
  const instanceName = evolutionInstanceName(companyId);
  try {
    await client.deleteInstance(instanceName);
  } catch (error) {
    if (!(error instanceof EvolutionApiError && error.status === 404)) {
      throw error;
    }
  }

  const { error: updateError } = await db
    .from("whatsapp_connections")
    .update({
      status: "disconnected",
      is_active: false,
      last_qr: null,
      connected_number: null,
      connected_at: null,
      disconnect_alert_armed: false,
      disconnected_at: new Date().toISOString(),
    })
    .eq("id", existing.id);

  if (updateError) {
    throw new Error(`Failed to reset deleted WhatsApp connection: ${updateError.message}`);
  }

  return { deleted: true };
}
