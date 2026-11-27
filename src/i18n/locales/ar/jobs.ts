/**
 * مفاتيح الترجمة (ar) للوحة المهام الخلفية الفاشلة، وأسماء أنواع المهام.
 *
 * `jobKind.<kind>` family mirrors the catalogue's kind names, so a failed row
 * reads as what the job was in the admin's language rather than as a raw
 * identifier. A kind this build does not know falls back to its raw name.
 */
export const jobs: Record<string, string> = {
  "settings.failedJobs.title": "المهام الخلفية الفاشلة",
  "settings.failedJobs.description":
    "المهام التي استنفدت محاولاتها وتوقفت. يمكن إعادة تشغيلها من هنا.",
  "settings.failedJobs.empty": "لا توجد مهام فاشلة.",
  "settings.failedJobs.reason": "سبب الفشل",
  "settings.failedJobs.attempts": "المحاولات",
  "settings.failedJobs.failedAt": "وقت الفشل",
  "settings.failedJobs.noReason": "لا يوجد سبب مسجّل.",
  "settings.failedJobs.retry": "إعادة المحاولة",
  "settings.failedJobs.retrySuccess": "أُعيدت المهمة إلى قائمة الانتظار.",
  "settings.failedJobs.retryError": "تعذّرت إعادة المحاولة.",

  "jobKind.notification.dispatch": "إرسال إشعار",
  "jobKind.notification.bulk": "إرسال إشعارات جماعية",
  "jobKind.invoice.send": "إرسال فاتورة",
  "jobKind.payment.receipt": "إيصال دفع",
  "jobKind.company.info.send": "إرسال بيانات الشركة",
  "jobKind.contract.pdf": "ملف PDF للعقد",
  "jobKind.report.run": "تشغيل تقرير",
  "jobKind.report.export": "تصدير تقرير",
  "jobKind.invoices.generate": "توليد الفواتير",
  "jobKind.invoices.regenerate": "إعادة توليد الفواتير",
  "jobKind.import.run": "استيراد ملف",
  "jobKind.electricity.generate": "توليد رسوم الكهرباء",
  "jobKind.salaries.generate": "توليد الرواتب",
  "jobKind.company.export": "تصدير نسخة الشركة",
  "jobKind.company.restore": "استعادة نسخة الشركة",
  "jobKind.whatsapp.history.sync": "مزامنة سجل واتساب",
  "jobKind.whatsapp.avatars.sync": "مزامنة صور واتساب",
  "jobKind.gmail.sync": "مزامنة Gmail",
  "jobKind.payment.reconcile": "مطابقة المدفوعات",
  "jobKind.payment.settle": "تسوية المدفوعات",
  "jobKind.webhook.process": "معالجة حدث Webhook",
  "jobKind.overdue.evaluate": "تقييم المتأخرات",
  "jobKind.overdue.remind": "تذكير بالمتأخرات",
  "jobKind.contract.expiry": "انتهاء العقود",
  "jobKind.notification.drain": "تفريغ الإشعارات",
  "jobKind.log.retention": "تنظيف السجلات",
  "jobKind.usage.rebuild": "إعادة بناء الاستهلاك",
  "jobKind.subscription.remind": "تذكير بالاشتراك",
  "jobKind.payment.succeeded": "نجاح الدفع",
  "jobKind.payment.reversed": "عكس الدفع",
  "jobKind.deposit.confirmed": "تأكيد الإيداع البنكي",
  "jobKind.refund.recorded": "تسجيل استرداد",
  "jobKind.invoice.written_off": "مشطوبة الفاتورة",
  "jobKind.invoice.disputed": "نزاع على الفاتورة",
  "jobKind.contract.closed_out": "إغلاق العقد",
  "jobKind.contract.restored": "استعادة العقد",
};
