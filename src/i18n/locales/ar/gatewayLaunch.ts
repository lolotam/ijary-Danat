/**
 * مفاتيح الترجمة العربية لإدارة إطلاق بوابات الدفع في الوضع الفعلي (SC-012).
 */
export const gatewayLaunch: Record<string, string> = {
  "platform.nav.gateways": "بوابات الدفع",
  "platformGateways.title": "إطلاق بوابات الدفع",
  "platformGateways.subtitle":
    "السماح للشركات باستخدام الوضع الفعلي لكل مزوّد بعد استيفاء قائمة التحقق (SC-012).",
  "platformGateways.panelTitle": "حالة التشغيل الفعلي للمزوّدين",
  "platformGateways.panelDescription":
    "يظل الوضع التجريبي متاحاً دائماً. تعطيل السماح لا يغيّر الاتصالات الفعلية القائمة.",
  "platformGateways.provider.myfatoorah": "ماي فاتورة (MyFatoorah)",
  "platformGateways.provider.tap": "تاب (Tap)",
  "platformGateways.provider.upayments": "يو بايمنتس (UPayments)",
  "platformGateways.status.allowed": "الوضع الفعلي مسموح",
  "platformGateways.status.blocked": "تجريبي فقط",
  "platformGateways.switchAria": "تبديل السماح بالوضع الفعلي",
  "platformGateways.confirmTitleEnable": "تأكيد السماح بالوضع الفعلي",
  "platformGateways.confirmTitleDisable": "تأكيد إيقاف السماح بالوضع الفعلي",
  "platformGateways.confirmBodyEnable":
    "يتطلب معيار SC-012 تسجيل جميع الحالات في البيئة التجريبية أولاً (النجاح، الفشل، الإلغاء، انتهاء الصلاحية، والتكرار) عبر رسالة التأكيد وصفحة العودة والمطابقة قبل فتح الوضع الفعلي.",
  "platformGateways.confirmBodyDisable":
    "لن تتمكن الشركات من تحويل اتصال جديد إلى الوضع الفعلي لهذا المزوّد (SC-012). الشركات العاملة عليه الآن في الوضع الفعلي ({count}) ستبقى تعمل كما هي ولن يتوقف تحصيلها.",
  "platformGateways.liveConnections": "الشركات العاملة حالياً في الوضع الفعلي: {count}",
  "platformGateways.confirmAction": "تأكيد",
  "platformGateways.saved": "تم تحديث حالة الإطلاق للمزوّد.",
  "platformGateways.loadError": "تعذّر تحميل إعدادات إطلاق بوابات الدفع.",
  "platformGateways.saveError": "تعذّر تحديث حالة إطلاق البوابة.",
};
