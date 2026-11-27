import type { GatewayPaymentMethod } from "@/integrations/supabase/database.types";

/*
 * مسار توافق مؤقت لبعض دوال الويب هوك القديمة التي لا يزال يستوردها
 * `paymentReconcileJob.ts`. انتقلت معالجة الويب هوك الفعلية إلى
 * `src/routes/api/public/webhooks/$provider.$connectionId.ts` و`src/jobs/handlers/inbound.ts`.
 */

export { canonicalSignatureString } from "@/lib/myfatoorahSignature";
export {
  invoicePaymentReference,
  settleGatewayPayment,
  type EventDetails,
} from "@/fns/gatewaySettlement";

/**
 * يطبّع اسم وسيلة الدفع العائدة من البوابة إلى القيم القياسية في قاعدة البيانات.
 */
export function normalizeMethod(value: string | null): GatewayPaymentMethod | null {
  const normalized = value?.toLowerCase().replace(/[\s_-]/g, "") ?? "";
  if (!normalized) return null;
  if (normalized.includes("knet")) return "knet";
  if (normalized.includes("applepay")) return "applepay";
  if (normalized.includes("googlepay")) return "googlepay";
  // The v3 hosted page can complete with any account-enabled method
  // (VISA/MASTER, MADA, AMEX, ...); the money has moved by the time we see
  // it, so record it as a card payment rather than failing settlement.
  return "card";
}
