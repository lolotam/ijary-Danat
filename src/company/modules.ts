import type { PermissionCode } from "@/lib/permissions";

/**
 * مفاتيح أقسام الشركة التي يفتحها ويقفلها المشرف العام (`company_modules.module_key`).
 *
 * Mirrors data-model.md `company_modules`; once the company_modules migration
 * lands, its check constraint must name the same keys.
 */
export const MODULE_KEYS = [
  "invoices",
  "tenants",
  "properties",
  "units",
  "contracts",
  "payments",
  "deposits",
  "expenses",
  "electricity",
  "maintenance",
  "employees",
  "inbox",
  "reports",
  "audit",
  "online_payments",
  "whatsapp",
  "landing_page",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

/**
 * الحالة الافتراضية لكل قسم عند إنشاء شركة: كلها مفعّلة عدا `landing_page` و`maintenance`.
 *
 * Mirrors spec.md ("A new company starts with every section on except landing
 * page and maintenance") and data-model.md's `company_modules` seeding row. In
 * particular `landing_page` is off for every company until US13 (FR-027), and
 * this map is the default the code reads until the `company_modules` setting
 * exists — a missing row then reads as off, exactly like this.
 */
export const DEFAULT_MODULE_ENABLED: Record<ModuleKey, boolean> = {
  invoices: true,
  tenants: true,
  properties: true,
  units: true,
  contracts: true,
  payments: true,
  deposits: true,
  expenses: true,
  electricity: true,
  maintenance: false,
  employees: true,
  inbox: true,
  reports: true,
  audit: true,
  online_payments: true,
  whatsapp: true,
  landing_page: false,
};

/**
 * خريطة رمز الصلاحية → القسم الذي يفتحه ويقفله.
 *
 * كل رمز في الكتالوج إمّا يتبع قسماً (وهنا) أو لا يتبع قسماً أبداً
 * (`ALWAYS_ON_PERMISSIONS`)، ولا رمز في الاثنين معاً: قسمٌ مقفلٌ يمنع صلاحياته
 * كلها، وصلاحيةٌ دائمةٌ لا يمنعها إلا دور صاحبها.
 *
 * The grouping follows the admin panel's own sections, so a code sits with the
 * screen it guards: `buildings` under properties (buildings have no section of
 * their own), `insurance` under contracts (it is a contract field), `refunds`,
 * `partial_payments` and `receipts` under payments (all three are money in),
 * `salaries` under employees, and `payment_links` under online payments (a
 * payment link is the online-payment request).
 *
 * The map is written per code, not per permission module, because a module and
 * a section do not always line up: SQL's `landing_page` module is also a
 * section key, yet its codes stay always-on until US13 (FR-027).
 */
const PERMISSION_SECTION_BY_CODE = {
  // invoices — الفواتير
  "invoices.create": "invoices",
  "invoices.read": "invoices",
  "invoices.update": "invoices",
  "invoices.delete": "invoices",
  "invoices.export": "invoices",
  "invoices.write_off": "invoices",
  "invoices.dispute": "invoices",

  // tenants — المستأجرون
  "tenants.create": "tenants",
  "tenants.read": "tenants",
  "tenants.update": "tenants",
  "tenants.delete": "tenants",
  "tenants.export": "tenants",

  // properties — العقارات (والمباني معها: لا قسم للمباني وحدها)
  "properties.create": "properties",
  "properties.read": "properties",
  "properties.update": "properties",
  "properties.delete": "properties",
  "properties.export": "properties",
  "buildings.create": "properties",
  "buildings.read": "properties",
  "buildings.update": "properties",
  "buildings.delete": "properties",
  "buildings.export": "properties",

  // units — الوحدات
  "units.create": "units",
  "units.read": "units",
  "units.update": "units",
  "units.delete": "units",
  "units.export": "units",

  // contracts — العقود (والتأمين معها: التأمين حقلٌ في العقد)
  "contracts.create": "contracts",
  "contracts.read": "contracts",
  "contracts.update": "contracts",
  "contracts.delete": "contracts",
  "contracts.export": "contracts",
  "contracts.close_out": "contracts",
  "contracts.restore": "contracts",
  "insurance.create": "contracts",
  "insurance.read": "contracts",
  "insurance.update": "contracts",
  "insurance.delete": "contracts",
  "insurance.export": "contracts",

  // payments — المدفوعات (والمستردات والدفعات الجزئية والإيصالات معها: كلّها مالٌ داخل)
  "payments.create": "payments",
  "payments.read": "payments",
  "payments.update": "payments",
  "payments.delete": "payments",
  "payments.export": "payments",
  "payments.reverse": "payments",
  "refunds.create": "payments",
  "refunds.read": "payments",
  "refunds.update": "payments",
  "refunds.delete": "payments",
  "refunds.export": "payments",
  "refunds.reverse": "payments",
  "refunds.void": "payments",
  "partial_payments.create": "payments",
  "partial_payments.read": "payments",
  "partial_payments.update": "payments",
  "partial_payments.delete": "payments",
  "partial_payments.export": "payments",
  "receipts.create": "payments",
  "receipts.read": "payments",
  "receipts.update": "payments",
  "receipts.delete": "payments",
  "receipts.export": "payments",

  // deposits — الودائع
  "deposits.create": "deposits",
  "deposits.read": "deposits",
  "deposits.update": "deposits",
  "deposits.delete": "deposits",
  "deposits.export": "deposits",

  // expenses — المصروفات
  "expenses.create": "expenses",
  "expenses.read": "expenses",
  "expenses.update": "expenses",
  "expenses.delete": "expenses",
  "expenses.export": "expenses",
  "expenses.categories": "expenses",

  // electricity — الكهرباء
  "electricity.create": "electricity",
  "electricity.read": "electricity",
  "electricity.update": "electricity",
  "electricity.delete": "electricity",
  "electricity.export": "electricity",
  "electricity.tariffs": "electricity",

  // maintenance — الصيانة
  "maintenance.create": "maintenance",
  "maintenance.read": "maintenance",
  "maintenance.update": "maintenance",
  "maintenance.delete": "maintenance",
  "maintenance.export": "maintenance",

  // employees — الموظفون (والرواتب معهم: لا قسم للرواتب وحدها)
  "employees.create": "employees",
  "employees.read": "employees",
  "employees.update": "employees",
  "employees.delete": "employees",
  "employees.export": "employees",
  "salaries.create": "employees",
  "salaries.read": "employees",
  "salaries.update": "employees",
  "salaries.delete": "employees",
  "salaries.export": "employees",

  // inbox — صندوق الوارد
  "inbox.manage": "inbox",

  // reports — التقارير
  "reports.create": "reports",
  "reports.read": "reports",
  "reports.update": "reports",
  "reports.delete": "reports",
  "reports.export": "reports",

  // audit — سجل التدقيق
  "audit.create": "audit",
  "audit.read": "audit",
  "audit.update": "audit",
  "audit.delete": "audit",
  "audit.export": "audit",

  // online_payments — المدفوعات الإلكترونية (روابط الدفع: طلبُ الدفع الإلكتروني)
  "payment_links.create": "online_payments",
  "payment_links.read": "online_payments",
  "payment_links.update": "online_payments",
  "payment_links.delete": "online_payments",
  "payment_links.export": "online_payments",
} as const satisfies Partial<Record<PermissionCode, ModuleKey>>;

/**
 * خريطة الصلاحيات إلى الأقسام، كما يستهلكها التطبيق.
 *
 * مفاتيحها رموز الصلاحيات المربوطة بقسم، وقيمها مفاتيح الأقسام؛ ورمزٌ ليس
 * فيها فهو رمزٌ دائم، فراجع `ALWAYS_ON_PERMISSIONS`.
 *
 * These two maps are the source the later `has_permission` migration (T107)
 * mirrors in SQL: a code whose section is off returns false, and an always-on
 * code never consults a section. Keep the two in step when a permission is
 * added.
 */
export const PERMISSION_SECTION: Readonly<Partial<Record<PermissionCode, ModuleKey>>> =
  PERMISSION_SECTION_BY_CODE;

/**
 * الرموز التي لا تتبع قسماً: صلاحيةٌ لا يحملها قسم، فقفلُ قسمٍ لا يمنعها.
 *
 * كلٌّ منها إما أساسُ الشركة نفسها (المستخدمون والأدوار والإعدادات وسير العمل)
 * أو مخرجاتٌ على أكثر من قسم:
 *
 * - `settings.integrations` يفتح وصلة Gmail (قسم `inbox`) واتصال واتساب
 *   (قسم `whatsapp`) معاً، فقفلُ قسمٍ واحدٍ لا يجوز أن يفسد الآخر.
 * - `notifications.*` يخدم كل الأقسام (فواتير، دفعات، عقود)، ومهمة
 *   `notification.dispatch` في كتالوج الوظائف بلا قسم.
 * - `portal.*` يخصّ بوابة المستأجر، وهي تطبيقٌ منفصل عن لوحة الشركة.
 * - `landing_page.*` يخصّ صفحة المجمع، وهي مقفلة افتراضياً لكل شركة (FR-027)
 *   حتى القصة الثالثة عشرة (US13)؛ لو تبع القسمَ لَاختفى تبويب طلبات التأجير
 *   من صندوق الوارد لكل شركة اليوم، وهو تبويبٌ حيٌّ لا يتأثّر بإغلاق القسم.
 */
const ALWAYS_ON_PERMISSION_CODES = [
  // الشركة نفسها وبياناتها الأساسية
  "company.create",
  "company.read",
  "company.update",
  "company.delete",
  "company.export",

  // الموظفون وأدوارهم
  "users.create",
  "users.read",
  "users.update",
  "users.delete",
  "users.export",
  "users.assign_tenants",

  // الإشعارات: تخدم كل الأقسام
  "notifications.create",
  "notifications.read",
  "notifications.update",
  "notifications.delete",
  "notifications.export",
  "notifications.send",

  // بوابة المستأجر: تطبيق منفصل
  "portal.create",
  "portal.read",
  "portal.update",
  "portal.delete",
  "portal.export",
  "portal.enable",
  "portal.tab_dashboard",
  "portal.tab_lease",
  "portal.tab_invoices",
  "portal.tab_payments",
  "portal.tab_profile",
  "portal.tab_shop",

  // الإعدادات وسير العمل
  "settings.integrations",
  "settings.lists",
  "settings.backup",
  "workflows.manage",

  // صفحة المجمع
  "landing_page.read",
  "landing_page.update",
  "landing_page.leasing_read",
  "landing_page.leasing_update",
] as const satisfies readonly Exclude<PermissionCode, keyof typeof PERMISSION_SECTION_BY_CODE>[];

/**
 * الرموز الدائمة: صلاحيةٌ لا يمنعها إلا دور صاحبها، لا قسمٌ.
 *
 * A code listed here belongs to no section, so switching a section off never
 * revokes it.
 */
export const ALWAYS_ON_PERMISSIONS: ReadonlySet<PermissionCode> = new Set(
  ALWAYS_ON_PERMISSION_CODES,
);

/**
 * الأقسام التي لا تملك رموز صلاحيات خاصة بها.
 *
 * القسم بلا رمزٍ يُقفل بمفتاحه وحده: يختفي من القائمة، وتُرفض صفحته، وتُخطّى
 * مهامّه — لا صلاحيةَ تسقط معه، فليس هناك رمزٌ يحمله.
 *
 * - `whatsapp`: الوصلةُ تُدار بـ`settings.integrations` (مشتركة مع Gmail)،
 *   والرسائلُ تُرسل بـ`notifications.send` (مشتركة مع البريد) — فلا رمزَ خاصاً
 *   بالقسم، وإلا صار إلغاءُ Gmail إلغاءً واتساب.
 * - `landing_page`: رموزُها (`landing_page.*`) تخصّ الصفحة وطلبات التأجير التي
 *   تُعرض في صندوق الوارد؛ الصفحة مقفلة افتراضياً لكل شركة حتى US13 (FR-027)،
 *   ولو تبعَت الرموزُ القسمَ لاختفى تبويب طلبات التأجير من صندوق الوارد لكل
 *   شركة اليوم.
 */
export const PERMISSION_LESS_SECTIONS: ReadonlySet<ModuleKey> = new Set<ModuleKey>([
  "whatsapp",
  "landing_page",
]);

/**
 * رمزُ صلاحيةٍ واحد لا بد أن يكون في الخريطة أو في قائمة الدائمة.
 *
 * The check below is the compiler's half of the contract: a permission code
 * added to `src/lib/permissions.ts` and then forgotten here fails `typecheck`
 * instead of silently becoming always-on.
 */
type PermissionCodeMissingFromBothMaps = Exclude<
  PermissionCode,
  keyof typeof PERMISSION_SECTION_BY_CODE | (typeof ALWAYS_ON_PERMISSION_CODES)[number]
>;

/** يفشل typecheck ما دام هناك رمزٌ واحدٌ خارج الخريطة والقائمة الدائمة. */
type AssertEveryCodeIsAccountedFor<T extends never> = T;
type _EveryPermissionCodeIsAccountedFor =
  AssertEveryCodeIsAccountedFor<PermissionCodeMissingFromBothMaps>;

/**
 * يرجع القسم الذي ينتمي إليه رمز الصلاحية، أو `null` إن كان رمزاً دائماً.
 *
 * A pure lookup over `PERMISSION_SECTION`; the SQL mirror of that map (T107)
 * has to answer the same question the same way.
 */
export function sectionOfPermission(code: PermissionCode): ModuleKey | null {
  return PERMISSION_SECTION[code] ?? null;
}
