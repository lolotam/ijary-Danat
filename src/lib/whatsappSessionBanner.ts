/**
 * منطق ظهور شريط تحذير جلسة واتساب وقراءة مخرجات دالة الصحة من القاعدة.
 *
 * Pure state machine with no browser clock (`nowMs`): transient `connecting`
 * windows are settled server-side inside `whatsapp_session_health().settling`.
 */

export interface WhatsappSessionHealth {
  enabled: boolean;
  paired: boolean;
  state: string | null;
  settling: boolean;
  disconnected_at: string | null;
  parked_count: number;
}

export type WhatsappSessionBannerState = "hidden" | "never_paired" | "disconnected";

/**
 * يتحقق من بنية كائن Json القادم من `whatsapp_session_health` قبل اعتماده.
 */
export function parseWhatsappSessionHealth(value: unknown): WhatsappSessionHealth | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.enabled !== "boolean" ||
    typeof record.paired !== "boolean" ||
    (record.state !== null && typeof record.state !== "string") ||
    typeof record.settling !== "boolean" ||
    (record.disconnected_at !== null && typeof record.disconnected_at !== "string") ||
    typeof record.parked_count !== "number" ||
    !Number.isFinite(record.parked_count)
  ) {
    return null;
  }
  return {
    enabled: record.enabled,
    paired: record.paired,
    state: record.state,
    settling: record.settling,
    disconnected_at: record.disconnected_at,
    parked_count: record.parked_count,
  };
}

/**
 * يقرّر حالة شريط التحذير في لوحة الإدارة انطلاقاً من صحة الجلسة.
 *
 * Order matches spec §5.2: missing/disabled/open/settling hide the banner so a
 * disabled provider or brief reconnect never triggers a false alarm.
 */
export function whatsappSessionBannerState(
  health: WhatsappSessionHealth | null | undefined,
): WhatsappSessionBannerState {
  if (!health) return "hidden";
  if (health.enabled !== true) return "hidden";
  if (health.state === "open") return "hidden";
  if (health.settling === true) return "hidden";
  if (health.paired === false) return "never_paired";
  return "disconnected";
}
