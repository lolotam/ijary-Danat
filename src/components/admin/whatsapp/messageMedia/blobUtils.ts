/**
 * يحوّل base64 نظيف إلى Uint8Array ثم إلى Blob مصنّف بنوع MIME.
 *
 * يعتمد على atob الموجود في المتصفح؛ الاختبارات تعمل في jsdom الذي يوفّره.
 * الفصل إلى دالتين يجعل المنطق قابلاً للاختبار دون الحاجة لـ Blob URL.
 */

/**
 * يحوّل سلسلة base64 إلى مصفوفة بايتات.
 *
 * نستخدم atob ثم charCodeAt لكل حرف لأن Buffer غير متاح في المتصفح،
 * وهذا هو نفس المسار الذي كانت تستخدمه saveBase64File قبل الانتقال للـ Blobs.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * يحوّل base64 ونوع MIME إلى Blob جاهز للعرض عبر object URL.
 *
 * إنشاء الـ Blob هنا يضمن أن <video> يمكنه الـ seeking وأن ذاكرة التخزين
 * لا تحمل سلسلة base64 مضاعفة الحجم (10MB تصبح ~13MB نصاً لو بقيت data:URL).
 */
export function base64ToBlob(base64: string, mimeType: string): Blob {
  const bytes = base64ToUint8Array(base64);
  return new Blob([bytes as unknown as BlobPart], { type: mimeType || "application/octet-stream" });
}
