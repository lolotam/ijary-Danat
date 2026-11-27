/**
 * مفاتيح الترجمة العربية لشاشة النظرة العامة على المنصة (قصة المستخدم 12).
 *
 * Kept in its own module so the already-large `ar.ts` catalog does not grow by
 * another screenful; `ar.ts` only needs the import and the spread.
 */
export const platformOverview: Record<string, string> = {
  "platformOverview.loading": "جارٍ قراءة حالة المنصة…",
  "platformOverview.totals.title": "إجماليات المنصة",
  "platformOverview.totals.companies": "الشركات",
  "platformOverview.totals.companiesActive": "نشطة",
  "platformOverview.totals.companiesSuspended": "موقوفة",
  "platformOverview.totals.units": "الوحدات",
  "platformOverview.totals.staffUsers": "حسابات الموظفين",
  "platformOverview.totals.renters": "المستأجرون",
  "platformOverview.totals.collectedThisMonth": "المحصّل هذا الشهر",
  "platformOverview.health.title": "حالة الشركات",
  "platformOverview.health.company": "الشركة",
  "platformOverview.health.status": "حالة الشركة",
  "platformOverview.health.whatsapp": "واتساب",
  "platformOverview.health.gateway": "بوابة الدفع",
  "platformOverview.health.jobsFailed": "مهام فاشلة (24 ساعة)",
  "platformOverview.health.notificationsFailed": "إشعارات فاشلة (24 ساعة)",
  "platformOverview.health.empty": "لا توجد شركات على المنصة.",
  "platformOverview.state.ok": "سليم",
  "platformOverview.state.broken": "معطوب",
  "platformOverview.state.notSetUp": "غير مُعد",
  "platformOverview.status.active": "نشطة",
  "platformOverview.status.suspended": "موقوفة",
};
