/**
 * ترجمة شاشة إعدادات بوابات الدفع وملاحظة بوابة المستأجر (العربية).
 *
 * الأسرار لا تُترجم ولا تُعرض؛ هذه المفاتيح للنصوص المحيطة بالحقول فقط.
 */
export const gatewaySettingsUi: Record<string, string> = {
  "gatewaySettingsUi.title": "بوابات الدفع",
  "gatewaySettingsUi.description":
    "أضف بيانات حسابك لدى كل مزوّد، اختبر الاتصال، ثم فعّل مزوّداً واحداً لاستقبال الدفع الإلكتروني.",

  "gatewaySettingsUi.provider.myfatoorah": "ماي فاتورة",
  "gatewaySettingsUi.provider.tap": "تاب",
  "gatewaySettingsUi.provider.upayments": "أوبايمنتس",

  "gatewaySettingsUi.badge.notSet": "غير مهيّأ",
  "gatewaySettingsUi.badge.test": "اختبار · نشط",
  "gatewaySettingsUi.badge.live": "تشغيل · نشط",
  "gatewaySettingsUi.badge.inactive": "موقوف",

  "gatewaySettingsUi.credential.apiKey": "مفتاح_API",
  "gatewaySettingsUi.credential.webhookSecret": "سرّ الويب هوك",
  "gatewaySettingsUi.credential.stored": "محفوظ: آخر 4 أحرف",
  "gatewaySettingsUi.credential.hint": "اترك الحقل فارغاً للإبقاء على القيمة المحفوظة.",
  "gatewaySettingsUi.enterCredential": "أدخل مفتاحاً واحداً على الأقل قبل الحفظ.",

  "gatewaySettingsUi.testMode": "وضع الاختبار",
  "gatewaySettingsUi.mode.test": "اختبار",
  "gatewaySettingsUi.mode.live": "تشغيل",

  "gatewaySettingsUi.save": "حفظ بيانات الاعتماد",
  "gatewaySettingsUi.saving": "جارٍ الحفظ…",
  "gatewaySettingsUi.saved": "حُفظت بيانات الاعتماد.",
  "gatewaySettingsUi.saveError": "تعذّر حفظ بيانات الاعتماد.",
  "gatewaySettingsUi.liveNotAllowed":
    "الوضع الفعلي غير متاح لهذا المزوّد بعد. احفظ في وضع الاختبار حتى تفعّله إدارة المنصة.",

  "gatewaySettingsUi.testConnection": "اختبار الاتصال",
  "gatewaySettingsUi.testing": "جارٍ الاختبار…",
  "gatewaySettingsUi.testOk": "الاتصال ناجح.",
  "gatewaySettingsUi.testFailed": "فشل اختبار الاتصال.",

  "gatewaySettingsUi.activate": "تفعيل",
  "gatewaySettingsUi.deactivate": "إيقاف",
  "gatewaySettingsUi.confirmActivateTitle": "تفعيل بوابة الدفع",
  "gatewaySettingsUi.confirmActivateBody":
    "سيصبح هذا المزوّد هو بوابة الدفع النشطة للشركة، ويُعطَّل أي مزوّد آخر.",
  "gatewaySettingsUi.confirmDeactivateTitle": "إيقاف بوابة الدفع",
  "gatewaySettingsUi.confirmDeactivateBody":
    "لن تُقدَّم وسائل الدفع الإلكتروني للمستأجرين بعد الإيقاف.",
  "gatewaySettingsUi.confirm": "تأكيد",
  "gatewaySettingsUi.cancel": "إلغاء",
  "gatewaySettingsUi.activated": "فُعّلت البوابة.",
  "gatewaySettingsUi.deactivated": "أُوقفت البوابة.",
  "gatewaySettingsUi.actionError": "تعذّر تنفيذ الطلب.",

  "gatewaySettingsUi.oneActive": "بوابة واحدة نشطة فقط لكل شركة.",
  "gatewaySettingsUi.lastTestAt": "آخر اختبار",
  "gatewaySettingsUi.lastTestResult": "نتيجة الاختبار",
  "gatewaySettingsUi.never": "لم يُختبر بعد",

  "gatewaySettingsUi.webhookLabel": "رابط الويب هوك",
  "gatewaySettingsUi.copy": "نسخ",
  "gatewaySettingsUi.copied": "نُسخ الرابط.",
  "gatewaySettingsUi.copyFailed": "تعذّر نسخ الرابط.",

  "gatewaySettingsUi.portal.payAtOffice": "الدفع الإلكتروني غير متاح حالياً. ادفع في مكتب الشركة.",
};
