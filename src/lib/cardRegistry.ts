import type { ModuleKey } from "@/company/modules";

/** الصفحات التي تحمل صفّ بطاقات مؤشرات قابلًا للإخفاء. */
export type CardPage =
  | "dashboard"
  | "tenants"
  | "units"
  | "contracts"
  | "payments"
  | "deposits"
  | "expenses"
  | "portal";

export interface CardDefinition {
  /** Stored in `card_visibility.card_id`. Never renumber or reuse an id. */
  id: string;
  page: CardPage;
  /** i18n key for the label shown in Settings › Cards control. */
  labelKey: string;
  /** Section that must be enabled for this card to appear; omitted for always-on cards. */
  module?: ModuleKey;
}

/**
 * السجلّ الوحيد لبطاقات المؤشرات: شاشة الإعدادات ترسم منه، والصفحات تحجب منه.
 *
 * One list, two consumers. If the settings screen and the pages each kept their
 * own list, a card could be listed in settings and never gated on its page —
 * which is this codebase's recurring defect shape: configuration that is
 * written and never read.
 *
 * The `labelKey` reuses each page's existing `summary.*` string where one
 * exists. The dashboard's nine cards build their labels inline from `locale`
 * rather than through `t()`, so they get dedicated keys here; the dashboard's
 * own rendering is deliberately left alone.
 */
export const CARD_REGISTRY: readonly CardDefinition[] = [
  {
    id: "dashboard.outstanding",
    page: "dashboard",
    labelKey: "settings.cards.dashboard.outstanding",
    module: "invoices",
  },
  {
    id: "dashboard.paymentsThisMonth",
    page: "dashboard",
    labelKey: "settings.cards.dashboard.paymentsThisMonth",
    module: "payments",
  },
  {
    id: "dashboard.overdue",
    page: "dashboard",
    labelKey: "settings.cards.dashboard.overdue",
    module: "invoices",
  },
  {
    id: "dashboard.collected",
    page: "dashboard",
    labelKey: "settings.cards.dashboard.collected",
    module: "invoices",
  },
  {
    id: "dashboard.employees",
    page: "dashboard",
    labelKey: "settings.cards.dashboard.employees",
    module: "employees",
  },
  {
    id: "dashboard.salaries",
    page: "dashboard",
    labelKey: "settings.cards.dashboard.salaries",
    module: "employees",
  },
  {
    id: "dashboard.properties",
    page: "dashboard",
    labelKey: "settings.cards.dashboard.properties",
    module: "properties",
  },
  {
    id: "dashboard.units",
    page: "dashboard",
    labelKey: "settings.cards.dashboard.units",
    module: "units",
  },
  {
    id: "dashboard.tenants",
    page: "dashboard",
    labelKey: "settings.cards.dashboard.tenants",
    module: "tenants",
  },

  { id: "tenants.total", page: "tenants", labelKey: "summary.tenants.total", module: "tenants" },
  { id: "tenants.active", page: "tenants", labelKey: "summary.tenants.active", module: "tenants" },
  {
    id: "tenants.arrears",
    page: "tenants",
    labelKey: "summary.tenants.arrears",
    module: "tenants",
  },
  {
    id: "tenants.blocked",
    page: "tenants",
    labelKey: "summary.tenants.blocked",
    module: "tenants",
  },

  { id: "units.total", page: "units", labelKey: "summary.units.total", module: "units" },
  { id: "units.occupied", page: "units", labelKey: "summary.units.occupied", module: "units" },
  { id: "units.vacant", page: "units", labelKey: "summary.units.vacant", module: "units" },
  {
    id: "units.maintenance",
    page: "units",
    labelKey: "summary.units.maintenance",
    module: "units",
  },
  {
    id: "units.rentPotential",
    page: "units",
    labelKey: "summary.units.rentPotential",
    module: "units",
  },

  {
    id: "contracts.total",
    page: "contracts",
    labelKey: "summary.contracts.total",
    module: "contracts",
  },
  {
    id: "contracts.active",
    page: "contracts",
    labelKey: "summary.contracts.active",
    module: "contracts",
  },
  {
    id: "contracts.expiring60",
    page: "contracts",
    labelKey: "summary.contracts.expiring60",
    module: "contracts",
  },
  {
    id: "contracts.ended",
    page: "contracts",
    labelKey: "summary.contracts.ended",
    module: "contracts",
  },
  {
    id: "contracts.annualValue",
    page: "contracts",
    labelKey: "summary.contracts.annualValue",
    module: "contracts",
  },

  { id: "payments.full", page: "payments", labelKey: "summary.payments.full", module: "payments" },
  {
    id: "payments.partial",
    page: "payments",
    labelKey: "summary.payments.partial",
    module: "payments",
  },
  {
    id: "payments.insurance",
    page: "payments",
    labelKey: "summary.payments.insurance",
    module: "payments",
  },
  {
    id: "payments.refunds",
    page: "payments",
    labelKey: "summary.payments.refunds",
    module: "payments",
  },
  { id: "payments.net", page: "payments", labelKey: "summary.payments.net", module: "payments" },

  {
    id: "deposits.total",
    page: "deposits",
    labelKey: "summary.deposits.total",
    module: "deposits",
  },
  {
    id: "deposits.confirmed",
    page: "deposits",
    labelKey: "summary.deposits.confirmed",
    module: "deposits",
  },
  {
    id: "deposits.pending",
    page: "deposits",
    labelKey: "summary.deposits.pending",
    module: "deposits",
  },
  {
    id: "deposits.thisMonth",
    page: "deposits",
    labelKey: "summary.deposits.thisMonth",
    module: "deposits",
  },

  {
    id: "expenses.total",
    page: "expenses",
    labelKey: "summary.expenses.total",
    module: "expenses",
  },
  {
    id: "expenses.approved",
    page: "expenses",
    labelKey: "summary.expenses.approved",
    module: "expenses",
  },
  {
    id: "expenses.pending",
    page: "expenses",
    labelKey: "summary.expenses.pending",
    module: "expenses",
  },
  {
    id: "expenses.thisMonth",
    page: "expenses",
    labelKey: "summary.expenses.thisMonth",
    module: "expenses",
  },

  {
    id: "portal.reminderPopup",
    page: "portal",
    labelKey: "settings.cards.portal.reminderPopup",
  },
  {
    id: "portal.messageCompose",
    page: "portal",
    labelKey: "settings.cards.portal.messageCompose",
  },
  {
    id: "portal.leaseConcessions",
    page: "portal",
    labelKey: "settings.cards.portal.leaseConcessions",
  },
  { id: "portal.insurance", page: "portal", labelKey: "settings.cards.portal.insurance" },
  { id: "portal.nextDue", page: "portal", labelKey: "settings.cards.portal.nextDue" },
  {
    id: "portal.overdueInvoices",
    page: "portal",
    labelKey: "settings.cards.portal.overdueInvoices",
  },
  { id: "portal.totalOverdue", page: "portal", labelKey: "settings.cards.portal.totalOverdue" },
] as const;

/** ترتيب الصفحات في شاشة الإعدادات، ومفتاح عنوان كل مجموعة. */
export const CARD_PAGE_LABEL_KEYS: Record<CardPage, string> = {
  dashboard: "admin.dashboard",
  tenants: "admin.tenants",
  units: "admin.units",
  contracts: "admin.contracts",
  payments: "admin.payments",
  deposits: "admin.deposits",
  expenses: "admin.expenses",
  portal: "settings.cards.portal",
};

/**
 * يتحقق مما إذا كانت البطاقة مفعّلة وفق حالة قسمها في الشركة.
 */
export function isCardModuleEnabled(
  card: CardDefinition,
  isModuleEnabled: (key: ModuleKey) => boolean,
): boolean {
  return !card.module || isModuleEnabled(card.module);
}

/**
 * يجمع بطاقات السجلّ حسب الصفحة مع الحفاظ على ترتيب ظهورها في الواجهة وتصفية الأقسام المعطّلة.
 *
 * Grouping lives here rather than in the settings screen because the page order
 * is a property of the registry, and a screen that grouped independently could
 * silently drop a page the registry knows about.
 */
export function cardsByPage(
  isModuleEnabled?: (key: ModuleKey) => boolean,
): Array<{ page: CardPage; cards: CardDefinition[] }> {
  const order: CardPage[] = Object.keys(CARD_PAGE_LABEL_KEYS) as CardPage[];
  return order
    .map((page) => ({
      page,
      cards: CARD_REGISTRY.filter(
        (card) =>
          card.page === page && (!isModuleEnabled || isCardModuleEnabled(card, isModuleEnabled)),
      ),
    }))
    .filter((group) => group.cards.length > 0);
}
