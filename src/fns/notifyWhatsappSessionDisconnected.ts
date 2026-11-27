import type { SupabaseClient } from "@supabase/supabase-js";

import { companyClient } from "@/company/companyClient.server";
import { companyOriginById } from "@/company/companyUrl.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import {
  loadCompanyDefaults,
  renderAdminEmailCopy,
  type AdminNotificationResult,
} from "@/fns/adminEmailNotification";
import { enqueueNotification, resolveNotificationRecipients } from "@/fns/enqueueNotification";
import { runEventWorkflow } from "@/fns/workflowRegistry";
import type { Database, WhatsappConnectionStatus } from "@/integrations/supabase/database.types";
import type { EmailLocale } from "@/lib/emailTemplates";
import type { WorkflowRecipientTarget } from "@/lib/workflowCatalog";

export type DisconnectAlertSource = "webhook" | "send";
type AlertDb = SupabaseClient<Database>;

/** صفّ اتصال واتساب الذي تُراقَب جلسته، كما تقرؤه قاعدة البيانات. */
interface WatchedConnection {
  id: string;
  instance_name: string | null;
  connected_number: string | null;
  status: WhatsappConnectionStatus;
  disconnect_alert_armed: boolean;
  disconnected_at: string | null;
}

/**
 * ينسّق طابع وقت الانقطاع بتوقيت الكويت للعرض في رسالة البريد.
 */
function formatKuwaitDisconnectTime(iso: string | null, locale: EmailLocale): string {
  if (!iso) return "-";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-KW-u-nu-latn" : "en-KW", {
    timeZone: "Asia/Kuwait",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

/**
 * يقرأ صفّ اتصال واتساب الذي تُراقَب جلسته: الاتصال المطلوب صراحةً، أو
 * النشط بطريقة QR في الشركة.
 *
 * A company has one QR connection per company and method, so the active one
 * is the only session that can drop while the company is sending.
 */
async function readWatchedConnection(
  db: AlertDb,
  connectionId: string | null,
): Promise<{ data: WatchedConnection | null; error: { message: string } | null }> {
  const query = db
    .from("whatsapp_connections")
    .select("id, instance_name, connected_number, status, disconnect_alert_armed, disconnected_at")
    .eq("method", "evolution_qr");
  const result = connectionId
    ? await query.eq("id", connectionId).maybeSingle()
    : await query.eq("is_active", true).maybeSingle();
  return { data: result.data ?? null, error: result.error };
}

/**
 * يعيد تسليح حلقة التنبيه عند تعذّر إدراج البريد ما دامت الجلسة مقترنة وغير متصلة.
 */
async function rearmDisconnectAlert(db: AlertDb, connectionId: string): Promise<void> {
  try {
    const rearmResult = await db
      .from("whatsapp_connections")
      .update({ disconnect_alert_armed: true })
      .eq("id", connectionId)
      .neq("status", "connected")
      .or("connected_number.not.is.null,connected_at.not.is.null");
    if (rearmResult.error) {
      console.error("[notifyWhatsappSessionDisconnected] re-arm failed", rearmResult.error.message);
    }
  } catch (error) {
    console.error(
      "[notifyWhatsappSessionDisconnected] re-arm threw",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * يعدّ إشعارات واتساب المتوقفة بسبب انقطاع الجلسة أو غياب النسخة لعرضها في البريد.
 */
async function countParkedWhatsappMessages(db: AlertDb): Promise<number> {
  try {
    const parkedCountResult = await db
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .in("error_code", ["session_disconnected", "instance_missing"])
      .in("state", ["failed", "needs_review"]);
    if (parkedCountResult.error) {
      console.error(
        "[notifyWhatsappSessionDisconnected] failed to count parked messages",
        parkedCountResult.error.message,
      );
      return 0;
    }
    return parkedCountResult.count ?? 0;
  } catch (error) {
    console.error(
      "[notifyWhatsappSessionDisconnected] parked message count threw",
      error instanceof Error ? error.message : String(error),
    );
    return 0;
  }
}

/**
 * يطالب بالحلقة ذرّياً، يبني رسالة البريد الإدارية، ويدرجها — ويعيد التسليح عند أي فشل.
 */
async function claimAndEnqueueAlert(
  db: AlertDb,
  companyId: string,
  connection: WatchedConnection,
  source: DisconnectAlertSource,
  targets: WorkflowRecipientTarget[],
): Promise<AdminNotificationResult> {
  const adminEmails = await resolveNotificationRecipients(targets, companyId);
  if (!adminEmails.length) {
    return { skipped: true, reason: "No admin email recipients configured." };
  }

  const claim = await db
    .from("whatsapp_connections")
    .update({ disconnect_alert_armed: false })
    .eq("id", connection.id)
    .eq("disconnect_alert_armed", true)
    .neq("status", "connected")
    .select("id, instance_name, connected_number, status, disconnected_at");
  if (claim.error) {
    return { skipped: true, reason: claim.error.message };
  }

  const claimed = (claim.data as WatchedConnection[] | null)?.[0];
  if (!claimed) {
    return { skipped: true, reason: "Already alerted for this outage.", benign: true };
  }

  try {
    const { locale } = await loadCompanyDefaults(companyId);
    const parkedCount = await countParkedWhatsappMessages(db);
    const settingsUrl = `${await companyOriginById(db, companyId)}/admin/settings/integrations`;
    const observedState = claimed.status ?? "unknown";
    const connectedNumber = claimed.connected_number ?? "-";
    const instanceName = claimed.instance_name ?? "-";
    const disconnectedAt = formatKuwaitDisconnectTime(claimed.disconnected_at, locale);

    const copy = await renderAdminEmailCopy({
      code: "whatsapp-session-disconnected",
      locale,
      variables: {
        connected_number: connectedNumber,
        instance_name: instanceName,
        state: observedState,
        disconnected_at: disconnectedAt,
        parked_count: String(parkedCount),
        settings_url: settingsUrl,
      },
      fallbackSubject:
        locale === "ar"
          ? `تنبيه: انقطعت جلسة واتساب (${instanceName})`
          : `Alert: WhatsApp session disconnected (${instanceName})`,
      fallbackBody: (safe) =>
        locale === "ar"
          ? `<p>انقطعت جلسة واتساب QR وتوقّف إرسال رسائل واتساب مؤقتاً حتى يُعاد مسح رمز QR.</p><ul><li><strong>النسخة:</strong> ${safe.instance_name}</li><li><strong>الرقم المربوط:</strong> ${safe.connected_number}</li><li><strong>الحالة المرصودة:</strong> ${safe.state}</li><li><strong>وقت الانقطاع:</strong> ${safe.disconnected_at}</li><li><strong>الرسائل المعلّقة:</strong> ${safe.parked_count}</li></ul><p><a href="${safe.settings_url}">فتح إعدادات التكامل لإعادة الربط</a></p>`
          : `<p>The WhatsApp QR session has disconnected and WhatsApp messages will remain held until the QR code is rescanned.</p><ul><li><strong>Instance:</strong> ${safe.instance_name}</li><li><strong>Linked number:</strong> ${safe.connected_number}</li><li><strong>Observed state:</strong> ${safe.state}</li><li><strong>Disconnected at:</strong> ${safe.disconnected_at}</li><li><strong>Held messages:</strong> ${safe.parked_count}</li></ul><p><a href="${safe.settings_url}">Open integrations settings to reconnect</a></p>`,
    });

    const notification = await enqueueNotification({
      type: "whatsapp_session_alert",
      channel: "email",
      audience: "admin",
      companyId,
      locale: copy.locale,
      subject: copy.subject,
      body: copy.body,
      recipientAddress: adminEmails[0],
      templateCode: copy.code,
      payload: {
        source,
        observed_state: observedState,
        disconnected_at: claimed.disconnected_at,
        recipients: adminEmails,
      },
    });

    if (!notification) {
      await rearmDisconnectAlert(db, connection.id);
      return { skipped: true, reason: `Template ${copy.code} excludes the email channel.` };
    }

    return { skipped: false, notification };
  } catch (error) {
    await rearmDisconnectAlert(db, connection.id);
    return {
      skipped: true,
      reason: error instanceof Error ? error.message : "Failed to enqueue session alert.",
    };
  }
}

/**
 * يرسل تنبيهاً بريدياً فورياً للإدارة عند انقطاع جلسة واتساب QR، لمرة واحدة لكل حلقة انقطاع.
 */
export async function notifyWhatsappSessionDisconnected(input: {
  source: DisconnectAlertSource;
  companyId?: string;
  connectionId?: string;
}): Promise<AdminNotificationResult> {
  try {
    const companyId = input.companyId ?? requireRequestCompany().id;
    const db = companyClient(companyId);

    const read = await readWatchedConnection(db, input.connectionId ?? null);
    if (read.error) {
      console.error(
        "[notifyWhatsappSessionDisconnected] failed to read session state",
        read.error.message,
      );
      return { skipped: true, reason: read.error.message };
    }
    const connection = read.data;
    if (!connection) {
      return { skipped: true, reason: "No WhatsApp connection is active.", benign: true };
    }
    if (!connection.disconnect_alert_armed || connection.status === "connected") {
      return { skipped: true, reason: "Session alert not armed.", benign: true };
    }

    const provider = await db
      .from("provider_configs")
      .select("is_enabled")
      .eq("provider", "evolution_api")
      .maybeSingle();
    if (provider.error) {
      console.error(
        "[notifyWhatsappSessionDisconnected] failed to read provider config",
        provider.error.message,
      );
      return { skipped: true, reason: provider.error.message };
    }
    if (!provider.data?.is_enabled) {
      return { skipped: true, reason: "Evolution provider is disabled.", benign: true };
    }

    return await runEventWorkflow<AdminNotificationResult>({
      key: "whatsapp-session-disconnected",
      whenPaused: () => ({ skipped: true, reason: "Workflow is paused.", benign: true }),
      run: (targets) => claimAndEnqueueAlert(db, companyId, connection, input.source, targets),
      outcomeOf: (result) =>
        result.skipped
          ? { status: "skipped", error: result.reason }
          : { status: "success", error: null },
    });
  } catch (error) {
    return {
      skipped: true,
      reason: error instanceof Error ? error.message : "Session alert failed unexpectedly.",
    };
  }
}
