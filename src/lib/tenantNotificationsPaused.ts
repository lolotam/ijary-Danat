import type { NotificationAudience } from "@/integrations/supabase/database.types";

/**
 * سبب تخطّي الإشعار لأن إشعارات المستأجر موقوفة.
 *
 * One sentence for both places that decide it — the enqueue path and the
 * dispatch path — so the Notification Log reads the same whether the row was
 * held back before it was queued for sending, or after it was queued and the
 * switch was turned on.
 */
export const TENANT_PAUSED_REASON = "Tenant notifications are paused.";

/**
 * هل هذا الجمهور مربوط بالمستأجر — أي هل يشمله مفتاح إيقاف إشعارات المستأجر؟
 *
 * `tenant` and `both` reach the tenant, so the pause covers them. `admin` and
 * `system` do not: the office keeps its copies, and the owner decision
 * 2026-10-20 says so explicitly. A missing audience is the column default —
 * `tenant` — so an unset value counts as tenant-bound rather than as a row
 * that quietly escapes the switch.
 */
export function isTenantBoundAudience(audience: NotificationAudience | null | undefined): boolean {
  const resolved = audience ?? "tenant";
  return resolved === "tenant" || resolved === "both";
}
