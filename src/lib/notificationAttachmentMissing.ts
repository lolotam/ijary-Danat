import type { Json } from "@/integrations/supabase/database.types";

/**
 * يقرأ من حمولة الإشعار رموز المستندات التي أُرسلت الرسالة بدون ملف PDF لها.
 *
 * The senders stamp `attachment_missing` only when a PDF was actually left off
 * (see `notifyPaymentSuccess` and `sendInvoiceToTenant`), so an empty list means
 * "complete send". Rows written before the key existed read as complete too,
 * which is the one reading that cannot raise a false alarm.
 */
export function attachmentMissingCodes(payload: Json | null): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const codes = payload.attachment_missing;
  if (!Array.isArray(codes)) return [];
  return codes.filter((code): code is string => typeof code === "string" && code.length > 0);
}
