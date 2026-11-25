import { isReportableSkip } from "@/fns/notificationSkip";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { EvolutionApiError, extractState } from "@/lib/evolution/client";
import { evolutionClientFromConfig } from "@/lib/providers/evolution";

/**
 * مراقبا انقطاع جلسة واتساب QR: تأكيد ويبهوك الانقطاع، وتسجيل الانقطاع المرصود أثناء الإرسال.
 *
 * Uses dynamic `import("@/fns/notifyWhatsappSessionDisconnected")` because
 * `notifyWhatsappSessionDisconnected` → `enqueueNotification` → `dispatchNotification` →
 * `evolutionDelivery` → this module forms a real circular import graph.
 */

/**
 * يستدعي مُرسِل تنبيه الانقطاع ويسجّل أي تخطٍّ غير حميد (سوء إعداد أو خطأ قاعدة بيانات).
 */
async function dispatchDisconnectAlert(source: "webhook" | "send"): Promise<void> {
  const { notifyWhatsappSessionDisconnected } =
    await import("@/fns/notifyWhatsappSessionDisconnected");
  const alertResult = await notifyWhatsappSessionDisconnected({ source });
  if (isReportableSkip(alertResult)) {
    console.error(
      `[evolutionSessionWatch] disconnect alert skipped (${source}):`,
      alertResult.reason,
    );
  }
}

/**
 * يتحقّق بفحص حيّ واحد من انقطاع الجلسة بعد ويبهوك غير `open`/`connecting` ثم يطلق التنبيه.
 *
 * Heals out-of-order webhooks when the gateway reports `open`; treats HTTP 404
 * (`EvolutionApiError`) as a confirmed deleted-instance disconnect, and stays
 * silent on transient gateway errors so arming is preserved for the send path.
 */
export async function confirmSessionDisconnect(): Promise<void> {
  try {
    const rowResult = await supabaseAdmin
      .from("evolution_connections")
      .select("instance_name, disconnect_alert_armed, last_connection_state")
      .eq("id", 1)
      .maybeSingle();
    if (rowResult.error) {
      console.error(
        "[evolutionSessionWatch] failed to read connection row",
        rowResult.error.message,
      );
      return;
    }
    if (
      !rowResult.data ||
      !rowResult.data.disconnect_alert_armed ||
      rowResult.data.last_connection_state === "open"
    ) {
      return;
    }

    const providerResult = await supabaseAdmin
      .from("provider_configs")
      .select("is_enabled, config")
      .eq("provider", "evolution_api")
      .maybeSingle();
    if (providerResult.error) {
      console.error(
        "[evolutionSessionWatch] failed to read provider config",
        providerResult.error.message,
      );
      return;
    }
    if (!providerResult.data?.is_enabled) {
      return;
    }

    let liveState: string | null;
    try {
      const client = evolutionClientFromConfig(providerResult.data.config);
      liveState = extractState(await client.connectionState(rowResult.data.instance_name));
    } catch (error) {
      if (error instanceof EvolutionApiError && error.status === 404) {
        await dispatchDisconnectAlert("webhook");
      }
      return;
    }

    if (liveState === "open") {
      const heal = await supabaseAdmin
        .from("evolution_connections")
        .update({ last_connection_state: "open" })
        .eq("id", 1)
        .neq("last_connection_state", "disconnecting")
        .or("connected_number.not.is.null,connected_at.not.is.null");
      if (heal.error) {
        console.error("[evolutionSessionWatch] failed to heal session state", heal.error.message);
      }
      return;
    }

    await dispatchDisconnectAlert("webhook");
  } catch (error) {
    console.error(
      "[evolutionSessionWatch] confirmSessionDisconnect failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * يسجّل انقطاع الجلسة عند فشل إرسال فعلي ويستدعي مُرسِل تنبيه الإدارة.
 *
 * Conditionally flips `open` → `close` so the SQL trigger stamps `disconnected_at`
 * and the admin banner appears even when Evolution's webhook never arrived.
 */
export async function reportSendSessionDisconnected(): Promise<void> {
  try {
    const closeUpdate = await supabaseAdmin
      .from("evolution_connections")
      .update({ last_connection_state: "close" })
      .eq("id", 1)
      .eq("last_connection_state", "open");
    if (closeUpdate.error) {
      console.error(
        "[evolutionSessionWatch] failed to mark connection close",
        closeUpdate.error.message,
      );
    }

    await dispatchDisconnectAlert("send");
  } catch (error) {
    console.error(
      "[evolutionSessionWatch] reportSendSessionDisconnected failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}
