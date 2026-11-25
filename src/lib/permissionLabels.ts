import type { Locale } from "@/i18n/dictionary";

const moduleLabels = {
  ar: {
    audit: "سجل التدقيق",
    buildings: "المباني",
    company: "الشركة",
    contracts: "العقود",
    deposits: "الإيداعات",
    electricity: "الكهرباء",
    expenses: "المصروفات",
    invoices: "الفواتير",
    maintenance: "الصيانة",
    notifications: "الإشعارات",
    payment_links: "روابط الدفع",
    payments: "المدفوعات",
    portal: "بوابة المستأجر",
    properties: "العقارات",
    receipts: "الإيصالات",
    reports: "التقارير",
    tenants: "المستأجرون",
    units: "الوحدات",
    users: "المستخدمون",
    employees: "الموظفون",
    salaries: "الرواتب",
    refunds: "المستردات",
    partial_payments: "الدفعات الجزئية",
    insurance: "التأمين",
    settings: "الإعدادات",
    workflows: "سير العمل",
    inbox: "صندوق الوارد",
    landing_page: "صفحة المجمع",
  },
  en: {
    audit: "Audit log",
    buildings: "Buildings",
    company: "Company",
    contracts: "Contracts",
    deposits: "Deposits",
    electricity: "Electricity",
    expenses: "Expenses",
    invoices: "Invoices",
    maintenance: "Maintenance",
    notifications: "Notifications",
    payment_links: "Payment links",
    payments: "Payments",
    portal: "Tenant portal",
    properties: "Properties",
    receipts: "Receipts",
    reports: "Reports",
    tenants: "Tenants",
    units: "Units",
    users: "Users",
    employees: "Employees",
    salaries: "Salaries",
    refunds: "Refunds",
    partial_payments: "Partial payments",
    insurance: "Insurance",
    settings: "Settings",
    workflows: "Workflows",
    inbox: "Inbox",
    landing_page: "Landing page",
  },
} as const;

const actionLabels = {
  ar: { create: "إنشاء", read: "عرض", update: "تعديل", delete: "حذف", export: "تصدير" },
  en: { create: "Create", read: "View", update: "Update", delete: "Delete", export: "Export" },
} as const;

const specialLabels = {
  ar: {
    "payments.reverse": "المدفوعات: عكس الدفعة",
    "notifications.send": "الإشعارات: إرسال",
    "portal.enable": "بوابة المستأجر: تفعيل",
    "users.assign_tenants": "المستخدمون: ربط حسابات المستأجرين",
    "portal.tab_dashboard": "بوابة المستأجر: تبويب الرئيسية",
    "portal.tab_lease": "بوابة المستأجر: تبويب عقدي",
    "portal.tab_invoices": "بوابة المستأجر: تبويب فواتيري",
    "portal.tab_payments": "بوابة المستأجر: تبويب مدفوعاتي",
    "portal.tab_profile": "بوابة المستأجر: تبويب الملف الشخصي",
    "portal.tab_shop": "بوابة المستأجر: تبويب متجري",
    "settings.integrations": "الإعدادات: إدارة التكاملات",
    "settings.lists": "الإعدادات: إدارة القوائم",
    "settings.backup": "الإعدادات: النسخ الاحتياطي",
    "workflows.manage": "سير العمل: إدارة المهام المجدولة",
    "electricity.tariffs": "الكهرباء: إدارة التعرفة",
    "expenses.categories": "المصروفات: إدارة التصنيفات",
    "inbox.manage": "صندوق الوارد: حذف رسائل البريد",
    "landing_page.read": "صفحة المجمع: عرض",
    "landing_page.update": "صفحة المجمع: تعديل",
    "landing_page.leasing_read": "صفحة المجمع: عرض طلبات التأجير",
    "landing_page.leasing_update": "صفحة المجمع: إدارة طلبات التأجير",
  },
  en: {
    "payments.reverse": "Payments: Reverse payment",
    "notifications.send": "Notifications: Send",
    "portal.enable": "Tenant portal: Enable",
    "users.assign_tenants": "Users: Link tenant accounts",
    "portal.tab_dashboard": "Tenant portal: Dashboard tab",
    "portal.tab_lease": "Tenant portal: My Lease tab",
    "portal.tab_invoices": "Tenant portal: My Invoices tab",
    "portal.tab_payments": "Tenant portal: My Payments tab",
    "portal.tab_profile": "Tenant portal: Profile tab",
    "portal.tab_shop": "Tenant portal: Shop Details tab",
    "settings.integrations": "Settings: Manage integrations",
    "settings.lists": "Settings: Manage lists",
    "settings.backup": "Settings: Backups",
    "workflows.manage": "Workflows: Manage scheduled jobs",
    "electricity.tariffs": "Electricity: Manage tariffs",
    "expenses.categories": "Expenses: Manage categories",
    "inbox.manage": "Inbox: Delete Gmail messages",
    "landing_page.read": "Landing page: View",
    "landing_page.update": "Landing page: Edit",
    "landing_page.leasing_read": "Landing page: View leasing leads",
    "landing_page.leasing_update": "Landing page: Manage leasing leads",
  },
} as const;

export function permissionLabel(code: string, locale: Locale): string {
  const special = specialLabels[locale][code as keyof (typeof specialLabels)[typeof locale]];
  if (special) return special;
  const [module, action] = code.split(".");
  const moduleLabel =
    moduleLabels[locale][module as keyof (typeof moduleLabels)[typeof locale]] ?? module;
  const actionLabel =
    actionLabels[locale][action as keyof (typeof actionLabels)[typeof locale]] ?? action;
  return `${moduleLabel}: ${actionLabel}`;
}
