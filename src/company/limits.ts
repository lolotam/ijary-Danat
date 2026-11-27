/**
 * رموز أخطاء تجاوز حدود الشركة الصادرة عن قاعدة البيانات أو سياق الشركة.
 */
export const LIMIT_ERROR_CODES = [
  "LIMIT_UNITS",
  "LIMIT_STAFF",
  "LIMIT_STORAGE",
  "LIMIT_WHATSAPP",
] as const;

export type LimitErrorCode = (typeof LIMIT_ERROR_CODES)[number];

/**
 * مفاتيح الترجمة المقابلة لكل رمز من رموز تجاوز حدود الشركة.
 */
export const LIMIT_I18N_KEYS: Readonly<Record<LimitErrorCode, `limits.${LimitErrorCode}`>> = {
  LIMIT_UNITS: "limits.LIMIT_UNITS",
  LIMIT_STAFF: "limits.LIMIT_STAFF",
  LIMIT_STORAGE: "limits.LIMIT_STORAGE",
  LIMIT_WHATSAPP: "limits.LIMIT_WHATSAPP",
};

const LIMIT_CODE_PATTERN = /\b(LIMIT_UNITS|LIMIT_STAFF|LIMIT_STORAGE|LIMIT_WHATSAPP)\b/;

/**
 * يجمع النصوص التشخيصية الممكنة من خطأ Supabase أو PostgreSQL أو JavaScript.
 */
function collectErrorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (!error || typeof error !== "object") {
    return "";
  }
  const parts: string[] = [];
  for (const field of ["code", "message", "details", "hint"] as const) {
    const value = (error as Record<string, unknown>)[field];
    if (typeof value === "string" && value.length > 0) {
      parts.push(value);
    }
  }
  return parts.join(" ");
}

/**
 * يستخرج رمز تجاوز الحد (`LIMIT_*`) من خطأ Supabase/Postgres أو يرجع `null`.
 */
export function limitErrorCode(error: unknown): LimitErrorCode | null {
  const match = LIMIT_CODE_PATTERN.exec(collectErrorText(error));
  return match ? (match[1] as LimitErrorCode) : null;
}

/**
 * يرجع مفتاح الترجمة المناسب لخطأ تجاوز الحد (`limits.LIMIT_*`) أو `null`.
 */
export function limitErrorKey(error: unknown): `limits.${LimitErrorCode}` | null {
  const code = limitErrorCode(error);
  return code ? LIMIT_I18N_KEYS[code] : null;
}
