import { translatorFor } from "@/i18n/dictionary";
import { STORAGE_UPLOAD_MAX_BYTES } from "@/lib/uploadLimits";

/** Client-side limits and error mapping for admin image uploads (any bucket). */

/** Max raw file size accepted before calling Storage (bytes). */
export const LANDING_IMAGE_MAX_BYTES = STORAGE_UPLOAD_MAX_BYTES;

/** Abort hangy uploads after this many milliseconds. */
export const LANDING_IMAGE_UPLOAD_TIMEOUT_MS = 180_000;

export type LandingImageLocale = "ar" | "en";

/**
 * Returns a bilingual rejection reason when the file is too large, else null.
 * Wording is bucket-neutral (landing and property photos share the same limit).
 */
export function landingImageSizeError(
  fileSizeBytes: number,
  locale: LandingImageLocale,
): string | null {
  if (fileSizeBytes <= LANDING_IMAGE_MAX_BYTES) return null;
  const maxMb = LANDING_IMAGE_MAX_BYTES / (1024 * 1024);
  return locale === "ar"
    ? `حجم الصورة كبير جداً (الحد ${maxMb} م.ب). صغّر الملف ثم أعد المحاولة.`
    : `Image is too large (max ${maxMb} MB). Compress it and try again.`;
}

/** Prefer Storage-api `statusCode` over free-text matching when present. */
function extractStorageStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return null;
  const raw = (error as { statusCode: unknown }).statusCode;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

/**
 * يحوّل أخطاء التخزين والشبكة عند رفع الصور إلى رسالة واضحة يقرأها المستخدم.
 *
 * Map Storage / network failures to a clear user-facing message.
 * RLS AccessDenied (403) is the production failure mode for non-admin landing uploads.
 * 401 is a session problem, not a permissions bug — report it separately.
 */
export function mapLandingImageUploadError(error: unknown, locale: LandingImageLocale): string {
  const statusCode = extractStorageStatusCode(error);

  if (statusCode === 401) {
    return locale === "ar"
      ? "انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى ثم أعد المحاولة."
      : "Your session has expired. Please sign in again and retry.";
  }

  if (statusCode === 403) {
    return locale === "ar"
      ? "رفع صور صفحة المجمع يتطلب حساب مسؤول (admin)."
      : "Uploading landing images requires an admin account.";
  }

  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message: unknown }).message === "string"
        ? (error as { message: string }).message
        : String(error ?? "");

  const lower = raw.toLowerCase();

  if (
    lower.includes("row-level security") ||
    lower.includes("accessdenied") ||
    lower.includes("access denied") ||
    lower.includes("unauthorized") ||
    lower.includes("permission") ||
    lower.includes("not allowed") ||
    lower.includes("42501")
  ) {
    return locale === "ar"
      ? "رفع صور صفحة المجمع يتطلب حساب مسؤول (admin)."
      : "Uploading landing images requires an admin account.";
  }

  if (lower.includes("timeout") || lower.includes("aborted") || lower.includes("timed out")) {
    return locale === "ar"
      ? "انتهت مهلة الرفع. جرّب صورة أصغر."
      : "Upload timed out. Try a smaller image.";
  }

  if (raw.trim()) return raw;
  const t = translatorFor(locale);
  return t("landing.imageUploadFailed");
}

export { withTimeout } from "@/lib/uploadLimits";
