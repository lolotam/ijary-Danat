import { randomBytes } from "node:crypto";

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Tables } from "@/integrations/supabase/database.types";
import { extractQr, extractState } from "@/lib/evolution/client";
import type { EvolutionWebhookConfig } from "@/lib/evolution/client";
import { connectedNumberFor, evolutionClientFromConfig } from "@/lib/providers/evolution";
import { requirePermission, type PermissionContext } from "@/fns/requirePermission";

/**
 * دورة حياة جلسة QR الخاصة بـ Evolution: بدء الاقتران، استطلاع الحالة، والفصل.
 *
 * Server functions rather than GET routes for the same reason as gmailOAuth:
 * this app authenticates server calls with a Bearer token, which a browser
 * navigation would not carry. The settings card calls these directly.
 *
 * QR payloads are pairing credentials — they are returned to the admin from
 * here (never through PostgREST, the column grant excludes last_qr) and the
 * hooks layer marks the query no-store so nothing caches them.
 */

// MESSAGES_UPDATE carries WhatsApp's server ack for our own sends — the only
// signal that a message Evolution accepted (201) was later rejected (463).
// Without it a rejected reminder stays `sent` forever, in the log and the inbox.
const WEBHOOK_EVENTS = [
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
  "CONNECTION_UPDATE",
  "QRCODE_UPDATED",
];
export const EVOLUTION_WEBHOOK_HEADER = "x-danat-webhook-secret";

/** يقصر إدارة اتصال واتساب على من يملك صلاحية إدارة التكاملات، ويسجّل الرفض. */
async function assertCanManageIntegrations(context: PermissionContext) {
  await requirePermission(context, {
    code: "settings.integrations",
    attempted: "whatsapp.manage_session",
    refusal: "You do not have permission to manage the WhatsApp connection.",
  });
}

/**
 * يقرأ صف إعداد مزوّد evolution_api (سواء كان مفعّلاً أم لا).
 *
 * The QR card must work BEFORE the provider is enabled — pairing first, then
 * flipping the toggle is the natural admin order — so this reads the seeded
 * row regardless of is_enabled.
 */
export async function loadEvolutionProviderConfig(
  explicitCompanyId?: string,
): Promise<Tables<"provider_configs">> {
  const companyId = explicitCompanyId ?? requireRequestCompany().id;
  const result = await companyClient(companyId)
    .from("provider_configs")
    .select("*")
    .eq("provider", "evolution_api")
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) {
    throw new Error("The evolution_api provider row is missing. Apply migrations 177-178 first.");
  }
  return result.data;
}

/** يقرأ صف الجلسة المفرد من قاعدة البيانات أو يعيد null إن لم يُقترن بعد. */
async function loadConnectionRow(
  companyId: string,
): Promise<Tables<"evolution_connections"> | null> {
  const result = await companyClient(companyId)
    .from("evolution_connections")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

/**
 * يشتق اسم نسخة Evolution الخاصة بالشركة من معرّفها، ولا يقرأه من الصف المخزَّن.
 *
 * Evolution instance names are global on a shared Evolution server, and the
 * stored column defaults to the single-company `danat` (migration 179), so a
 * stored name could point at another company's paired session. Deriving it
 * means pairing, re-hooking and logging out can only ever touch this
 * company's own instance (T052s).
 *
 * Limit until T157/T158/T172: the webhook route is still platform-wide, so the
 * deployment supports one company with WhatsApp connected at a time.
 */
export function companyInstanceName(companyId: string): string {
  return `ijary-${companyId}`;
}

/**
 * يبني عنوان الويبهوك العام الذي يستدعيه Evolution عند وصول الأحداث.
 */
function webhookUrl(): string {
  const base = process.env.APP_BASE_URL;
  if (!base) {
    throw new Error("APP_BASE_URL is not set; Evolution cannot deliver webhooks without it.");
  }
  return `${base.replace(/\/+$/, "")}/api/public/evolution-webhook`;
}

/**
 * هل تعني هذه الاستجابة أن النسخة موجودة مسبقاً؟
 *
 * Evolution answers instance-name collisions with a 4xx whose body names the
 * instance; there is no dedicated status code, so match on the message.
 */
function isAlreadyExists(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const text = `${error.message} ${JSON.stringify((error as { body?: unknown }).body ?? "")}`;
  return /already|in use|exists/i.test(text);
}

/**
 * يبدأ (أو يجدّد) جلسة الاقتران: يضبط الويبهوك بسر جديد ثم يعيد رمز QR.
 *
 * Order matters for rotation safety: Evolution is configured with the new
 * secret FIRST, and only a successful configuration persists it (the previous
 * secret stays accepted via previous_webhook_secret). A failure after we
 * created a brand-new instance rolls that instance back; a pre-existing
 * instance is never deleted by rollback — it may be the live paired session.
 */
export const beginEvolutionSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertCanManageIntegrations(context as never);

    const companyId = requireRequestCompany().id;
    const db = companyClient(companyId);
    const providerConfig = await loadEvolutionProviderConfig(companyId);
    const client = evolutionClientFromConfig(providerConfig.config);
    const existing = await loadConnectionRow(companyId);
    const instanceName = companyInstanceName(companyId);
    const secret = randomBytes(32).toString("base64url");
    const webhook: EvolutionWebhookConfig = {
      url: webhookUrl(),
      headers: { [EVOLUTION_WEBHOOK_HEADER]: secret },
      events: WEBHOOK_EVENTS,
    };

    let createdInstance = false;
    // Deliberately does NOT disarm `disconnect_alert_armed`: re-pairing while
    // already `open` (e.g. rotating the webhook secret) would leave an `open`
    // row unarmed with no transition back into `open` to re-arm it.
    try {
      await client.createInstance({ instanceName, webhook });
      createdInstance = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await client.setWebhook(instanceName, webhook);
    }

    try {
      // Evolution accepted the new secret — now it is safe to persist it.
      const upsert = await db.from("evolution_connections").upsert(
        {
          id: 1,
          company_id: companyId,
          instance_name: instanceName,
          webhook_secret: secret,
          previous_webhook_secret: existing?.webhook_secret ?? null,
        },
        { onConflict: "company_id,id" },
      );
      if (upsert.error) throw new Error(upsert.error.message);

      const connection = await client.connect(instanceName);
      const qr = extractQr(connection);
      const state =
        extractState(connection) ?? (qr ? "connecting" : (existing?.last_connection_state ?? null));
      const update = await db
        .from("evolution_connections")
        .update({ last_qr: qr, last_connection_state: state })
        .eq("id", 1);
      if (update.error) throw new Error(update.error.message);
      return { qr, state };
    } catch (error) {
      if (createdInstance) {
        await client.deleteInstance(instanceName).catch(() => undefined);
      }
      throw error;
    }
  });

const statusSchema = z.object({ refreshQr: z.boolean().optional() });

/**
 * يستطلع حالة الاقتران أثناء عرض رمز QR، مع تجديد اختياري للرمز.
 *
 * On "open" the QR is cleared immediately — it is a spent pairing credential —
 * and the connected number is stamped so the settings card can show it.
 */
export const getEvolutionQrStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(statusSchema)
  .handler(async ({ data, context }) => {
    await assertCanManageIntegrations(context as never);

    const companyId = requireRequestCompany().id;
    const db = companyClient(companyId);
    const row = await loadConnectionRow(companyId);
    if (!row) return { qr: null, state: null, connectedNumber: null };
    const providerConfig = await loadEvolutionProviderConfig(companyId);
    const client = evolutionClientFromConfig(providerConfig.config);

    const instanceName = companyInstanceName(companyId);
    let qr = row.last_qr;
    if (data.refreshQr) {
      const connection = await client.connect(instanceName);
      qr = extractQr(connection) ?? qr;
    }

    const state = await client
      .connectionState(instanceName)
      .then(extractState)
      .catch(() => row.last_connection_state);

    if (state === "open") {
      const connectedNumber =
        row.connected_number ?? (await connectedNumberFor(client, instanceName));
      const update = await db
        .from("evolution_connections")
        .update({
          last_connection_state: state,
          last_qr: null,
          connected_number: connectedNumber,
          connected_at: row.connected_at ?? new Date().toISOString(),
        })
        .eq("id", 1);
      if (update.error) throw new Error(update.error.message);
      return { qr: null, state, connectedNumber };
    }

    const update = await db
      .from("evolution_connections")
      .update({ last_connection_state: state, last_qr: qr })
      .eq("id", 1);
    if (update.error) throw new Error(update.error.message);
    return { qr, state, connectedNumber: row.connected_number };
  });

/**
 * يفصل الجلسة: تسجيل خروج وحذف على أفضل جهد، ثم تدوين الحالة بصدق.
 *
 * An unreachable Evolution must never block a local disconnect, but the admin
 * must not be told the session closed when the remote side may still be
 * paired — that is what the disconnect_failed state is for.
 */
export const disconnectEvolutionSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertCanManageIntegrations(context as never);

    const companyId = requireRequestCompany().id;
    const db = companyClient(companyId);
    const row = await loadConnectionRow(companyId);
    if (!row) return { disconnected: false, state: null };
    const providerConfig = await loadEvolutionProviderConfig(companyId);
    const client = evolutionClientFromConfig(providerConfig.config);

    // Disarm BEFORE calling `client.logout`, because Evolution can fire its
    // `close` webhook while `logout` is in flight; writing `disconnecting` in
    // the same UPDATE preserves the `open => armed` invariant if logout throws.
    const disarm = await db
      .from("evolution_connections")
      .update({ disconnect_alert_armed: false, last_connection_state: "disconnecting" })
      .eq("id", 1);
    if (disarm.error) throw new Error(disarm.error.message);

    const instanceName = companyInstanceName(companyId);
    let remoteOk = true;
    try {
      await client.logout(instanceName);
    } catch {
      remoteOk = false;
    }
    try {
      await client.deleteInstance(instanceName);
    } catch {
      remoteOk = false;
    }

    const state = remoteOk ? "close" : "disconnect_failed";
    const update = await db
      .from("evolution_connections")
      .update({
        disconnect_alert_armed: false,
        last_connection_state: state,
        last_qr: null,
        connected_number: null,
        connected_at: null,
      })
      .eq("id", 1);
    if (update.error) throw new Error(update.error.message);
    return { disconnected: remoteOk, state };
  });
