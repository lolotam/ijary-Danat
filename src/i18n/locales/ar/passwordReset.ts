/**
 * مفاتيح الترجمة (ar) لطلب إعادة تعيين كلمة المرور ولتغييرها.
 *
 * `passwordReset.request.*` are the wording of the "forgot my password" screen:
 * it answers the same sentence whether or not the account exists, so the text
 * itself must not promise a message that may never be sent.
 */
export const passwordReset: Record<string, string> = {
  "passwordReset.title": "إعادة تعيين كلمة المرور",

  "passwordReset.request.title": "نسيت كلمة المرور؟",
  "passwordReset.request.description":
    "اكتب اسم المستخدم أو البريد الإلكتروني أو رقم الجوال، وسنرسل إليك رابطاً لإعادة تعيين كلمة المرور.",
  "passwordReset.request.identifier": "اسم المستخدم أو البريد الإلكتروني أو رقم الجوال",
  "passwordReset.request.submit": "إرسال رابط إعادة التعيين",
  "passwordReset.request.sent":
    "إذا كان الحساب موجوداً، فقد أرسلنا إليه رابطاً لإعادة تعيين كلمة المرور.",

  "passwordReset.change.title": "تعيين كلمة مرور جديدة",
  "passwordReset.change.description": "اختر كلمة مرور جديدة لحسابك.",
  "passwordReset.currentPassword": "كلمة المرور الحالية",
  "passwordReset.currentPasswordRequired": "أدخل كلمة المرور الحالية للمتابعة.",
  "passwordReset.invalidCurrentPassword": "كلمة المرور الحالية غير صحيحة.",
  "passwordReset.newPassword": "كلمة المرور الجديدة",
  "passwordReset.confirmPassword": "تأكيد كلمة المرور",
  "passwordReset.submit": "حفظ كلمة المرور",
  "passwordReset.changed": "تم تغيير كلمة المرور. يمكنك تسجيل الدخول الآن.",
  "passwordReset.mismatch": "كلمتا المرور غير متطابقتين.",
  "passwordReset.weak": "كلمة المرور يجب أن تكون 8 أحرف على الأقل.",
  "passwordReset.failed": "تعذّر تغيير كلمة المرور. حاول مرة أخرى.",

  "passwordReset.invalidToken": "رابط إعادة التعيين غير صالح. اطلب رابطاً جديداً.",
  "passwordReset.usedToken": "استُخدم هذا الرابط من قبل. اطلب رابطاً جديداً.",
  "passwordReset.expiredToken": "انتهت صلاحية هذا الرابط. اطلب رابطاً جديداً.",

  "passwordReset.forced.title": "يجب تغيير كلمة المرور المؤقتة",
  "passwordReset.forced.description":
    "حسابك ما زال يستخدم كلمة المرور المؤقتة. غيّرها الآن لمتابعة استخدام النظام.",
  "passwordReset.signIn": "تسجيل الدخول",
  "passwordReset.requestAnother": "طلب رابط جديد",
};
