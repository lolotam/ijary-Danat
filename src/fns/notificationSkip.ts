import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/database.types";

type NotificationType = Database["public"]["Tables"]["notifications"]["Row"]["type"];

/**
 * أدوات مشتركة لمُرسِلي تنبيهات المشرفين: فحص التكرار، ووسم التخطّي الطبيعي.
 *
 * Nine senders each carried their own copy of the "already notified?" query,
 * and five callers each decided which skip was harmless by comparing the
 * sender's reason against string literals they did not own. Both rules now
 * live here, next to the senders that produce the reasons.
 */

/**
 * هل سُجّل تنبيه من هذا النوع لهذا الحمل من قبل؟ يرمي إن فشل الاستعلام.
 *
 * Throws rather than answering "no" on a query error. Every copy this replaced
 * returned `!existing.error && …`, so a transient PostgREST fault read as
 * "not yet notified" and the sender sent the admin a second copy. A throw
 * lands in the caller's existing catch and becomes a reported warning instead
 * of a silent duplicate.
 */
export async function alreadyNotified(
  type: NotificationType,
  payloadMatch: Record<string, Json>,
): Promise<boolean> {
  const existing = await supabaseAdmin
    .from("notifications")
    .select("id")
    .eq("type", type)
    .contains("payload", payloadMatch)
    .neq("state", "cancelled")
    .limit(1);
  if (existing.error) {
    throw new Error(
      `Could not check for an earlier ${type} notification: ${existing.error.message}`,
    );
  }
  return Boolean(existing.data?.length);
}

/**
 * هل هذا التخطّي يستحق تحذير المستخدم؟ لا، إن وسمه المُرسِل بأنه طبيعي.
 *
 * The sender knows why it skipped; the caller should not re-derive it from the
 * wording. "Already notified." and "Workflow is paused." are marked
 * `benign: true` where they are produced, so a sender gaining a new harmless
 * reason changes one line, not five callers.
 */
export function isReportableSkip<R extends { skipped: boolean }>(
  result: R,
): result is Extract<R, { skipped: true; reason: string }> {
  return result.skipped && !(result as { benign?: boolean }).benign;
}
