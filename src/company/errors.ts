/**
 * رموز الأخطاء القياسية لسياق الشركة المعتمدة في عقد عزل الشركات.
 */
export const COMPANY_ERROR_CODES = [
  "COMPANY_REQUIRED",
  "COMPANY_SUSPENDED",
  "MODULE_DISABLED",
  "LIMIT_UNITS",
  "LIMIT_STAFF",
  "LIMIT_STORAGE",
  "LIMIT_WHATSAPP",
  "SUPPORT_SESSION_FORBIDDEN",
] as const;

export type CompanyErrorCode = (typeof COMPANY_ERROR_CODES)[number];

const COMPANY_ERROR_MESSAGES: Record<CompanyErrorCode, string> = {
  COMPANY_REQUIRED: "Company context is required for this operation.",
  COMPANY_SUSPENDED: "This company account is currently suspended.",
  MODULE_DISABLED: "This section is not available for your company.",
  LIMIT_UNITS: "Unit limit reached for this company.",
  LIMIT_STAFF: "Staff account limit reached for this company.",
  LIMIT_STORAGE: "Storage limit reached for this company.",
  LIMIT_WHATSAPP: "Monthly WhatsApp message limit reached for this company.",
  SUPPORT_SESSION_FORBIDDEN: "Not available during a support session.",
};

const COMPANY_ERROR_STATUS: Record<CompanyErrorCode, number> = {
  COMPANY_REQUIRED: 400,
  COMPANY_SUSPENDED: 403,
  MODULE_DISABLED: 403,
  LIMIT_UNITS: 403,
  LIMIT_STAFF: 403,
  LIMIT_STORAGE: 403,
  LIMIT_WHATSAPP: 403,
  SUPPORT_SESSION_FORBIDDEN: 403,
};

/**
 * خطأ موحّد لأعطال سياق الشركة (غياب الشركة، الإيقاف، تعطيل القسم، تجاوز الحدود، أو قيود جلسة الدعم).
 */
export class CompanyContextError extends Error {
  readonly code: CompanyErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  /** ينشئ خطأ سياق شركة برمز قياسي ورسالة اختيارية وتفاصيل تشخيصية غير سرية. */
  constructor(code: CompanyErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? COMPANY_ERROR_MESSAGES[code]);
    this.name = "CompanyContextError";
    this.code = code;
    this.status = COMPANY_ERROR_STATUS[code];
    this.details = details;
  }
}

/**
 * يتحقق من أن الخطأ المرمي هو خطأ سياق شركة، مع إمكانية مطابقة رمز محدد.
 */
export function isCompanyContextError(
  error: unknown,
  code?: CompanyErrorCode,
): error is CompanyContextError {
  if (!(error instanceof CompanyContextError)) {
    return false;
  }
  return code === undefined || error.code === code;
}
