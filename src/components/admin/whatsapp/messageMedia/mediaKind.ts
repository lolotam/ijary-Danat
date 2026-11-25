import type { WhatsappMessageRow } from "@/integrations/supabase/database.types";

export type MediaKind = "image" | "video" | "audio" | "pdf" | "document";

/**
 * يحدّد إن كان المستند مرشّحاً لمعاينة PDF قبل جلبه.
 *
 * قاعدة البيانات لا تخزّن نوع MIME، فقبل الجلب لا يوجد سوى الاسم. واتساب يرسل
 * كثيراً من المستندات **بلا اسم أصلاً** — `extractMedia` في
 * `evolutionWebhook.ts` يخزّن null حين لا يرسله المزوّد — والمستند بلا اسم في
 * هذا الصندوق هو PDF في الغالب (عقود وإيصالات). لذلك يُعامَل غياب الاسم
 * كترشيح: نجلب الملف ثم يحكم MIME. اسم ينتهي بامتداد آخر (docx, zip) لا
 * يُجلب إطلاقاً، فلا ندفع ثمن تنزيل كل مرفق بحثاً عن نوعه.
 */
export function isPdfCandidate(
  row: Pick<WhatsappMessageRow, "media_type" | "media_filename">,
): boolean {
  if (row.media_type !== "document") return false;
  const name = row.media_filename?.trim();
  if (!name) return true;
  return name.toLowerCase().endsWith(".pdf");
}

/**
 * يحدّد نوع العرض للرسالة من نوع الوسيط واسم الملف ونوع MIME العائد من الخادم.
 *
 * قبل الجلب لا نملك سوى media_type + media_filename فنعتمد
 * {@link isPdfCandidate}؛ بعد الجلب يصبح MIME هو الحكم ولو كذب الاسم، فملف
 * مسمّى ‎.pdf‎ لكنه zip يعود لشريحة المستندات، ومستند بلا اسم تبيّن أنه PDF
 * يحصل على معاينته.
 */
export function resolveMediaKind(
  row: Pick<WhatsappMessageRow, "media_type" | "media_filename">,
  mimeType?: string | null,
): MediaKind | null {
  if (!row.media_type) return null;
  if (row.media_type === "image" || row.media_type === "sticker") return "image";
  if (row.media_type === "video") return "video";
  if (row.media_type === "audio") return "audio";
  if (row.media_type === "document") {
    if (mimeType != null) {
      const baseMime = mimeType.split(";")[0].trim().toLowerCase();
      return baseMime === "application/pdf" ? "pdf" : "document";
    }
    return isPdfCandidate(row) ? "pdf" : "document";
  }
  return "document";
}
