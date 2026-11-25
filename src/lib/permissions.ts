export const PERMISSION_MODULES = [
  "tenants",
  "contracts",
  "invoices",
  "payments",
  "deposits",
  "expenses",
  "electricity",
  "maintenance",
  "reports",
  "notifications",
  "properties",
  "buildings",
  "units",
  "company",
  "users",
  "audit",
  "portal",
  "payment_links",
  "receipts",
  // T13 — Payment and Refund
  "refunds",
  "partial_payments",
  "insurance",
  // T14a — HR
  "employees",
  "salaries",
] as const;

export const BASE_PERMISSION_ACTIONS = ["create", "read", "update", "delete", "export"] as const;

export const SPECIAL_PERMISSION_CODES = [
  "payments.reverse",
  "portal.enable",
  "notifications.send",
  "users.assign_tenants",
  // Per-tab visibility for the tenant portal. These stay under the `portal`
  // module rather than a module of their own: PERMISSION_MODULES is expanded
  // against BASE_PERMISSION_ACTIONS below, so a `portal_tabs` module would
  // invent five meaningless codes (portal_tabs.create, .delete, …). Keeping
  // the `portal.` prefix also means the roles screen groups and renders them
  // with no changes — it splits on the first dot.
  "portal.tab_dashboard",
  "portal.tab_lease",
  "portal.tab_invoices",
  "portal.tab_payments",
  "portal.tab_profile",
  "portal.tab_shop",
  // Contract close-out and related money corrections. Same special-code
  // pattern as portal.tab_*: a new `closeouts` module would invent meaningless
  // BASE_PERMISSION_ACTIONS (closeouts.export, closeouts.delete, …). Seeded
  // in db/migrations/83_closeout_permissions.sql — keep both in sync.
  "contracts.close_out",
  "contracts.restore",
  "refunds.reverse",
  "refunds.void",
  "invoices.write_off",
  "invoices.dispute",
  // Features that were admin-only before migration 230. Special codes for the
  // same reason as above; seeded in db/migrations/230_admin_feature_permissions.sql.
  // landing_page.* were seeded by migration 19 but never listed here, so every
  // grant was silently dropped by usePermissions().
  "settings.integrations",
  "settings.lists",
  "settings.backup",
  "workflows.manage",
  "electricity.tariffs",
  "expenses.categories",
  "inbox.manage",
  "landing_page.read",
  "landing_page.update",
  "landing_page.leasing_read",
  "landing_page.leasing_update",
] as const;

type PermissionModule = (typeof PERMISSION_MODULES)[number];
type BasePermissionAction = (typeof BASE_PERMISSION_ACTIONS)[number];
type BasePermissionCode = `${PermissionModule}.${BasePermissionAction}`;
type SpecialPermissionCode = (typeof SPECIAL_PERMISSION_CODES)[number];

export type PermissionCode = BasePermissionCode | SpecialPermissionCode;

export const PERMISSION_CODES: readonly PermissionCode[] = [
  ...PERMISSION_MODULES.flatMap((module) =>
    BASE_PERMISSION_ACTIONS.map((action) => `${module}.${action}` as BasePermissionCode),
  ),
  ...SPECIAL_PERMISSION_CODES,
];

export const PERMISSIONS = {
  AUDIT_READ: "audit.read",
  BUILDINGS_CREATE: "buildings.create",
  BUILDINGS_DELETE: "buildings.delete",
  BUILDINGS_EXPORT: "buildings.export",
  BUILDINGS_READ: "buildings.read",
  BUILDINGS_UPDATE: "buildings.update",
  COMPANY_UPDATE: "company.update",
  CONTRACTS_CLOSE_OUT: "contracts.close_out",
  CONTRACTS_CREATE: "contracts.create",
  CONTRACTS_DELETE: "contracts.delete",
  CONTRACTS_EXPORT: "contracts.export",
  CONTRACTS_READ: "contracts.read",
  CONTRACTS_RESTORE: "contracts.restore",
  CONTRACTS_UPDATE: "contracts.update",
  DEPOSITS_CREATE: "deposits.create",
  DEPOSITS_DELETE: "deposits.delete",
  DEPOSITS_EXPORT: "deposits.export",
  DEPOSITS_READ: "deposits.read",
  DEPOSITS_UPDATE: "deposits.update",
  EXPENSES_CATEGORIES: "expenses.categories",
  EXPENSES_CREATE: "expenses.create",
  EXPENSES_DELETE: "expenses.delete",
  EXPENSES_EXPORT: "expenses.export",
  EXPENSES_READ: "expenses.read",
  EXPENSES_UPDATE: "expenses.update",
  ELECTRICITY_CREATE: "electricity.create",
  ELECTRICITY_DELETE: "electricity.delete",
  ELECTRICITY_EXPORT: "electricity.export",
  ELECTRICITY_READ: "electricity.read",
  ELECTRICITY_TARIFFS: "electricity.tariffs",
  ELECTRICITY_UPDATE: "electricity.update",
  INBOX_MANAGE: "inbox.manage",
  INVOICES_CREATE: "invoices.create",
  INVOICES_DELETE: "invoices.delete",
  INVOICES_DISPUTE: "invoices.dispute",
  INVOICES_EXPORT: "invoices.export",
  INVOICES_READ: "invoices.read",
  INVOICES_UPDATE: "invoices.update",
  INVOICES_WRITE_OFF: "invoices.write_off",
  LANDING_PAGE_LEASING_READ: "landing_page.leasing_read",
  LANDING_PAGE_LEASING_UPDATE: "landing_page.leasing_update",
  LANDING_PAGE_READ: "landing_page.read",
  LANDING_PAGE_UPDATE: "landing_page.update",
  MAINTENANCE_CREATE: "maintenance.create",
  MAINTENANCE_DELETE: "maintenance.delete",
  MAINTENANCE_EXPORT: "maintenance.export",
  MAINTENANCE_READ: "maintenance.read",
  MAINTENANCE_UPDATE: "maintenance.update",
  NOTIFICATIONS_CREATE: "notifications.create",
  NOTIFICATIONS_DELETE: "notifications.delete",
  NOTIFICATIONS_EXPORT: "notifications.export",
  NOTIFICATIONS_READ: "notifications.read",
  NOTIFICATIONS_SEND: "notifications.send",
  NOTIFICATIONS_UPDATE: "notifications.update",
  PAYMENTS_CREATE: "payments.create",
  EMPLOYEES_CREATE: "employees.create",
  EMPLOYEES_READ: "employees.read",
  EMPLOYEES_UPDATE: "employees.update",
  EMPLOYEES_DELETE: "employees.delete",
  SALARIES_CREATE: "salaries.create",
  SALARIES_READ: "salaries.read",
  SALARIES_UPDATE: "salaries.update",
  SALARIES_DELETE: "salaries.delete",
  REFUNDS_CREATE: "refunds.create",
  REFUNDS_DELETE: "refunds.delete",
  REFUNDS_READ: "refunds.read",
  REFUNDS_REVERSE: "refunds.reverse",
  REFUNDS_VOID: "refunds.void",
  PARTIAL_PAYMENTS_CREATE: "partial_payments.create",
  PARTIAL_PAYMENTS_READ: "partial_payments.read",
  PARTIAL_PAYMENTS_UPDATE: "partial_payments.update",
  PARTIAL_PAYMENTS_DELETE: "partial_payments.delete",
  INSURANCE_CREATE: "insurance.create",
  INSURANCE_READ: "insurance.read",
  INSURANCE_UPDATE: "insurance.update",
  INSURANCE_DELETE: "insurance.delete",
  PAYMENTS_DELETE: "payments.delete",
  PAYMENTS_EXPORT: "payments.export",
  PAYMENTS_READ: "payments.read",
  PAYMENTS_REVERSE: "payments.reverse",
  PAYMENTS_UPDATE: "payments.update",
  PROPERTIES_CREATE: "properties.create",
  PROPERTIES_DELETE: "properties.delete",
  PROPERTIES_EXPORT: "properties.export",
  PROPERTIES_READ: "properties.read",
  PROPERTIES_UPDATE: "properties.update",
  RECEIPTS_CREATE: "receipts.create",
  RECEIPTS_DELETE: "receipts.delete",
  RECEIPTS_EXPORT: "receipts.export",
  RECEIPTS_READ: "receipts.read",
  RECEIPTS_UPDATE: "receipts.update",
  REPORTS_CREATE: "reports.create",
  REPORTS_DELETE: "reports.delete",
  REPORTS_EXPORT: "reports.export",
  REPORTS_READ: "reports.read",
  REPORTS_UPDATE: "reports.update",
  SETTINGS_BACKUP: "settings.backup",
  SETTINGS_INTEGRATIONS: "settings.integrations",
  SETTINGS_LISTS: "settings.lists",
  TENANTS_CREATE: "tenants.create",
  TENANTS_DELETE: "tenants.delete",
  TENANTS_EXPORT: "tenants.export",
  TENANTS_READ: "tenants.read",
  TENANTS_UPDATE: "tenants.update",
  UNITS_CREATE: "units.create",
  UNITS_DELETE: "units.delete",
  UNITS_EXPORT: "units.export",
  UNITS_READ: "units.read",
  UNITS_UPDATE: "units.update",
  USERS_ASSIGN_TENANTS: "users.assign_tenants",
  USERS_CREATE: "users.create",
  USERS_DELETE: "users.delete",
  USERS_READ: "users.read",
  USERS_UPDATE: "users.update",
  WORKFLOWS_MANAGE: "workflows.manage",
} as const satisfies Record<string, PermissionCode>;

const permissionCodeSet = new Set<string>(PERMISSION_CODES);

export function isPermissionCode(value: string): value is PermissionCode {
  return permissionCodeSet.has(value);
}
