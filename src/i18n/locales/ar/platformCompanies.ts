/**
 * ترجمة رسائل رفض عمليات لوحة المنصة (العربية).
 *
 * The panel turns a refusal code into one of these messages, so the server
 * carries the code alone and this file carries the sentence — one wording per
 * reason, in the language the super admin reads.
 */
export const platformCompanies: Record<string, string> = {
  "platformCompanies.error.SLUG_INVALID":
    "المعرّف المختصر غير صالح: اكتبه بحروف صغيرة وأرقام وشرطات، من 3 إلى 32 محرفاً، بلا شرطة في أوله ولا آخره.",
  "platformCompanies.error.SLUG_RESERVED": "هذا المعرّف المختصر محجوز للمنصة، اختر اسماً آخر.",
  "platformCompanies.error.SLUG_TAKEN": "هذا المعرّف المختصر مستخدم من شركة أخرى، اختر اسماً آخر.",
  "platformCompanies.error.SLUG_IMMUTABLE": "لا يمكن تغيير المعرّف المختصر بعد إنشاء الشركة.",
  "platformCompanies.error.PLATFORM_ADMIN_REQUIRED": "هذه العملية تتطلب حساب مشرف منصة.",
  "platformCompanies.error.COMPANY_NOT_FOUND": "هذه الشركة غير موجودة.",
  "platformCompanies.error.USER_NOT_FOUND": "هذا الحساب غير موجود في هذه الشركة.",
  "platformCompanies.error.USERNAME_TAKEN": "اسم المستخدم محجوز لحساب آخر داخل الشركة نفسها.",
  "platformCompanies.error.EMAIL_TAKEN": "البريد الإلكتروني محجوز لحساب آخر داخل الشركة نفسها.",
};
