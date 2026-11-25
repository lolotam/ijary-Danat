import {
  loadCompanyDefaults,
  renderAdminEmailCopy,
  type AdminNotificationResult,
} from "@/fns/adminEmailNotification";
import { enqueueNotification, resolveNotificationRecipients } from "@/fns/enqueueNotification";
import { runEventWorkflow } from "@/fns/workflowRegistry";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { EmailLocale } from "@/lib/emailTemplates";
import type { WorkflowRecipientTarget } from "@/lib/workflowCatalog";

export type DisconnectAlertSource = "webhook" | "send";

interface ClaimedSessionRow {
  instance_name: string;
  connected_number: string | null;
  last_connection_state: string | null;
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
 * يعيد تسليح حلقة التنبيه عند تعذّر إدراج البريد ما دامت الجلسة مقترنة وغير مفتوحة وغير جارية الفصل.
 *
 * Restores the atomic claim when building or inserting the notification fails
 * so a transient error never drops the single alert for an outage episode.
 * Guarded against `open` (concurrent re-pair), `disconnecting` (in-flight admin
 * logout), and unpaired rows (`connected_number` and `connected_at` cleared by
 * a completed intentional `disconnectEvolutionSession`).
 */
async function rearmDisconnectAlert(): Promise<void> {
  try {
    const rearmResult = await supabaseAdmin
      .from("evolution_connections")
      .update({ disconnect_alert_armed: true })
      .eq("id", 1)
      .not("last_connection_state", "in", "(open,disconnecting)")
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
async function countParkedWhatsappMessages(): Promise<number> {
  try {
    const parkedCountResult = await supabaseAdmin
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
 *
 * Uses a single conditional UPDATE instead of `alreadyNotified` + cooldown so
 * concurrent webhook/send callers race cleanly inside Postgres and every fresh
 * outage after a re-pair alerts immediately.
 */
async function claimAndEnqueueAlert(
  source: DisconnectAlertSource,
  targets: WorkflowRecipientTarget[],
): Promise<AdminNotificationResult> {
  const adminEmails = await resolveNotificationRecipients(targets);
  if (!adminEmails.length) {
    return { skipped: true, reason: "No admin email recipients configured." };
  }

  const claim = await supabaseAdmin
    .from("evolution_connections")
    .update({ disconnect_alert_armed: false })
    .eq("id", 1)
    .eq("disconnect_alert_armed", true)
    .neq("last_connection_state", "open")
    .select("instance_name, connected_number, last_connection_state, disconnected_at");
  if (claim.error) {
    return { skipped: true, reason: claim.error.message };
  }

  const claimed = (claim.data as ClaimedSessionRow[] | null)?.[0];
  if (!claimed) {
    return { skipped: true, reason: "Already alerted for this outage.", benign: true };
  }

  try {
    const { locale } = await loadCompanyDefaults();
    const parkedCount = await countParkedWhatsappMessages();
    const baseUrl = (process.env.APP_BASE_URL || "https://danat-future.com").replace(/\/+$/, "");
    const settingsUrl = `${baseUrl}/admin/settings/integrations`;
    const observedState = claimed.last_connection_state ?? "unknown";
    const connectedNumber = claimed.connected_number ?? "-";
    const disconnectedAt = formatKuwaitDisconnectTime(claimed.disconnected_at, locale);

    const copy = await renderAdminEmailCopy({
      code: "whatsapp-session-disconnected",
      locale,
      variables: {
        connected_number: connectedNumber,
        instance_name: claimed.instance_name,
        state: observedState,
        disconnected_at: disconnectedAt,
        parked_count: String(parkedCount),
        settings_url: settingsUrl,
      },
      fallbackSubject:
        locale === "ar"
          ? `تنبيه: انقطعت جلسة واتساب (${claimed.instance_name})`
          : `Alert: WhatsApp session disconnected (${claimed.instance_name})`,
      fallbackBody: (safe) =>
        locale === "ar"
          ? `<p>انقطعت جلسة واتساب QR وتوقّف إرسال رسائل واتساب مؤقتاً حتى يُعاد مسح رمز QR.</p><ul><li><strong>النسخة:</strong> ${safe.instance_name}</li><li><strong>الرقم المربوط:</strong> ${safe.connected_number}</li><li><strong>الحالة المرصودة:</strong> ${safe.state}</li><li><strong>وقت الانقطاع:</strong> ${safe.disconnected_at}</li><li><strong>الرسائل المعلّقة:</strong> ${safe.parked_count}</li></ul><p><a href="${safe.settings_url}">فتح إعدادات التكامل لإعادة الربط</a></p>`
          : `<p>The WhatsApp QR session has disconnected and WhatsApp messages will remain held until the QR code is rescanned.</p><ul><li><strong>Instance:</strong> ${safe.instance_name}</li><li><strong>Linked number:</strong> ${safe.connected_number}</li><li><strong>Observed state:</strong> ${safe.state}</li><li><strong>Disconnected at:</strong> ${safe.disconnected_at}</li><li><strong>Held messages:</strong> ${safe.parked_count}</li></ul><p><a href="${safe.settings_url}">Open integrations settings to reconnect</a></p>`,
    });

    const notification = await enqueueNotification({
      type: "whatsapp_session_alert",
      channel: "email",
      audience: "admin",
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
      await rearmDisconnectAlert();
      return { skipped: true, reason: `Template ${copy.code} excludes the email channel.` };
    }

    return { skipped: false, notification };
  } catch (error) {
    await rearmDisconnectAlert();
    return {
      skipped: true,
      reason: error instanceof Error ? error.message : "Failed to enqueue session alert.",
    };
  }
}

/**
 * يرسل تنبيهاً بريدياً فورياً للإدارة عند انقطاع جلسة واتساب QR، لمرة واحدة لكل حلقة انقطاع.
 *
 * Cheap pre-read avoids touching `cron_jobs` during drain retries on an already
 * alerted outage; never throws so webhook and delivery callers stay safe.
 */
export async function notifyWhatsappSessionDisconnected(input: {
  source: DisconnectAlertSource;
}): Promise<AdminNotificationResult> {
  try {
    const preRead = await supabaseAdmin
      .from("evolution_connections")
      .select("disconnect_alert_armed, last_connection_state")
      .eq("id", 1)
      .maybeSingle();
    if (preRead.error) {
      console.error(
        "[notifyWhatsappSessionDisconnected] failed to read session state",
        preRead.error.message,
      );
      return { skipped: true, reason: preRead.error.message };
    }
    if (
      !preRead.data ||
      !preRead.data.disconnect_alert_armed ||
      preRead.data.last_connection_state === "open"
    ) {
      return { skipped: true, reason: "Session alert not armed.", benign: true };
    }

    const provider = await supabaseAdmin
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
      run: (targets) => claimAndEnqueueAlert(input.source, targets),
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
