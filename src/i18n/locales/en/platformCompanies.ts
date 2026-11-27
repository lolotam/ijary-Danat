/**
 * ترجمة رسائل رفض عمليات لوحة المنصة (الإنجليزية).
 *
 * The panel turns a refusal code into one of these messages, so the server
 * carries the code alone and this file carries the sentence — one wording per
 * reason, in the language the super admin reads.
 */
export const platformCompanies: Record<string, string> = {
  "platformCompanies.error.SLUG_INVALID":
    "This short name is not valid: use lower-case letters, digits and hyphens, 3 to 32 characters, with no hyphen at either end.",
  "platformCompanies.error.SLUG_RESERVED":
    "This short name is reserved for the platform. Choose another one.",
  "platformCompanies.error.SLUG_TAKEN":
    "This short name is already used by another company. Choose another one.",
  "platformCompanies.error.SLUG_IMMUTABLE":
    "The short name cannot be changed after the company is created.",
  "platformCompanies.error.PLATFORM_ADMIN_REQUIRED":
    "This action requires a platform administrator account.",
  "platformCompanies.error.COMPANY_NOT_FOUND": "This company does not exist.",
  "platformCompanies.error.USER_NOT_FOUND": "This account does not exist in this company.",
  "platformCompanies.error.USERNAME_TAKEN":
    "This username is already taken by another account in this company.",
  "platformCompanies.error.EMAIL_TAKEN":
    "This email address is already used by another account in this company.",
};
