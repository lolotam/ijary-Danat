import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { isReportableSkip } from "@/fns/notificationSkip";
import { EvolutionApiError, extractState } from "@/lib/evolution/client";
import { evolutionClientFromConfig } from "@/lib/providers/evolution";

/**
 * مراقبا انقطاع جلسة واتساب QR: تأكيد ويبهوك الانقطاع، وتسجيل الانقطاع المرصود أثناء الإرسال.
 *
 * The state lives in `whatsapp_connections` — one row per company and method —
 * so a dropped session belongs to the company that owns it and its alert
 * reaches that company's staff only.
 *
 * Uses dynamic `import("@/fns/notifyWhatsappSessionDisconnected")` because
 * `notifyWhatsappSessionDisconnected` → `enqueueNotification` → `dispatchNotification` →
 * `evolutionDelivery` → this module forms a real circular import graph.
 */

/** الشركة والاتصال اللذان تراقبهما جلسة QR. */
export interface EvolutionSessionTarget {
  companyId: string;
  connectionId: string;
}

/**
 * يستدعي مُرسِل تنبيه الانقطاع ويسجّل أي تخطٍّ غير حميد (سوء إعداد أو خطأ قاعدة بيانات).
 */
async function dispatchDisconnectAlert(
  source: "webhook" | "send",
  target: EvolutionSessionTarget,
): Promise<void> {
  const { notifyWhatsappSessionDisconnected } =
    await import("@/fns/notifyWhatsappSessionDisconnected");
  const alertResult = await notifyWhatsappSessionDisconnected({ source, ...target });
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
export async function confirmSessionDisconnect(target: EvolutionSessionTarget): Promise<void> {
  try {
    const db = companyClient(target.companyId);
    const rowResult = await db
      .from("whatsapp_connections")
      .select("instance_name, status, disconnect_alert_armed")
      .eq("id", target.connectionId)
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
      rowResult.data.status === "connected"
    ) {
      return;
    }
    // Without an instance name there is nothing to probe: the connection was
    // never paired, so there is no session that could have dropped.
    if (!rowResult.data.instance_name) return;

    const providerResult = await db
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
        await dispatchDisconnectAlert("webhook", target);
      }
      return;
    }

    if (liveState === "open") {
      const heal = await db
        .from("whatsapp_connections")
        .update({
          status: "connected",
          last_seen_at: new Date().toISOString(),
          disconnected_at: null,
          disconnect_alert_armed: true,
        })
        .eq("id", target.connectionId)
        .or("connected_number.not.is.null,connected_at.not.is.null");
      if (heal.error) {
        console.error("[evolutionSessionWatch] failed to heal session state", heal.error.message);
      }
      return;
    }

    await dispatchDisconnectAlert("webhook", target);
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
 * Conditionally flips `connected` → `disconnected` so the row records when the
 * session went down and the admin banner appears even when Evolution's webhook
 * never arrived.
 */
export async function reportSendSessionDisconnected(): Promise<void> {
  try {
    const companyId = requireRequestCompany().id;
    const db = companyClient(companyId);
    const connection = await db
      .from("whatsapp_connections")
      .select("id")
      .eq("method", "evolution_qr")
      .eq("is_active", true)
      .maybeSingle();
    if (connection.error) {
      console.error(
        "[evolutionSessionWatch] failed to read the active connection",
        connection.error.message,
      );
      return;
    }
    if (!connection.data) return;

    const target: EvolutionSessionTarget = {
      companyId,
      connectionId: connection.data.id,
    };
    const closeUpdate = await db
      .from("whatsapp_connections")
      .update({ status: "disconnected", disconnected_at: new Date().toISOString() })
      .eq("id", target.connectionId)
      .eq("status", "connected");
    if (closeUpdate.error) {
      console.error(
        "[evolutionSessionWatch] failed to mark connection close",
        closeUpdate.error.message,
      );
    }

    await dispatchDisconnectAlert("send", target);
  } catch (error) {
    console.error(
      "[evolutionSessionWatch] reportSendSessionDisconnected failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}
