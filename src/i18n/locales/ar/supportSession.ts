/**
 * ترجمة جلسة الدعم الفني: لوحة المنصة التي تبدأ الجلسة، والشريط الأحمر داخل
 * لوحة الشركة، وصفحة دخول الجلسة (العربية).
 *
 * The refusal codes live beside the platform operations in
 * `src/platform/supportSession.ts`; this file carries the sentences the screens
 * show around them.
 */
export const supportSession: Record<string, string> = {
  "supportSession.platform.title": "جلسة الدعم الفني",
  "supportSession.platform.description":
    "يفتح مشرف المنصة لوحة الشركة بحساب أحد موظفيها، وتُوثَّق الجلسة في سجل تدقيق المنصة.",
  "supportSession.platform.reason": "سبب الدخول",
  "supportSession.platform.reasonHint": "السبب إلزامي، ويظهر داخل شريط التحذير في لوحة الشركة.",
  "supportSession.platform.target": "حساب الموظف",
  "supportSession.platform.targetHint": "اختر موظفاً نشطاً من الشركة.",
  "supportSession.platform.start": "ابدأ جلسة الدعم",
  "supportSession.platform.starting": "جارٍ البدء…",
  "supportSession.platform.linkTitle": "رابط الدخول (مرة واحدة)",
  "supportSession.platform.linkHint":
    "الرمز في جزء العنوان بعد علامة #، فلا يصل إلى سجلات الخادم ولا إلى صفحة الهبوط.",
  "supportSession.platform.copy": "نسخ الرابط",
  "supportSession.platform.copied": "نُسخ الرابط.",
  "supportSession.platform.openSessions": "جلسات مفتوحة",
  "supportSession.platform.noOpenSessions": "لا توجد جلسة دعم مفتوحة لهذه الشركة.",
  "supportSession.platform.expiresAt": "تنتهي في",
  "supportSession.platform.end": "إنهاء الجلسة",
  "supportSession.platform.ending": "جارٍ الإنهاء…",
  "supportSession.platform.error.reasonRequired": "اكتب سبب الدخول قبل البدء.",
  "supportSession.platform.error.targetRequired": "اختر حساب الموظف الذي ستُفتح لوحته.",
  "supportSession.platform.error.generic": "تعذّر تنفيذ العملية. حاول مرة أخرى.",

  "supportSession.banner.title": "جلسة دعم فني نشطة",
  "supportSession.banner.by": "مشرف المنصة {name} يدخل لوحة الشركة الآن.",
  "supportSession.banner.reason": "السبب: {reason}",
  "supportSession.banner.expiresAt": "تنتهي الجلسة في {time}.",
  "supportSession.banner.end": "إنهاء جلسة الدعم",
  "supportSession.banner.ending": "جارٍ الإنهاء…",
  "supportSession.banner.error": "تعذّر إنهاء جلسة الدعم.",

  "supportSession.route.title": "فتح جلسة الدعم",
  "supportSession.route.opening": "جارٍ فتح جلسة الدعم…",
  "supportSession.route.refused": "تعذّر فتح جلسة الدعم. اطلب من مشرف المنصة رابطاً جديداً.",
  "supportSession.route.noToken": "هذا الرابط لا يحمل رمز جلسة. اطلب من مشرف المنصة رابطاً جديداً.",
  "supportSession.route.signIn": "الذهاب إلى تسجيل الدخول",

  "supportSession.error.NO_CALLER_SESSION": "انتهت الجلسة. سجّل الدخول من جديد.",
  "supportSession.error.TARGET_USER_NOT_IN_COMPANY": "الحساب المختار لا ينتمي إلى هذه الشركة.",
  "supportSession.error.SUPPORT_SESSION_NOT_FOUND": "جلسة الدعم غير موجودة.",
  "supportSession.error.COMPANY_SUSPENDED": "حساب الشركة موقوف حالياً.",
};
