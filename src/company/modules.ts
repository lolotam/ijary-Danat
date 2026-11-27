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
