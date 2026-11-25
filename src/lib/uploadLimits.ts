/**
 * سقف رفع الملفات إلى Storage، مطابق لـ `FILE_SIZE_LIMIT` على storage-api
 * في الإنتاج (50 ميبيبايت). حدود العميل الأصغر كانت ترفض المسوحات بينما
 * التخزين كان يقبل حتى هذا السقف.
 */
export const STORAGE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const STORAGE_UPLOAD_MAX_MB = 50;

/** مهلة الرفع في المتصفح. Kong كان يقطع الجسم بعد 60 ث في 2026-08-23. */
export const STORAGE_UPLOAD_TIMEOUT_MS = 180_000;
export const STORAGE_UPLOAD_TIMED_OUT = "STORAGE_UPLOAD_TIMED_OUT";
export const STORAGE_UPLOAD_CONNECTION_FAILED = "STORAGE_UPLOAD_CONNECTION_FAILED";

/**
 * يرفض المرفق إن تجاوز سقف Storage أو لم يكن PDF/صورة.
 */
export function assertPdfOrImageWithinStorageLimit(file: File): void {
  const isPdf = file.type === "application/pdf";
  const isImage = file.type.startsWith("image/");
  if (file.size > STORAGE_UPLOAD_MAX_BYTES || (!isPdf && !isImage)) {
    throw new Error(`Attachment must be a PDF or image up to ${STORAGE_UPLOAD_MAX_MB} MB.`);
  }
}

/**
 * يحوّل فشل Storage/الشبكة إلى رمز ثابت للواجهة.
 *
 * Production 2026-08-23: a ~minute PDF POST returned HTTP 400 with an empty
 * body and never reached storage-api. supabase-js then has no message.
 */
export function storageUploadFailureCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout") || lower.includes("aborted")) {
    return STORAGE_UPLOAD_TIMED_OUT;
  }
  const status =
    typeof error === "object" && error !== null && "statusCode" in error
      ? String((error as { statusCode: unknown }).statusCode)
      : "";
  if (status === "400" || status === "413" || status === "408" || status === "499") {
    return STORAGE_UPLOAD_CONNECTION_FAILED;
  }
  if (!message.trim() || lower === "bad request" || lower.includes("empty")) {
    return STORAGE_UPLOAD_CONNECTION_FAILED;
  }
  return null;
}

/**
 * يسابق الوعد مهلةً حتى لا يبقى زر الرفع معلّقاً إلى ما لا نهاية.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "Operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
