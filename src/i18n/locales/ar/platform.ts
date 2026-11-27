/**
 * مفاتيح الترجمة العربية للوحة المشرف العام وصفحات الدخول والعامل الثاني والسجل.
 *
 * Kept in its own module so the already-large `ar.ts` catalog does not grow by
 * another screenful; `ar.ts` only needs the import and the spread.
 */
export const platform: Record<string, string> = {
  "platform.title": "إدارة المنصة",
  "platform.subtitle": "مساحة المشرف العام",
  "platform.nav.overview": "نظرة عامة",
  "platform.nav.audit": "سجل التدقيق",
  "platform.signOut": "تسجيل الخروج",
  "platform.language": "English",
  "platform.loading": "جارٍ التحقق من صلاحية المشرف العام…",
  "platform.error": "تعذّر التحقق من صلاحية المشرف العام.",

  "platform.login.title": "دخول المشرف العام",
  "platform.login.subtitle": "حسابات المنصة منفصلة عن حسابات الشركات.",
  "platform.login.email": "معرّف الدخول",
  "platform.login.password": "كلمة المرور",
  "platform.login.submit": "تسجيل الدخول",
  "platform.login.submitting": "جارٍ الدخول…",
  "platform.login.error.forbidden": "هذا الحساب ليس مشرفاً للمنصة.",
  "platform.login.error.invalid": "معرّف الدخول أو كلمة المرور غير صحيحة.",
  "platform.login.error.generic": "تعذّر تسجيل الدخول. حاول مرة أخرى.",
  "platform.login.note": "بعد الدخول سيُطلب إعداد عامل تحقق ثانٍ أو إدخال رمزه.",

  "platform.mfa.title": "التحقق بعاملين",
  "platform.mfa.subtitle": "لا تُعرض بيانات المنصة قبل اكتمال العامل الثاني.",
  "platform.mfa.enrollHint":
    "افتح تطبيق المصادقة وامسح رمز QR أو أضف المفتاح يدوياً، ثم أدخل الرمز.",
  "platform.mfa.scan": "رمز QR للإعداد",
  "platform.mfa.secret": "مفتاح الإعداد",
  "platform.mfa.verifiedHint": "أدخل الرمز الحالي من تطبيق المصادقة.",
  "platform.mfa.code": "رمز التحقق",
  "platform.mfa.submit": "تأكيد الرمز",
  "platform.mfa.submitting": "جارٍ التحقق…",
  "platform.mfa.error.code": "أدخل رمزاً مكوّناً من ستة أرقام.",
  "platform.mfa.error.generic": "تعذّر التحقق. تأكد من الرمز وحاول مرة أخرى.",
  "platform.mfa.signOut": "تسجيل الخروج",

  "platform.audit.title": "سجل تدقيق المنصة",
  "platform.audit.subtitle": "كل إجراءات المشرفين العامين، دون أسرار أو كلمات مرور.",
  "platform.audit.time": "الوقت",
  "platform.audit.actor": "المنفّذ",
  "platform.audit.action": "الإجراء",
  "platform.audit.entity": "العنصر",
  "platform.audit.company": "الشركة",
  "platform.audit.unknownActor": "غير معروف",
  "platform.audit.noCompany": "على مستوى المنصة",
  "platform.audit.empty": "لا توجد سجلات في هذه الصفحة.",
  "platform.audit.error": "تعذّر قراءة سجل التدقيق.",
  "platform.audit.previous": "السابق",
  "platform.audit.next": "التالي",
  "platform.audit.page": "صفحة",
  "platform.audit.of": "من",
};
