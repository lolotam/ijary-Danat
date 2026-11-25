import type { WorkflowRunStatus } from "@/fns/workflowRegistry";

/**
 * تصنيف نتائج إرسال إشعارات الدفع: نجاح، تخطٍ مقصود بلا خطأ، أو فشل فعلي.
 *
 * Three outcomes, not two. `nothingToDo` marks the returns that are correct
 * rather than broken — most importantly "No confirmed payments.", which is what
 * a declined KNET transaction produces.
 */
export type PaymentNotifyResult =
  | { ok: true; skipped: boolean; ids: string[]; missingPdfs?: string[] }
  | { ok: false; error: string; nothingToDo?: true };

/**
 * يحدد الدفعات التي كان يجب أن يُرفق بها ملف PDF ولم يُنشأ لها.
 *
 * The renderer never throws and drops a payment it cannot render, so the only
 * way to notice is to compare what was asked for with what came back. Without
 * this, 2026-09-24 → 09-27 shipped every receipt as text only while the
 * workflow run said "success".
 */
export function paymentsMissingPdf(
  expected: Array<{ id: string; code: string }>,
  rendered: Array<{ paymentId: string }>,
): string[] {
  const renderedIds = new Set(rendered.map((document) => document.paymentId));
  return expected.filter((payment) => !renderedIds.has(payment.id)).map((payment) => payment.code);
}

/**
 * مفتاح السجل الذي يعلن غياب ملف PDF، أو لا شيء إن لم يغب شيء.
 *
 * Absent rather than empty when nothing is missing, so a row carrying the key
 * always means a PDF really was left off.
 */
export function missingPdfPayload(codes: string[]): { attachment_missing?: string[] } {
  return codes.length ? { attachment_missing: codes } : {};
}

/**
 * يترجم نتيجة الإشعار إلى حالة تشغيل سير العمل التي يراها المسؤول.
 *
 * A receipt that went out without its PDF is recorded as an error even though
 * the message was sent: the send is deliberately not blocked (losing the
 * attachment is a degradation, losing the receipt is an outage), so this red
 * badge is the one place the degradation becomes visible.
 */
export function paymentNotifyOutcome(result: PaymentNotifyResult): {
  status: WorkflowRunStatus;
  error: string | null;
} {
  if (result.ok) {
    if (result.missingPdfs?.length) {
      return {
        status: "error",
        error: `Receipt PDF not generated for ${result.missingPdfs.join(", ")}; sent without it.`,
      };
    }
    return { status: "success", error: null };
  }
  if (result.nothingToDo) return { status: "skipped", error: result.error };
  return { status: "error", error: result.error };
}
