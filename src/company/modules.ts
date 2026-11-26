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
